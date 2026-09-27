import { useState } from 'react'
import type { SshGrant, SshProfile, SshReadResources, SshTemplateDefinition } from '../../packages/ssh/src/contracts'
import { saveSshAction, useSshAction } from './store'
import { ActionFeedback } from './ui'

/** 命令分组在界面上的中文标题；分组代码来自模板 ID 前缀。 */
const groupTitles: Record<string, string> = {
  system: '系统与硬件', process: '进程', disk: '磁盘', network: '网络', fs: '文件和目录', service: 'systemd 服务', nginx: 'Nginx', docker: 'Docker 容器', git: 'Git 仓库'
}
function groupTitle(group: string): string {
  return groupTitles[group] ?? group
}
function validate(resources: SshReadResources, catalog: SshTemplateDefinition[]): string {
  if (resources.templates.some((template) => !catalog.some((item) => item.id === template.id && item.version === template.version))) return '有命令已经下线或换了版本，请先去掉旧的那几项，再重新勾选。'
  return ''
}

/** 只读权限编辑器：界面只暴露中文命令名，模板 ID 与版本由代码维护。 */
export function SshResourcesEditor({ grant, profile, scopeId, catalog, revision, disabled }: {
  grant: SshGrant; profile: SshProfile; scopeId: string; catalog: SshTemplateDefinition[]; revision: number; disabled: boolean
}): JSX.Element {
  const [draft, setDraft] = useState<SshReadResources>(() => ({ templates: grant.templates }))
  const [baseRevision, setBaseRevision] = useState(revision)
  const [baseGrantRevision, setBaseGrantRevision] = useState(grant.revision)
  const [validation, setValidation] = useState('')
  const action = useSshAction()
  const groups = [...new Set(catalog.map((template) => template.group))]
  const stale = baseGrantRevision !== grant.revision
  function patch(value: Partial<SshReadResources>): void { setDraft((current) => ({ ...current, ...value })) }
  function choose(template: SshTemplateDefinition, checked: boolean): void {
    patch({ templates: [...draft.templates.filter((item) => item.id !== template.id), ...(checked ? [{ id: template.id, version: template.version }] : [])] })
  }
  function save(): void {
    const resources: SshReadResources = { templates: draft.templates }
    const error = validate(resources, catalog)
    setValidation(error)
    if (error) return
    void action.run(async () => {
      await saveSshAction({ type: 'setReadResources', scopeId, connectionId: profile.id, resources }, baseRevision)
    }, '只读权限已保存。')
  }
  function reload(): void {
    setDraft({ templates: grant.templates })
    setBaseRevision(revision); setBaseGrantRevision(grant.revision); setValidation('')
  }
  return <div className="ssh-resources">
    <h4>AI 不用逐条问你的只读命令</h4><p className="ssh-muted">新建授权默认勾选全部只读命令；这里的改动按「保存」才会生效，以后新出的命令不会自动加进来。文件读取（含 Nginx 配置和日志）及 Git 查询均按绝对路径访问，不限制目录，仍受 SSH 登录账号权限约束。服务名和容器名不用提前登记，AI 直接写在命令参数里。</p>
    <p className="ssh-warning">勾选读文件后，AI 可以直接读取 SSH 登录账号有权读取的任何文件，不限制目录，也不逐条询问。日志和文件可能包含密码、密钥等敏感信息，内容会交给主 CLI 和模型，不会自动脱敏。</p>
    {stale && <p className="ssh-warning">这份授权在别处已经被改过了，手上的草稿不能直接盖掉新版本。请先点「取消」丢掉草稿再核对一遍。</p>}
    <fieldset disabled={disabled || action.busy || stale}>
      {!catalog.length && <p>服务还没给出可勾选的命令列表；这种情况下只能保存成「一条都不给」。</p>}
      {groups.map((group) => <div className="ssh-template-group" key={group}><h5>{groupTitle(group)}</h5><div className="ssh-actions">
        <button type="button" onClick={() => patch({ templates: [...draft.templates.filter((item) => !catalog.some((template) => template.group === group && template.id === item.id)), ...catalog.filter((template) => template.group === group).map(({ id, version }) => ({ id, version }))] })}>这一组全选</button>
        <button type="button" onClick={() => patch({ templates: draft.templates.filter((item) => !catalog.some((template) => template.group === group && template.id === item.id)) })}>这一组全不选</button>
      </div>{catalog.filter((template) => template.group === group).map((template) => <label className="ssh-template-choice" key={`${template.id}:${template.version}`}>
        <input type="checkbox" checked={draft.templates.some((item) => item.id === template.id && item.version === template.version)} onChange={(event) => choose(template, event.target.checked)} />
        <span><strong>{template.label}</strong><small>{template.description}</small></span>
      </label>)}</div>)}
      {draft.templates.filter((item) => !catalog.some((template) => template.id === item.id && template.version === item.version)).map((item) => <p key={`${item.id}:${item.version}`} className="ssh-warning">之前授权的「{catalog.find((template) => template.id === item.id)?.label ?? item.id}」（{item.id} 第 {item.version} 版）已经不能用了 <button type="button" onClick={() => patch({ templates: draft.templates.filter((template) => template !== item) })}>去掉这条</button></p>)}
    </fieldset>
    {validation && <p className="ssh-error" role="alert">{validation}</p>}<ActionFeedback {...action} />
    <div className="ssh-actions"><button type="button" disabled={action.busy} onClick={reload}>取消</button><button className="primary" type="button" disabled={disabled || stale || action.busy} onClick={save}>保存</button></div>
  </div>
}
