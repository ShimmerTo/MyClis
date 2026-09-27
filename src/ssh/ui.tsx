import type { ReactNode } from 'react'
import type { SshAuth, SshConnectionState, SshProfile, SshRequestKey, SshRequestState, SshUiRequest } from '../../packages/ssh/src/contracts'
import { refreshSsh, useSshStore } from './store'

/** 拼出「名字 · 用户@主机:端口」，备注只跟在名字后面，不参与身份判断。 */
export function sshTarget(profile: SshProfile): string {
  const note = profile.environment ? `（${profile.environment}）` : ''
  return `${profile.name}${note} · ${profile.username}@${profile.host}:${profile.port}`
}

/** 登录方式的用户可见叫法：界面上只提供密码和私钥文件两种。 */
export function authKindLabel(auth: SshAuth): string {
  if (auth.kind === 'key') return '私钥文件'
  if (auth.kind === 'agent') return 'SSH Agent'
  return '密码'
}

/** 请求键同时包含会话与请求 ID，避免不同会话串批。 */
export function sshRequestKey(request: SshRequestKey): string {
  return JSON.stringify([request.sessionId, request.requestId])
}

/** 连接状态的中文叫法，直接显示在服务器卡片上。 */
export const connectionLabels: Record<SshConnectionState, string> = {
  connecting: '正在连接…',
  auth_required: '等待输入密码或口令',
  host_key_required: '等待确认服务器指纹',
  connected: '已连接',
  failed: '连接失败',
  disconnected: '已断开'
}

/** 等待凭据时按实际要的东西说人话：密码、私钥口令还是主机指纹。 */
export function runtimeLabel(state: SshConnectionState, challengeKind?: SshAuth['kind'] | 'password' | 'passphrase' | 'host_key'): string {
  if (state !== 'auth_required') return connectionLabels[state]
  if (challengeKind === 'passphrase') return '等待输入私钥口令'
  if (challengeKind === 'host_key') return '等待确认服务器指纹'
  return '等待输入登录密码'
}

/** 执行状态；「结果未知」和「失败」必须分开，不能替用户下结论。 */
export const requestLabels: Record<SshRequestState, string> = {
  pending_approval: '等你批准',
  ready: '已批准，准备发送',
  executing: '正在执行',
  succeeded: '执行成功',
  failed: '执行失败',
  timed_out: '超时，结果需要确认',
  unknown: '结果未知',
  rejected: '你已拒绝',
  expired: '已过期',
  cancelled: '已取消（命令未发出）'
}

/** 命令是怎么拿到执行许可的：模板、你批的一次、还是项目里设了不再询问。 */
export function authorizationLabel(request: Pick<SshUiRequest, 'authorizationSource'>): string {
  switch (request.authorizationSource) {
    case 'template': return '属于你批准的只读命令'
    case 'approval': return '你批准了这一条'
    case 'policy': return '按项目设置，不用再问'
    default: return '还没有批准'
  }
}

/** 局部表单字段，复用应用主题而不依赖 SSH 后端。 */
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }): JSX.Element {
  return <label className="ssh-field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>
}

/** 操作成功/失败只来自真实响应，不乐观显示授权。 */
export function ActionFeedback({ error, success }: { error?: string; success?: string }): JSX.Element {
  return <>{error && <p className="ssh-error" role="alert">{error}</p>}{success && <p className="ssh-success" role="status">{success}</p>}</>
}

/** 加载或持久化失败持续可见；不阻止主应用其它功能。 */
export function SshStoreNotice(): JSX.Element {
  const { loading, loadError, snapshot } = useSshStore()
  return <>
    {loading && <p className="ssh-muted">正在读取 SSH 状态…</p>}
    {loadError && <div className="ssh-error" role="alert">{loadError} <button type="button" onClick={() => { void refreshSsh() }}>重新读取</button></div>}
    {snapshot?.error && <div className="ssh-error" role="alert"><strong>SSH 服务报错：{snapshot.error.code}</strong><p>{snapshot.error.message}</p><p>上面的报错说明设置可能没写进去，重启后可能回到旧配置。请先排查，再重新确认一遍。</p><button type="button" onClick={() => { void refreshSsh() }}>刷新状态</button></div>}
  </>
}
