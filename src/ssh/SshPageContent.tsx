import { useState } from 'react'
import { ErrorBoundary } from '../components/ErrorBoundary'
import { ModalFrame } from '../components/approval'
import { useSettings } from '../store'
import { SshConnections } from './Connections'
import { useSshScope, useSshScopes, useSshStore } from './store'
import { SshStoreNotice } from './ui'
import './ssh.css'

/** SSH 内容页，由宿主提供菜单和 AppShell；不自动连接或请求授权。 */
export function SshPageContent({ workDir }: { workDir?: string }): JSX.Element {
  const { cfg, loadError: settingsError } = useSettings()
  const { snapshot, loadError } = useSshStore()
  const dirs = [...new Set([...(cfg?.workDirs ?? []), ...(workDir ? [workDir] : [])])].filter(Boolean)
  const { scopes } = useSshScopes(dirs)
  return <div className="ssh-ui ssh-page">
    <SshStoreNotice />
    {settingsError && <p className="ssh-error" role="alert">工作目录列表读取失败：SSH 连接本身照常可用，但下面勾不了项目。</p>}
    {snapshot && <>
      {loadError && <p className="ssh-warning">状态没同步上，下面显示的是最后一次拿到的信息，请刷新后再操作。</p>}
      <SshConnections snapshot={snapshot} dirs={dirs} scopes={scopes} />
    </>}
  </div>
}

/** 工作台状态入口：始终可打开，持续显示当前项目全部已启用免审批数。 */
export function SshStatusTrigger({ workDir }: { workDir: string }): JSX.Element {
  const { snapshot, loadError } = useSshStore()
  const { scope, error } = useSshScope(workDir)
  const [open, setOpen] = useState(false)
  const access = snapshot?.config.scopes.find((item) => item.scopeId === scope?.scopeId)
  const grants = access?.grants ?? []
  const allowCount = grants.filter((grant) => grant.enabled && grant.commandPolicy === 'allow').length
  const runtimes = snapshot?.connections.filter((connection) => connection.scopeId === scope?.scopeId && !!scope) ?? []
  const connected = runtimes.filter((runtime) => runtime.state === 'connected').length
  const unresolved = runtimes.find((runtime) => ['host_key_required', 'auth_required', 'connecting', 'failed'].includes(runtime.state))
  const pending = snapshot?.requests.filter((request) => request.scopeId === scope?.scopeId && request.state === 'pending_approval').length ?? 0
  const running = snapshot?.requests.filter((request) => request.scopeId === scope?.scopeId && ['ready', 'executing'].includes(request.state)).length ?? 0
  const status = loadError || error || snapshot?.error ? '有报错' : connected ? `已连接 ${connected}` : unresolved ? '等待处理' : '未连接'
  return <>
    <button className={`ssh-status-trigger ${allowCount ? 'ssh-warning' : ''}`} type="button" onClick={() => setOpen(true)} title={`${workDir}\nSSH ${connected}/${grants.length}（已连接/已关联） · ${status} · 等你批准 ${pending} 条 · 正在执行 ${running} 条`}>
      SSH {connected}/{grants.length}{allowCount > 0 && <strong> · 不再询问 {allowCount}</strong>}
    </button>
    {open && <ModalFrame title="SSH" className="ssh-manager-modal" onClose={() => setOpen(false)}><ErrorBoundary label="SSH 面板"><SshPageContent workDir={workDir} /></ErrorBoundary></ModalFrame>}
  </>
}
