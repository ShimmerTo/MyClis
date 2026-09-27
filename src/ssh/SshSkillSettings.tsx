import { useState } from 'react'
import { ModalFrame } from '../components/approval'
import { saveSshAction, useSshAction, useSshStore } from './store'
import { ActionFeedback, SshStoreNotice, sshTarget } from './ui'
import './ssh.css'

/** 命令页唯一 SSH Skill 开关；不向 AppConfig 保存第二份状态。 */
export function SshSkillSettings(): JSX.Element {
  const { snapshot, loadError } = useSshStore()
  const [confirmation, setConfirmation] = useState<{ enabled: boolean; revision: number }>()
  const [accepted, setAccepted] = useState(false)
  const action = useSshAction()
  const allows = snapshot?.config.scopes.flatMap((scope) => scope.grants.filter((grant) => grant.enabled && grant.commandPolicy === 'allow').map((grant) => ({ scope, profile: snapshot.config.connections.find((profile) => profile.id === grant.connectionId) }))) ?? []
  return <section className="ssh-ui ssh-section">
    <h3>告诉 AI 你有 SSH 功能 · /myclis-ssh</h3>
    <SshStoreNotice />
    <p>打开以后，主 CLI 才会知道可以走 MyClis 连服务器，也会读到一份用法说明。这个开关本身不会连上任何服务器，也不会给某个项目开通权限——哪个项目能用哪台机器、能看哪些目录、命令要不要逐条问你，都在 SSH 页面单独设置。</p>
    {snapshot && <>
      <p>现在的状态：<strong>{snapshot.config.skillEnabled ? '已开启' : '已关闭'}</strong></p>
      <button type="button" disabled={action.busy || !!loadError || (!!snapshot.error && !snapshot.config.skillEnabled)} onClick={() => { setAccepted(false); setConfirmation({ enabled: !snapshot.config.skillEnabled, revision: snapshot.config.revision }) }}>{snapshot.config.skillEnabled ? '关闭…' : '开启…'}</button>
      <p className="ssh-muted">已经开着的旧主会话可能还记着旧的说明，但服务每次都会按当前开关现场判定。想让它立刻读到，就新建一个主会话。</p>
    </>}
    <ActionFeedback {...action} />
    {confirmation && snapshot && <ModalFrame title={confirmation.enabled ? '确认开启' : '确认关闭'} onClose={() => setConfirmation(undefined)}><div className="ssh-ui">
      {confirmation.enabled ? <>
        <p>开启后会照原样恢复各项目之前保存的服务器使用权和只读命令，不会恢复已经作废的申请，也不会自动连服务器或执行命令。</p>
        {allows.length ? <><p className="ssh-warning">下面这些项目设了「不再询问」，开启后会重新生效：该项目里所有主会话都能执行任意命令，包括危险命令，「只读目录」的限制对它们不起作用。</p><ul>{allows.map(({ scope, profile }, index) => <li key={`${scope.scopeId}:${profile?.id ?? index}`}>{scope.label} → {profile ? sshTarget(profile) : '对应的服务器已被删除，请先去 SSH 页面检查'}</li>)}</ul></> : <p>目前没有「不再询问」的项目设置。</p>}
      </> : <p className="ssh-warning">关闭后，AI 新提的 SSH 请求会立刻被拒绝，还没执行的批准同时作废。已经在跑的命令不会被撤回，也不会被杀掉。各项目的权限设置都留着，你自己开的终端不受影响，下次开启会原样恢复。</p>}
      <label className="ssh-check"><input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} />上面的影响我已经看过了</label>
      {snapshot.config.revision !== confirmation.revision && <p className="ssh-error">中间配置被改过，请先关掉这个弹窗，重新看一遍再操作。</p>}
      <ActionFeedback {...action} /><div className="ssh-actions"><button type="button" onClick={() => setConfirmation(undefined)}>取消</button><button type="button" disabled={!accepted || action.busy || snapshot.config.revision !== confirmation.revision} onClick={() => { void action.run(async () => {
        await saveSshAction({ type: 'setSkillEnabled', enabled: confirmation.enabled }, confirmation.revision)
        setConfirmation(undefined)
      }, '已保存，请以「现在的状态」为准。') }}>确认{confirmation.enabled ? '开启' : '关闭'}</button></div>
    </div></ModalFrame>}
  </section>
}
