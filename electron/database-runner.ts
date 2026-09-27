import { fork } from 'node:child_process'
import { createServer, type Socket } from 'node:net'
import { join } from 'node:path'
import type { ClientChannel } from 'ssh2'
import type { SshService } from '../packages/ssh/src'
import type { DbResult } from '../packages/database/src/contracts'
import type { RunInput } from '../packages/database/src'
import type { DriverJob } from '../packages/database/src/drivers'
import { DbError, fail } from '../packages/database/src/errors'

async function sshReady(ssh: SshService, connectionId: string, scopeId: string | undefined, signal: AbortSignal): Promise<string> {
  if (signal.aborted) fail('CANCELLED')
  const connection = await ssh.connect({ connectionId, scopeId })
  return new Promise((resolve, reject) => {
    let done = false
    const finish = (error?: Error) => {
      if (done) return
      done = true; clearTimeout(timer); off(); signal.removeEventListener('abort', abort)
      if (error) reject(error); else resolve(connection.id)
    }
    const inspect = (snapshot: Awaited<ReturnType<SshService['getSnapshot']>>) => {
      const runtime = snapshot.connections.find(c => c.id === connection.id)
      if (!runtime || ['failed', 'disconnected'].includes(runtime.state)) finish(new DbError('CONNECTION_FAILED'))
      else if (runtime.state === 'connected') finish()
    }
    const abort = () => finish(new DbError('CANCELLED'))
    const timer = setTimeout(() => finish(new DbError('SSH_REQUIRED')), 130000)
    const off = ssh.onChanged(inspect)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    else void ssh.getSnapshot().then(inspect, () => finish(new DbError('SSH_REQUIRED')))
  })
}

async function tunnel(ssh: SshService, input: RunInput): Promise<{ host: string; port: number; close: () => void }> {
  const runtimeId = await sshReady(ssh, input.profile.sshConnectionId!, input.scopeId, input.signal)
  const sockets = new Set<Socket>(), channels = new Set<ClientChannel>()
  const controller = new AbortController()
  let accepting = true
  const server = createServer(socket => {
    if (!accepting || sockets.size >= 4 || input.signal.aborted) { socket.destroy(); return }
    sockets.add(socket)
    socket.on('error', () => socket.destroy())
    socket.once('close', () => sockets.delete(socket))
    void ssh.forward(runtimeId, input.profile.host, input.profile.port, controller.signal).then(channel => {
      if (socket.destroyed || controller.signal.aborted) { channel.destroy(); return }
      channels.add(channel)
      channel.once('close', () => { channels.delete(channel); socket.destroy() })
      socket.once('close', () => channel.destroy())
      socket.pipe(channel); channel.pipe(socket)
    }).catch(() => socket.destroy())
  })
  const close = () => {
    accepting = false; controller.abort()
    for (const socket of sockets) socket.destroy()
    for (const channel of channels) channel.destroy()
    server.close()
    input.signal.removeEventListener('abort', close)
  }
  server.on('error', close)
  input.signal.addEventListener('abort', close, { once: true })
  try {
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        server.off('error', failed); server.off('close', closed); server.off('listening', listening)
        input.signal.removeEventListener('abort', aborted)
        if (error) reject(error); else resolve()
      }
      const failed = (error: Error) => finish(error)
      const closed = () => finish(new DbError('CONNECTION_FAILED'))
      const aborted = () => finish(new DbError('CANCELLED'))
      const listening = () => finish()
      server.once('error', failed); server.once('close', closed); server.once('listening', listening)
      input.signal.addEventListener('abort', aborted, { once: true })
      if (input.signal.aborted) aborted()
      else server.listen(0, '127.0.0.1')
    })
    if (input.signal.aborted) fail('CANCELLED')
    const address = server.address()
    if (!address || typeof address === 'string') fail('CONNECTION_FAILED')
    return { host: '127.0.0.1', port: address.port, close }
  } catch (cause) { close(); throw cause }
}

export function createDatabaseRunner(ssh: SshService): (input: RunInput) => Promise<DbResult> {
  let running = 0
  return async input => {
    if (running >= 8) fail('BUSY')
    if (input.signal.aborted) fail('CANCELLED')
    running++
    let bridge: Awaited<ReturnType<typeof tunnel>> | undefined
    try {
      if (input.profile.sshConnectionId) bridge = await tunnel(ssh, input)
      if (input.signal.aborted) fail('CANCELLED')
      return await new Promise<DbResult>((resolve, reject) => {
        const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
        for (const key of Object.keys(env)) if (/^MYCLIS_.*(?:TOKEN|SESSION)|^MYCLIS_BRIDGE_URL$/i.test(key)) delete env[key]
        const child = fork(join(__dirname, 'database-worker.js'), [], { env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [] })
        let done = false
        const finish = (error?: Error, result?: DbResult) => {
          if (done) return
          done = true; clearTimeout(timer); input.signal.removeEventListener('abort', abort)
          child.kill()
          if (error) reject(error); else resolve(result!)
        }
        const abort = () => finish(new DbError('UNKNOWN'))
        const timer = setTimeout(() => finish(new DbError('TIMED_OUT')), 45000)
        child.once('error', () => finish(new DbError('CONNECTION_FAILED')))
        child.once('exit', () => finish(new DbError('UNKNOWN')))
        child.once('message', (message: { ok: boolean; result?: DbResult }) => {
          if (message.ok && message.result) finish(undefined, message.result)
          else finish(new DbError('QUERY_FAILED'))
        })
        input.signal.addEventListener('abort', abort, { once: true })
        try {
          if (input.signal.aborted) fail('CANCELLED')
          input.dispatch()
          const job: DriverJob = { profile: input.profile, ...(bridge ? { endpoint: { host: bridge.host, port: bridge.port } } : {}), sql: input.sql, params: input.params, readOnly: input.readOnly }
          child.send(job, error => { if (error) finish(new DbError('CONNECTION_FAILED')) })
        } catch (cause) { finish(cause instanceof Error ? cause : new DbError('INTERNAL')) }
      })
    } finally { bridge?.close(); running-- }
  }
}
