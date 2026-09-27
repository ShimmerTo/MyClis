import { useEffect, useState } from 'react'
import type { DbHistoryRecord, DbProfile, DbSnapshot } from '@shared/database'
import type { ThemeKind } from '@shared/types'
import { ShellRail, type View } from '../components/AppShell'
import { applyTheme, saveConfig, useSettings } from '../store'
import { formatLocalDate, ModalFrame } from '../components/approval'
import { setSshUi, useSshStore } from '../ssh/store'
import { ConnectionEditor, kindLabels } from './ConnectionEditor'
import DatabaseManager from './DatabaseManager'
import { refreshDatabase, requestKey, saveDatabase, stateLabels, useDatabase, useDatabaseAction } from './store'
import './database.css'

function ConnectionCard({ profile, snapshot, projects, onEdit, onManage }: { profile: DbProfile; snapshot: DbSnapshot; projects: { scopeId: string; label: string }[]; onEdit: () => void; onManage: () => void }): JSX.Element {
  const action = useDatabaseAction(), ssh = useSshStore()
  const [deleting, setDeleting] = useState(false), [testing, setTesting] = useState(false)
  const test = snapshot.tests.find(test => test.connectionId === profile.id)
  const sshProfile = ssh.snapshot?.config.connections.find(item => item.id === profile.sshConnectionId)
  const challenges = ssh.snapshot?.challenges.filter(item => item.connectionId === profile.sshConnectionId) ?? []
  return <article className="unit-card db-card">
    <div className="unit-card-head"><b>{profile.name}</b><span className="hint">{kindLabels[profile.kind]}</span>{profile.tls && <span className="hint">TLS</span>}</div>
    <p className="path">{profile.kind === 'sqlite' ? profile.filename : `${profile.username}@${profile.host}:${profile.port} / ${profile.database}`}</p>
    <p className="hint">{profile.sshConnectionId ? `SSH · ${sshProfile?.name ?? '连接已删除，请重新配置'}` : profile.kind === 'sqlite' ? '本机文件' : '直接连接'}</p>
    <p className="hint">{profile.approvalTables.length ? `查询需批准：${profile.approvalTables.join('、')}` : 'SELECT 默认允许'} · 其他操作逐次批准</p>
    <div className="db-projects" aria-label={`${profile.name} 关联项目`}>
      {!projects.length && <span className="hint">请先在「目录」页添加工作目录。</span>}
      {projects.map(project => <label key={project.scopeId} className="db-check" title={project.label}>
        <input type="checkbox" disabled={action.busy} checked={snapshot.config.scopes.find(scope => scope.scopeId === project.scopeId)?.connectionIds.includes(profile.id) ?? false}
          onChange={event => { const enabled = event.target.checked; void action.run(() => saveDatabase({ type: 'setAccess', connectionId: profile.id, scopeId: project.scopeId, scopeLabel: project.label, enabled }, snapshot.config.revision)) }} />
        {project.label.replace(/[\\/]+$/, '').split(/[\\/]/).pop()}
      </label>)}
    </div>
    {test && <p role="status" className={test.ok ? 'db-success' : 'error'}>{test.ok ? `连接成功 · ${test.durationMs} ms` : test.error?.message ?? '连接失败'}</p>}
    {challenges.map(challenge => <button key={challenge.id} type="button" onClick={() => setSshUi({ challengeId: challenge.id })}>{challenge.kind === 'host_key' ? '确认 SSH 指纹' : '输入 SSH 密码或口令'}</button>)}
    {action.error && <p role="alert" className="error">{action.error}</p>}
    <div className="db-actions"><button className="primary" disabled={action.busy} onClick={onManage}>管理面板</button><button disabled={action.busy} onClick={() => { setTesting(true); void action.run(async () => { await window.clichilds.database.testConnection(profile.id); await refreshDatabase() }).finally(() => setTesting(false)) }}>{testing && <span className="db-spinner" />}{action.busy ? '处理中…' : '测试连接'}</button><button disabled={action.busy} onClick={onEdit}>编辑</button><button disabled={action.busy} onClick={() => setDeleting(true)}>删除</button></div>
    {deleting && <ModalFrame title="删除 Database 连接" onClose={() => setDeleting(false)}><p>删除「{profile.name}」及其项目关联？未执行的申请将作废，不会删除数据库本身。</p>{action.error && <p className="error">{action.error}</p>}<div className="db-actions"><button onClick={() => setDeleting(false)}>取消</button><button className="danger" disabled={action.busy} onClick={() => { void action.run(async () => { await saveDatabase({ type: 'deleteConnection', connectionId: profile.id }, snapshot.config.revision); setDeleting(false) }) }}>确认删除连接</button></div></ModalFrame>}
  </article>
}

/** 审批记录入口：数字是已留档的记录条数，有待批准时另标一笔。 */
function HistoryTrigger({ history, pending }: { history: DbHistoryRecord[]; pending: number }): JSX.Element {
  const [open, setOpen] = useState(false)
  return <>
    <button type="button" className="db-history-trigger" title="审批记录（本机保留最近 500 条）" onClick={() => setOpen(true)}>
      <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="1.3" d="M3 1.6h7.2L13.4 5v9.4H3z" /><path fill="none" stroke="currentColor" strokeWidth="1.3" d="M5.3 7.3h5.4M5.3 9.8h5.4M5.3 12.1h3.2" /></svg>
      审批记录 {history.length}
      {pending > 0 && <strong> · 待批准 {pending}</strong>}
    </button>
    {open && <ModalFrame title="Database 审批记录" className="db-history-modal" onClose={() => setOpen(false)}>
      <HistoryList history={history} />
    </ModalFrame>}
  </>
}

/** 记录列表：最新在前，点开一条看完整 SQL、参数和结果统计。 */
function HistoryList({ history }: { history: DbHistoryRecord[] }): JSX.Element {
  const [selected, setSelected] = useState<string>()
  const records = [...history].reverse()
  const current = records.find(item => requestKey(item) === selected)
  return <div className="db-history">
    <div className="db-history-list">
      {!records.length && <div className="empty">还没有审批记录。关联项目后启动主 CLI，用 /myclis-db 查询就会留档。</div>}
      {records.map(record => {
        const key = requestKey(record)
        return <button type="button" key={key} className={`db-history-row ${key === selected ? 'on' : ''}`} onClick={() => setSelected(key === selected ? undefined : key)}>
          <strong>{stateLabels[record.state]} · {record.target}</strong>
          <span>{record.sessionLabel} · {record.scopeLabel} · {formatLocalDate(record.endedAt)}</span>
          <span className="db-history-sql">{record.sql}</span>
        </button>
      })}
    </div>
    {current && <div className="db-history-detail">
      <p>{current.sessionLabel} · {current.scopeLabel} · {current.target}</p>
      <p>发起：{formatLocalDate(current.createdAt)} · 结束：{formatLocalDate(current.endedAt)}</p>
      <p>批准方式：{current.authorizationSource === 'approval' ? '人工批准' : current.authorizationSource === 'select' ? '只读放行' : '未执行'}</p>
      {current.policyReason && <p>审批原因：{current.policyReason}</p>}
      {current.reason && <p>AI 说明的理由：{current.reason}</p>}
      <h4>SQL{current.truncated ? '（过长，已截断）' : ''}</h4><pre tabIndex={0}>{current.sql}</pre>
      <h4>参数</h4><pre tabIndex={0}>{current.paramsText}</pre>
      {current.error && <p className="error">{current.error.message}（{current.error.code}）</p>}
      {current.rowCount !== undefined && <p className="hint">返回 {current.rowCount} 行 · 影响 {current.affectedRows} 行 · {current.durationMs} ms{current.resultTruncated ? ' · 结果已截断' : ''}</p>}
      <p className="hint">记录只留 SQL、参数和结果统计，完整结果行不在本机长期保存。</p>
    </div>}
  </div>
}

export default function DatabasePage({ onNav }: { onNav: (view: View) => void }): JSX.Element {
  const { cfg, setCfg, loadError } = useSettings(), { snapshot, error } = useDatabase()
  const [editor, setEditor] = useState<DbProfile | 'new' | null>(null)
  const [managerId, setManagerId] = useState<string>()
  const [projects, setProjects] = useState<{ scopeId: string; label: string }[]>([]), [scopeError, setScopeError] = useState('')
  const action = useDatabaseAction()
  const dirs = JSON.stringify(cfg?.workDirs ?? [])
  useEffect(() => {
    let alive = true
    const list = JSON.parse(dirs) as string[]
    void Promise.all(list.map(dir => window.clichilds.databaseResolveScope(dir))).then(scopes => {
      if (alive) { setProjects([...new Map(scopes.map(scope => [scope.scopeId, scope])).values()]); setScopeError('') }
    }).catch(() => { if (alive) { setProjects([]); setScopeError('部分工作目录不可访问，请先检查目录配置。') } })
    return () => { alive = false }
  }, [dirs])
  if (!cfg) return <div className="boot">{loadError || '加载中…'}</div>
  const changeTheme = (theme: ThemeKind) => { void action.run(async () => { const next = { ...cfg, theme }; await saveConfig(next); setCfg(next); applyTheme(theme) }) }
  const pending = snapshot?.requests.filter(request => request.state === 'pending_approval').length ?? 0
  const manager = snapshot?.config.connections.find(profile => profile.id === managerId)
  return <div className="launch">
    <ShellRail view="database" onNav={onNav} theme={cfg.theme} onTheme={changeTheme} />
    <div className="launch-body">
      <div className="db-head">
        <div className="db-head-title"><h1>Database</h1><p className="sub">管理数据库连接，勾选允许主 CLI 使用的项目</p></div>
        <span className="spacer" />
        {snapshot && <HistoryTrigger history={snapshot.history} pending={pending} />}
        <label className="db-check" title="关闭后主 CLI 用不了 /myclis-db"><input type="checkbox" checked={snapshot?.config.skillEnabled ?? false} disabled={!snapshot || !!snapshot.error || action.busy} onChange={event => { if (snapshot) { const enabled = event.target.checked; void action.run(() => saveDatabase({ type: 'setSkillEnabled', enabled }, snapshot.config.revision)) } }} />启用 /myclis-db</label>
        <button className="primary" disabled={!snapshot || !!snapshot.error} onClick={() => setEditor('new')}>新建连接</button>
      </div>
      {(error || snapshot?.error || action.error || scopeError) && <p className="error" role="alert">{error || snapshot?.error?.message || action.error || scopeError} <button onClick={() => { void refreshDatabase() }}>刷新</button></p>}
      {manager ? <DatabaseManager key={`${manager.id}:${manager.revision}`} profile={manager} onBack={() => setManagerId(undefined)} /> : !snapshot ? <div className="empty">正在读取数据库配置…</div> : !snapshot.config.connections.length ? <div className="empty">还没有数据库连接，点击「新建连接」添加。</div> :
        <div className="db-grid">{snapshot.config.connections.map(profile => <ConnectionCard key={profile.id} profile={profile} snapshot={snapshot} projects={projects} onEdit={() => setEditor(profile)} onManage={() => setManagerId(profile.id)} />)}</div>}
      {!manager && <div className="launch-actions"><span className="hint">凭据仅在本机使用；CLI 发起的查询结果仅交给对应主 CLI，本机管理面板可独立使用。配置修改立即影响权限。</span></div>}
    </div>
    {editor && snapshot && <ConnectionEditor profile={editor === 'new' ? undefined : editor} revision={snapshot.config.revision} onClose={() => setEditor(null)} />}
  </div>
}
