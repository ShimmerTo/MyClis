import { dialog, ipcMain } from 'electron'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { getDataDirectory } from './config/dataDirectory'
import { createHash } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createSshService } from '../packages/ssh/src'
import type { SshConfigUpdate, SshControlApi } from '../shared/ssh'
import { CH } from '../shared/types'

const ERROR_MESSAGES: Record<string, string> = {
  INVALID_PARAMS: 'SSH 参数不合法，请检查填写内容',
  UNAUTHORIZED: 'SSH 会话身份已失效',
  FORBIDDEN: '没有此 SSH 操作的访问权限',
  CONFLICT: '配置或请求已变化，请刷新后重试',
  REVISION_CONFLICT: 'SSH 配置已被更新，请刷新后重试',
  SKILL_DISABLED: 'SSH Skill 已关闭',
  AUTH_REQUIRED: '请在 SSH 待处理事项中完成认证',
  HOST_KEY_REQUIRED: '请在 SSH 待处理事项中核对主机指纹',
  HOST_KEY_CHANGED: '主机指纹已变化，请核对服务器身份',
  POLICY_CHANGED: '授权或连接身份已变化，原申请已失效',
  APPROVAL_EXPIRED: '执行申请已过期，请重新明确申请',
  RESULT_EXPIRED: '执行详情已过期，不代表命令未执行',
  NOT_FOUND: 'SSH 连接或请求已不存在',
  BUSY: 'SSH 操作已达到并发上限，请稍后重试',
  UNSUPPORTED: '当前服务器或认证方式不支持此操作',
  CONNECTING: 'SSH 正在连接，请稍后查看状态',
  CONNECTION_FAILED: 'SSH 连接失败，请检查目标和认证方式',
  INVALID_DECISION: '该确认已失效、已使用或与原申请不一致',
  TIMED_OUT: '操作超时，远端结果可能未知，请先核实',
  AUDIT_FAILED: 'SSH 审计保存失败，请检查用户数据目录',
  SAVE_FAILED: 'SSH 设置未保存；本次收紧仍生效，重启可能恢复旧设置，请重试',
  CONFIG_CORRUPT: 'SSH 配置损坏，已禁用 SSH，请检查用户数据目录',
  SKILL_SYNC_FAILED: 'SSH 开关已保存，但 Skill 文件同步失败，请检查命令重名或目录权限',
  SSH_OPERATION_FAILED: 'SSH 操作失败，请检查连接、授权和当前状态'
}

function operationError(error: unknown): Error {
  const candidate = error && typeof error === 'object' && 'code' in error ? error.code : undefined
  const code = typeof candidate === 'string' && Object.hasOwn(ERROR_MESSAGES, candidate)
    ? candidate
    : 'SSH_OPERATION_FAILED'
  console.error('SSH 操作失败', code)
  return new Error(`[${code}] ${ERROR_MESSAGES[code]}`)
}

export function resolveSshScope(workDir: string): { scopeId: string; label: string } {
  if (typeof workDir !== 'string' || workDir.length > 32768 || !isAbsolute(workDir)) {
    throw new Error('请选择有效的绝对工作目录')
  }
  let label: string
  try {
    label = realpathSync.native(workDir)
    if (!statSync(label).isDirectory()) throw new Error('not-directory')
  } catch {
    throw new Error('工作目录不存在或不可访问')
  }
  const identity = label.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return { scopeId: createHash('sha256').update(identity).digest('hex'), label }
}

export function registerSsh(
  getWin: () => BrowserWindow | null,
  onSkillChange: () => Promise<void>
) {
  const service = createSshService({ dataDir: getDataDirectory() })
  const channels: string[] = []
  const resolvedScopes = new Map<string, string>()
  const sessionScopes = new Map<string, string>()
  let disposed = false

  const trustedUrl = (url: string): boolean => {
    const devUrl = process.env.ELECTRON_RENDERER_URL
    if (devUrl) {
      try {
        return new URL(url).origin === new URL(devUrl).origin
      } catch {
        return false
      }
    }
    return url.split(/[?#]/)[0] === pathToFileURL(join(__dirname, '../renderer/index.html')).href
  }
  const trusted = (event: IpcMainInvokeEvent): boolean => {
    const win = getWin()
    return !!win && !win.isDestroyed() && event.sender === win.webContents
      && event.senderFrame === win.webContents.mainFrame && trustedUrl(event.senderFrame.url)
  }

  const handle = <T, R>(channel: string, action: (payload: T) => R | Promise<R>): void => {
    channels.push(channel)
    ipcMain.handle(channel, async (event, payload: T) => {
      if (disposed || !trusted(event)) throw new Error('不允许从此窗口调用 SSH 操作')
      try {
        return await action(payload)
      } catch (error) {
        throw operationError(error)
      }
    })
  }

  const send = (channel: string, payload: unknown): void => {
    const win = getWin()
    if (!disposed && win && !win.isDestroyed() && trustedUrl(win.webContents.mainFrame.url)) {
      win.webContents.send(channel, payload)
    }
  }
  const off = [
    service.onChanged((snapshot) => send(CH.sshChanged, snapshot)),
    service.onTerminalData((event) => send(CH.sshTerminalData, event)),
    service.onTerminalExit((event) => send(CH.sshTerminalExit, event))
  ]

  handle(CH.sshGetSnapshot, () => service.getSnapshot())
  handle(CH.sshUpdateConfig, async (update: SshConfigUpdate) => {
    if (update?.action?.type === 'setAccess') {
      const action = update.action
      const label = resolvedScopes.get(action.scopeId)
        ?? (await service.getSnapshot()).config.scopes.find((s) => s.scopeId === action.scopeId)?.label
      if (!label) throw Object.assign(new Error(), { code: 'INVALID_PARAMS' })
      update = { ...update, action: { ...action, scopeLabel: label } }
    }
    const result = await service.updateConfig(update)
    if (update.action.type === 'setSkillEnabled') {
      try {
        await onSkillChange()
      } catch {
        throw Object.assign(new Error(), { code: 'SKILL_SYNC_FAILED' })
      }
    }
    return result
  })
  handle(CH.sshConnect, (request: Parameters<SshControlApi['connect']>[0]) => service.connect(request))
  handle(CH.sshDisconnect, (id: string) => service.disconnect(id))
  handle(CH.sshAuthRespond, (input: Parameters<SshControlApi['authRespond']>[0]) => service.authRespond(input))
  handle(CH.sshTrustHostKey, (input: Parameters<SshControlApi['trustHostKey']>[0]) => service.trustHostKey(input))
  handle(CH.sshTerminalOpen, (id: string) => service.terminalOpen(id))
  handle(CH.sshTerminalClose, (id: string) => service.terminalClose(id))
  handle(CH.sshTerminalWrite, (input: Parameters<SshControlApi['terminalWrite']>[0]) => service.terminalWrite(input))
  handle(CH.sshTerminalResize, (input: Parameters<SshControlApi['terminalResize']>[0]) => service.terminalResize(input))
  handle(CH.sshTerminalAttach, (id: string) => service.terminalAttach(id))
  handle(CH.sshTerminalDetach, (id: string) => service.terminalDetach(id))
  handle(CH.sshRequestInspect, (input: Parameters<SshControlApi['requestInspect']>[0]) => service.requestInspect(input))
  handle(CH.sshRequestDecide, (input: Parameters<SshControlApi['requestDecide']>[0]) => service.requestDecide(input))
  handle(CH.sshRequestCancel, (input: Parameters<SshControlApi['requestCancel']>[0]) => service.requestCancel(input))
  handle(CH.sshResolveScope, (workDir: string) => {
    const scope = resolveSshScope(workDir)
    resolvedScopes.set(scope.scopeId, scope.label)
    return scope
  })
  handle(CH.sshPickIdentity, async () => {
    const win = getWin()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      title: '选择 SSH 私钥文件',
      properties: ['openFile']
    })
    return result.canceled ? null : result.filePaths[0] ?? null
  })

  return {
    service,
    async skillEnabled(): Promise<boolean> {
      const snapshot = await service.getSnapshot()
      return snapshot.config.skillEnabled && !snapshot.error
    },
    createMainEnv(sessionId: string, workDir: string, label: string, bridgeUrl: string) {
      const scope = resolveSshScope(workDir)
      resolvedScopes.set(scope.scopeId, scope.label)
      const { token } = service.createSession({ sessionId, scopeId: scope.scopeId, scopeLabel: scope.label, label })
      sessionScopes.set(sessionId, scope.scopeId)
      return { MYCLIS_SSH_TOKEN: token, MYCLIS_SSH_SESSION: sessionId, MYCLIS_BRIDGE_URL: bridgeUrl }
    },
    revokeMain(sessionId: string): void {
      service.revokeSession(sessionId)
      sessionScopes.delete(sessionId)
    },
    async revokeRemovedProjects(previous: string[], next: string[]): Promise<void> {
      const pathKey = (path: string): string => {
        let canonical = path
        try { canonical = realpathSync.native(path) } catch { /* 已删除目录仍按原绝对路径撤销。 */ }
        return canonical.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
      }
      const kept = new Set(next.map(pathKey))
      const removed = new Set(previous.map(pathKey).filter(path => !kept.has(path)))
      if (!removed.size) return
      const scopeIds = new Set([...removed].map(path => createHash('sha256').update(path).digest('hex')))
      for (const [sessionId, scopeId] of sessionScopes) {
        if (!scopeIds.has(scopeId)) continue
        service.revokeSession(sessionId)
        sessionScopes.delete(sessionId)
      }
      const snapshot = await service.getSnapshot()
      let failure: unknown
      for (const scope of snapshot.config.scopes.filter(scope => scopeIds.has(scope.scopeId))) {
        for (const grant of scope.grants.filter(grant => grant.enabled)) {
          try {
            const current = await service.getSnapshot()
            await service.updateConfig({ expectedRevision: current.config.revision, action: {
              type: 'setAccess', scopeId: scope.scopeId, scopeLabel: scope.label,
              connectionId: grant.connectionId, enabled: false
            } })
          } catch (error) { failure ??= error }
        }
      }
      if (failure) throw operationError(failure)
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      off.forEach((unsubscribe) => unsubscribe())
      service.dispose()
      channels.forEach((channel) => ipcMain.removeHandler(channel))
      resolvedScopes.clear()
      sessionScopes.clear()
    }
  }
}
