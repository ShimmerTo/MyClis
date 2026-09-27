import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { SshConfigAction, SshControlApi, SshSnapshot } from '../../packages/ssh/src/contracts'

interface SshUiState {
  approvalId?: string
  challengeId?: string
  terminalId?: string
  /** 待办清单弹窗：由右侧栏的待办入口打开，打开任何单项时自动收起 */
  queueOpen?: boolean
}
export interface SshToast { id: number; kind: 'success' | 'error' | 'info'; message: string }
interface StoreState {
  snapshot: SshSnapshot | null
  loading: boolean
  loadError: string
  notices: { id: number; message: string }[]
  toasts: SshToast[]
  ui: SshUiState
}
let state: StoreState = { snapshot: null, loading: true, loadError: '', notices: [], toasts: [], ui: {} }
const listeners = new Set<() => void>()
let unsubscribe: (() => void) | undefined
let generation = 0
let noticeId = 0
let toastId = 0

function publish(patch: Partial<StoreState>): void {
  state = { ...state, ...patch }
  listeners.forEach((listener) => listener())
}

/** 只调用可信宿主的 SSH 接口，不走 bridge 或本地终端。 */
export function sshApi(): SshControlApi {
  if (!window.clichilds?.ssh) throw new Error('SSH_UNAVAILABLE')
  return window.clichilds.ssh
}

/** 错误信息使用受控文案，避免 IPC 原始异常包含认证材料。 */
export function sshError(error: unknown): string {
  const messages: Record<string, string> = {
    SSH_UNAVAILABLE: 'SSH 服务还没起来，应用其它功能照常。',
    REVISION_CONFLICT: '设置在这期间被别处改过了。请重新载入，再核对一遍你要存的内容。',
    CONFLICT: '设置或申请的状态变了，请刷新后再看。',
    AUTH_REQUIRED: '需要输入密码或私钥口令：自己连的服务器在 SSH 页面卡片里输，后台发起的在会话卡片的 SSH 待办图标或右侧栏待办入口里输。',
    HOST_KEY_REQUIRED: '需要确认这台服务器的指纹，在会话卡片的 SSH 待办图标或右侧栏待办入口里处理。',
    HOST_KEY_CHANGED: '服务器指纹跟之前记录的不一样，请先通过别的可靠渠道核实。',
    APPROVAL_EXPIRED: '批准已经过期，请回到 CLI 让 AI 重新提一次。',
    RESULT_EXPIRED: '结果内容没保存或已经过期。这不代表命令没在服务器上执行。',
    POLICY_CHANGED: '权限改了，原来那条申请不能继续跑。',
    FORBIDDEN: '这个项目没被允许，或者这条申请已经失效。',
    SKILL_DISABLED: 'SSH 功能开关是关的，你自己连服务器、开终端还是可以用。',
    BUSY: 'SSH 现在比较忙，稍后再手动试一次刚才没提交出去的操作。',
    INVALID_PARAMS: '填写的内容不符合要求，请检查上面的表单。',
    UNSUPPORTED: '这台服务器或者这种登录方式不支持这个操作。',
    SAVE_FAILED: '设置没保存上；这次收紧已经生效，但重启可能回到旧设置。请先排查为什么存不下去。',
    CONFIG_CORRUPT: 'SSH 配置文件坏了，SSH 已停用。请到用户数据目录检查这个文件。',
    SKILL_SYNC_FAILED: '开关保存了，但给 AI 的说明文件没写进去。请检查命令重名或目录权限后重试。',
    CONNECTION_FAILED: '连不上，请检查地址、端口和登录方式。',
    CONNECTING: '正在连接，稍等再看状态。',
    INVALID_DECISION: '这次点击已经失效了：要么用过，要么跟原来的申请对不上。',
    NOT_FOUND: '对应的连接、终端或申请已经不在了，请刷新状态。',
    TIMED_OUT: '等不到结果了，远端可能还在跑。请先去确认，不要直接重发。',
    AUDIT_FAILED: 'SSH 记录写不进去，请检查用户数据目录是否可写。'
  }
  let code = ''
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') code = error.code
  if (!code && error instanceof Error) {
    code = Object.keys(messages).find((key) => new RegExp(`\\b${key}\\b`).test(error.message)) ?? ''
  }
  return messages[code] ?? 'SSH 操作失败。请检查连接、权限或服务状态；不会自动重试执行。'
}

/** 快照仅接受严格递增序号，防止初始化或并发保存的旧响应覆盖新事件。 */
export function adoptSshSnapshot(snapshot: SshSnapshot): void {
  if (state.snapshot && snapshot.seq <= state.snapshot.seq) return
  publish({ snapshot, loading: false })
}

/** 手动刷新状态，不连接服务器或重放请求。 */
export async function refreshSsh(): Promise<void> {
  const currentGeneration = generation
  try {
    // 首次订阅失败后，用户重新加载也必须先恢复事件通道。
    if (!unsubscribe && listeners.size > 0) unsubscribe = sshApi().onChanged(adoptSshSnapshot)
    const snapshot = await sshApi().getSnapshot()
    if (currentGeneration !== generation) return
    adoptSshSnapshot(snapshot)
    publish({ loading: false, loadError: '' })
  } catch (error: unknown) {
    if (currentGeneration === generation) publish({ loading: false, loadError: sshError(error) })
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (!unsubscribe) {
    generation += 1
    try {
      // 必须先订阅，再取初始化快照。
      unsubscribe = sshApi().onChanged(adoptSshSnapshot)
      void refreshSsh()
    } catch (error: unknown) {
      publish({ loading: false, loadError: sshError(error) })
    }
  }
  return () => {
    listeners.delete(listener)
    // StrictMode 的同步重挂载保留订阅；真正离开后才释放。
    queueMicrotask(() => {
      if (listeners.size !== 0) return
      generation += 1
      unsubscribe?.()
      unsubscribe = undefined
    })
  }
}

/** SSH 独立状态缓存；加载失败不会抛出到主应用。 */
export function useSshStore(): StoreState {
  return useSyncExternalStore(subscribe, () => state)
}

/** 按显式表单版本提交单个动作，不合并其它草稿或乐观授权。 */
export async function saveSshAction(action: SshConfigAction, expectedRevision: number): Promise<void> {
  adoptSshSnapshot(await sshApi().updateConfig({ expectedRevision, action }))
}

/** 全局交互面由唯一宿主持有；页面只能请求打开，不执行决定。 */
export function setSshUi(patch: Partial<SshUiState>): void {
  const opening = patch.approvalId || patch.challengeId || patch.terminalId
  publish({ ui: opening ? { ...patch } : { ...state.ui, ...patch } })
}

/** 后台终端错误保留在全局入口，不打印远端正文或密码。 */
export function reportSshError(message: string): void {
  if (state.notices.some((notice) => notice.message === message)) return
  publish({ notices: [...state.notices.slice(-7), { id: ++noticeId, message }] })
}

/** 清除用户已经阅读的操作提示；不清除服务持久化错误。 */
export function dismissSshNotice(id: number): void {
  publish({ notices: state.notices.filter((notice) => notice.id !== id) })
}

/** 右上角短时提示：连接测试结果等，成功/失败各自停留更久一点，到点自动消失。 */
export function pushSshToast(kind: SshToast['kind'], message: string): void {
  const id = ++toastId
  publish({ toasts: [...state.toasts.slice(-3), { id, kind, message }] })
  window.setTimeout(() => { dismissSshToast(id) }, kind === 'success' ? 5000 : 9000)
}

export function dismissSshToast(id: number): void {
  if (!state.toasts.some((toast) => toast.id === id)) return
  publish({ toasts: state.toasts.filter((toast) => toast.id !== id) })
}

/** 防双击的局部操作状态；异步结果不写入已经卸载的组件。 */
export function useSshAction() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const locked = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const run = useCallback(async (operation: () => Promise<void>, message = ''): Promise<boolean> => {
    if (locked.current) return false
    locked.current = true
    setBusy(true)
    setError('')
    setSuccess('')
    try {
      await operation()
      if (mounted.current) setSuccess(message)
      return true
    } catch (cause: unknown) {
      if (mounted.current) setError(sshError(cause))
      else reportSshError(sshError(cause))
      await refreshSsh()
      return false
    } finally {
      locked.current = false
      if (mounted.current) setBusy(false)
    }
  }, [])
  return { busy, error, success, run }
}

/** 宿主负责目录到通用 scope 的映射；绝不自行猜测项目身份。 */
export function useSshScope(workDir?: string) {
  const [value, setValue] = useState<{ workDir: string; scopeId: string; label: string } | null>(null)
  const [failure, setFailure] = useState<{ workDir: string; message: string } | null>(null)
  useEffect(() => {
    let alive = true
    if (!workDir) return
    void (async () => {
      try {
        const scope = await window.clichilds.sshResolveScope(workDir)
        if (alive) { setValue({ ...scope, workDir }); setFailure(null) }
      } catch (error: unknown) {
        if (alive) setFailure({ workDir, message: sshError(error) })
      }
    })()
    return () => { alive = false }
  }, [workDir])
  return {
    scope: value?.workDir === workDir ? value : null,
    error: failure && failure.workDir === workDir ? failure.message : '',
    loading: !!workDir && value?.workDir !== workDir && failure?.workDir !== workDir
  }
}

export interface SshScopeInfo { scopeId: string; label: string }
const resolvedScopeCache = new Map<string, SshScopeInfo>()

/** 批量解析多个工作目录到 scope：值为 undefined 表示还在解析、null 表示该目录认不出。 */
export function useSshScopes(dirs: string[]): { scopes: Map<string, SshScopeInfo | null>; loading: boolean } {
  const key = dirs.join('\n')
  const [result, setResult] = useState<{ key: string; scopes: Map<string, SshScopeInfo | null>; loading: boolean }>(
    () => ({ key, scopes: new Map(), loading: dirs.length > 0 })
  )
  useEffect(() => {
    const list = key ? key.split('\n') : []
    const cached = new Map<string, SshScopeInfo | null>()
    list.forEach((dir) => { const hit = resolvedScopeCache.get(dir); if (hit) cached.set(dir, hit) })
    setResult({ key, scopes: cached, loading: cached.size < list.length })
    let alive = true
    const pending = list.filter((dir) => !resolvedScopeCache.has(dir))
    if (!pending.length) return
    void (async () => {
      const settled = await Promise.allSettled(pending.map(async (dir) => ({ dir, scope: await window.clichilds.sshResolveScope(dir) })))
      if (!alive) return
      settled.forEach((item) => { if (item.status === 'fulfilled') resolvedScopeCache.set(item.value.dir, item.value.scope) })
      const next = new Map<string, SshScopeInfo | null>()
      list.forEach((dir) => { const hit = resolvedScopeCache.get(dir); if (hit) next.set(dir, hit); else next.set(dir, null) })
      setResult({ key, scopes: next, loading: false })
    })()
    return () => { alive = false }
  }, [key])
  return result.key === key ? result : { scopes: new Map<string, SshScopeInfo | null>(), loading: !!key }
}
