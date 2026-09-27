import { dialog, ipcMain, safeStorage } from 'electron'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { getDataDirectory } from './config/dataDirectory'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { realpathSync } from 'node:fs'
import { createDatabaseService } from '../packages/database/src'
import type { DbConfigUpdate, DbControlApi } from '../shared/database'
import type { SshService } from '../packages/ssh/src'
import { CH } from '../shared/types'
import { createDatabaseRunner } from './database-runner'
import { resolveSshScope } from './ssh'
import { errorInfo, fail } from '../packages/database/src/errors'

export function registerDatabase(getWin: () => BrowserWindow | null, ssh: SshService, getWorkDirs: () => string[], onSkillChange: () => Promise<void>) {
  const service = createDatabaseService({
    dataDir: getDataDirectory(), run: createDatabaseRunner(ssh), secrets: {
      encrypt: value => { if (!safeStorage.isEncryptionAvailable()) fail('SECRET_UNAVAILABLE'); return safeStorage.encryptString(value).toString('base64') },
      decrypt: value => { if (!safeStorage.isEncryptionAvailable()) fail('SECRET_UNAVAILABLE'); return safeStorage.decryptString(Buffer.from(value, 'base64')) }
    }
  })
  const channels: string[] = [], sessions = new Map<string, string>()
  let disposed = false
  const trustedUrl = (url: string): boolean => {
    if (process.env.ELECTRON_RENDERER_URL) {
      try { return new URL(url).origin === new URL(process.env.ELECTRON_RENDERER_URL).origin } catch { return false }
    }
    return url.split(/[?#]/)[0] === pathToFileURL(join(__dirname, '../renderer/index.html')).href
  }
  const trusted = (event: IpcMainInvokeEvent): boolean => {
    const win = getWin()
    return !!win && !win.isDestroyed() && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame && trustedUrl(event.senderFrame.url)
  }
  const handle = <T, R>(channel: string, action: (payload: T) => R | Promise<R>) => {
    channels.push(channel)
    ipcMain.handle(channel, async (event, payload: T) => {
      if (disposed || !trusted(event)) throw new Error('不允许从此窗口调用 Database 操作')
      try { return await action(payload) } catch (cause) { const error = errorInfo(cause); throw new Error(`${error.message} (${error.code})`) }
    })
  }
  const off = service.onChanged(snapshot => {
    const win = getWin()
    if (!disposed && win && !win.isDestroyed() && trustedUrl(win.webContents.mainFrame.url)) win.webContents.send(CH.databaseChanged, snapshot)
  })
  const sshIdentities = new Map<string, string>()
  const trackSsh = (snapshot: Awaited<ReturnType<SshService['getSnapshot']>>) => {
    const next = new Map(snapshot.config.connections.map(profile => [profile.id, JSON.stringify({ ...profile, revision: undefined, hostKey: undefined })]))
    for (const [id, identity] of sshIdentities) if (next.get(id) !== identity) service.invalidateSsh(id)
    sshIdentities.clear(); for (const [id, identity] of next) sshIdentities.set(id, identity)
  }
  const offSsh = ssh.onChanged(trackSsh)
  void ssh.getSnapshot().then(trackSsh).catch(() => console.error('Database 无法读取 SSH 配置'))
  handle(CH.databaseGetSnapshot, () => service.getSnapshot())
  handle(CH.databaseUpdateConfig, async (update: DbConfigUpdate) => {
    if (update?.action?.type === 'setAccess') {
      const scopes = getWorkDirs().flatMap(dir => { try { return [resolveSshScope(dir)] } catch { return [] } })
      const scopeId = update.action.scopeId
      const scope = scopes.find(s => s.scopeId === scopeId)
      if (!scope) fail('FORBIDDEN')
      update = { ...update, action: { ...update.action, scopeLabel: scope.label } }
    }
    if (update?.action?.type === 'saveConnection' && update.action.profile?.sshConnectionId) {
      const snapshot = await ssh.getSnapshot()
      const sshId = update.action.profile.sshConnectionId
      if (!snapshot.config.connections.some(p => p.id === sshId)) fail('NOT_FOUND')
    }
    const snapshot = await service.updateConfig(update)
    if (update.action.type === 'setSkillEnabled') await onSkillChange()
    return snapshot
  })
  handle(CH.databaseTest, (id: string) => service.testConnection(id))
  handle(CH.databaseTables, (input: Parameters<DbControlApi['listTables']>[0]) => service.listTables(input))
  handle(CH.databaseTableDetail, (input: Parameters<DbControlApi['tableDetail']>[0]) => service.tableDetail(input))
  handle(CH.databaseSubmitQuery, (input: Parameters<DbControlApi['submitQuery']>[0]) => service.submitQuery(input))
  handle(CH.databaseBrowseTable, (input: Parameters<DbControlApi['browseTable']>[0]) => service.browseTable(input))
  handle(CH.databaseDeleteRows, (input: Parameters<DbControlApi['deleteRows']>[0]) => service.deleteRows(input))
  handle(CH.databaseInspect, (key: Parameters<DbControlApi['requestInspect']>[0]) => service.requestInspect(key))
  handle(CH.databaseDecide, (decision: Parameters<DbControlApi['requestDecide']>[0]) => service.requestDecide(decision))
  handle(CH.databaseCancel, (key: Parameters<DbControlApi['requestCancel']>[0]) => service.requestCancel(key))
  handle(CH.databaseResolveScope, (dir: string) => resolveSshScope(dir))
  handle(CH.databasePickFile, async () => {
    const win = getWin(); if (!win) return null
    const result = await dialog.showOpenDialog(win, { title: '选择 SQLite 数据库', properties: ['openFile'], filters: [{ name: 'SQLite', extensions: ['db', 'sqlite', 'sqlite3'] }, { name: '所有文件', extensions: ['*'] }] })
    return result.canceled ? null : result.filePaths[0] ?? null
  })
  const pathKey = (path: string) => {
    try { path = realpathSync.native(path) } catch { /* 删除目录仍按已保存路径撤销。 */ }
    return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  }
  return {
    service,
    async skillEnabled(): Promise<boolean> { const snapshot = await service.getSnapshot(); return snapshot.config.skillEnabled && !snapshot.error },
    createMainEnv(sessionId: string, workDir: string, label: string) {
      const scope = resolveSshScope(workDir)
      const { token } = service.createSession({ sessionId, scopeId: scope.scopeId, scopeLabel: scope.label, label })
      sessions.set(sessionId, scope.label)
      return { MYCLIS_DB_TOKEN: token, MYCLIS_DB_SESSION: sessionId }
    },
    revokeMain(sessionId: string) { service.revokeSession(sessionId); sessions.delete(sessionId) },
    async revokeRemovedProjects(previous: string[], next: string[]) {
      const removed = new Set(previous.map(pathKey).filter(key => !next.map(pathKey).includes(key)))
      for (const [id, label] of sessions) if (removed.has(pathKey(label))) { service.revokeSession(id); sessions.delete(id) }
      const snapshot = await service.getSnapshot()
      for (const scope of snapshot.config.scopes) if (removed.has(pathKey(scope.label))) {
        for (const connectionId of scope.connectionIds) {
          const current = await service.getSnapshot()
          await service.updateConfig({ expectedRevision: current.config.revision, action: { type: 'setAccess', connectionId, scopeId: scope.scopeId, scopeLabel: scope.label, enabled: false } })
        }
      }
    },
    dispose() { if (disposed) return; disposed = true; off(); offSsh(); service.dispose(); channels.forEach(channel => ipcMain.removeHandler(channel)); sessions.clear() }
  }
}
