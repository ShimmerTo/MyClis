import { useState } from 'react'
import type { SshGrant, SshProfile, SshSnapshot } from '../../packages/ssh/src/contracts'
import { ModalFrame } from '../components/approval'
import { saveSshAction, useSshAction } from './store'
import { SshResourcesEditor } from './Resources'
import { ActionFeedback, sshTarget } from './ui'

/** 一台服务器在本项目里的使用权：开不开、默认不默认、只读清单、其它命令怎么批。 */
export function GrantEditor({ snapshot, grant, profile, scopeId, scopeLabel }: { snapshot: SshSnapshot; grant: SshGrant; profile: SshProfile; scopeId: string; scopeLabel: string }): JSX.Element {
  const action = useSshAction()
  const [risk, setRisk] = useState<{ revision: number }>()
  const [revoking, setRevoking] = useState(false)
  const [accepted, setAccepted] = useState(false)
  const loadBlocked = !!snapshot.error
  const scope = snapshot.config.scopes.find((item) => item.scopeId === scopeId)
  function access(enabled: boolean): void {
    void action.run(async () => {
      if (enabled) await saveSshAction({ type: 'setAccess', scopeId, scopeLabel, connectionId: profile.id, enabled }, snapshot.config.revision)
      else await saveSshAction({ type: 'removeAccess', scopeId, connectionId: profile.id }, snapshot.config.revision)
    }, enabled ? 'AI 可以使用这台服务器了；除只读清单外的命令仍然每条都要问。' : '已收回使用权并取消关联。')
  }
  return <div className="ssh-grant">
    <h4>{sshTarget(profile)}</h4>
    <p>AI 使用权：<strong>{grant.enabled ? '已开启' : '未开启'}</strong> · 可直接执行的只读命令：{grant.templates.length} 项 · 其它命令：<strong className={grant.enabled && grant.commandPolicy === 'allow' ? 'ssh-warning' : ''}>{grant.enabled ? (grant.commandPolicy === 'allow' ? '不再询问（高风险）' : '每条都要我批') : '不允许执行'}</strong></p>
    <p className="ssh-muted">只有上面的「AI 使用权」开着，本项目的 AI 才能连这台服务器；光是把它加进列表还不够。</p>
    <div className="ssh-actions">
      {!grant.enabled && <button type="button" disabled={action.busy || loadBlocked} onClick={() => access(true)}>让本项目的 AI 使用这台服务器</button>}
      {grant.enabled && <button type="button" disabled={action.busy} onClick={() => setRevoking(true)}>收回并取消关联</button>}
      {scope?.defaultConnectionId !== profile.id && <button type="button" disabled={action.busy || !grant.enabled || loadBlocked} onClick={() => { void action.run(async () => { await saveSshAction({ type: 'setDefaultConnection', scopeId, connectionId: profile.id }, snapshot.config.revision) }, '已设为默认服务器。') }}>设为本项目的默认服务器</button>}
      {scope?.defaultConnectionId === profile.id && <button type="button" disabled={action.busy} onClick={() => { void action.run(async () => { await saveSshAction({ type: 'setDefaultConnection', scopeId }, snapshot.config.revision) }, '已取消默认服务器，AI 每次要自己说清楚连哪台。') }}>取消默认服务器</button>}
    </div>
    <ActionFeedback {...action} />
    {revoking && <div className="ssh-confirm">
      <p className="ssh-warning">确认收回？这个项目的 AI 将立刻用不了这台服务器：使用权收回、关联解除，还没执行的申请作废；已经在服务器上跑着的命令不会被撤回。之后可以重新开启。</p>
      <div className="ssh-actions"><button type="button" disabled={action.busy} onClick={() => setRevoking(false)}>先不收回</button><button className="danger" type="button" disabled={action.busy} onClick={() => { setRevoking(false); access(false) }}>确认收回</button></div>
    </div>}
    {grant.enabled && <>
      <div className="ssh-policy">
        <h4>其它命令怎么处理</h4>
        <p>只读文件接口可以读取这个登录账号有权读取的任何文件，不限制目录。其它命令会按这个账号的权限在服务器上执行，可能修改或删除数据，不受只读命令清单约束。</p>
        {grant.commandPolicy === 'allow' ? <><p className="ssh-warning">「不再询问」对这个项目的所有会话都有效，重启也还在。改回询问不会打断已经发出去的命令。</p><button type="button" disabled={action.busy} onClick={() => { void action.run(async () => { await saveSshAction({ type: 'setCommandPolicy', scopeId, connectionId: profile.id, policy: 'ask' }, snapshot.config.revision) }, '已改回每条都问。') }}>改回每条都问</button></> : <><p>默认每条都要你在弹出的卡片上点一次同意。</p><button type="button" disabled={action.busy || loadBlocked} onClick={() => { setAccepted(false); setRisk({ revision: snapshot.config.revision }) }}>设为不再询问（高风险）</button></>}
      </div>
      <SshResourcesEditor grant={grant} profile={profile} scopeId={scopeId} catalog={snapshot.templates} revision={snapshot.config.revision} disabled={loadBlocked || action.busy} />
    </>}
    {risk && <ModalFrame title="确认设为不再询问" onClose={() => setRisk(undefined)}><div className="ssh-ui">
      <p>项目：<strong>{scopeLabel}</strong></p><p>服务器：<strong>{sshTarget(profile)}</strong></p>
      <ul className="ssh-warning">
        <li>这个项目的全部 AI 会话都能直接执行任意命令，不再逐条问你。</li>
        <li>包括删数据、改配置、下载并运行脚本这类危险命令。</li>
        <li>只读命令和资源清单不限制任意命令，执行范围由 SSH 登录账号权限决定。</li>
        <li>这个设置长期保存，重启应用还在。</li>
        <li>要输登录密码、要确认服务器指纹、SSH 总开关和这台服务器的使用权，这些照样要过；之前过期或作废的申请不会被顺手放行。</li>
      </ul>
      <label className="ssh-check"><input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} />以上我都看过了，确认对这个项目和这台服务器不再询问</label>
      {snapshot.config.revision !== risk.revision && <p className="ssh-error">设置在你核对期间被别人改过了，请先关掉重新核对。</p>}
      <ActionFeedback {...action} /><div className="ssh-actions"><button type="button" onClick={() => setRisk(undefined)}>还是每条都问</button><button type="button" disabled={!accepted || action.busy || !grant.enabled || loadBlocked || snapshot.config.revision !== risk.revision} onClick={() => { void action.run(async () => {
        await saveSshAction({ type: 'setCommandPolicy', scopeId, connectionId: profile.id, policy: 'allow', confirmRisk: true }, risk.revision)
        setRisk(undefined)
      }, '已设为不再询问，随时可以改回每条都问。') }}>确认不再询问</button></div>
    </div></ModalFrame>}
  </div>
}
