import { useState } from 'react'
import type { DatabaseKind, DbProfile, DbProfileInput } from '@shared/database'
import { ModalFrame } from '../components/approval'
import { useSshStore } from '../ssh/store'
import { saveDatabase, useDatabaseAction } from './store'

export const kindLabels: Record<DatabaseKind, string> = { mysql: 'MySQL / MariaDB', postgres: 'PostgreSQL', mssql: 'SQL Server', sqlite: 'SQLite' }
const ports: Record<DatabaseKind, number> = { mysql: 3306, postgres: 5432, mssql: 1433, sqlite: 1 }
export function ConnectionEditor({ profile, revision, onClose }: { profile?: DbProfile; revision: number; onClose: () => void }): JSX.Element {
  const [draft, setDraft] = useState<DbProfileInput>(() => ({ name: profile?.name ?? '', kind: profile?.kind ?? 'mysql', host: profile?.host ?? '127.0.0.1', port: profile?.port ?? 3306,
    database: profile?.database ?? '', username: profile?.username ?? '', filename: profile?.filename ?? '', tls: profile?.tls ?? false,
    sshConnectionId: profile?.sshConnectionId, approvalTables: profile?.approvalTables ?? [] }))
  const [password, setPassword] = useState(''), [changePassword, setChangePassword] = useState(!profile?.hasPassword)
  const [tables, setTables] = useState(profile?.approvalTables.join('\n') ?? ''), [validation, setValidation] = useState('')
  const [expectedRevision] = useState(revision)
  const action = useDatabaseAction(), ssh = useSshStore()
  const patch = (value: Partial<DbProfileInput>) => setDraft(previous => ({ ...previous, ...value }))
  const network = draft.kind !== 'sqlite'
  const save = () => {
    if (!draft.name.trim() || (network && (!draft.host.trim() || !draft.database.trim() || !draft.username.trim())) || (!network && !draft.filename)) { setValidation('请填写名称和完整连接信息。'); return }
    setValidation('')
    const input: DbProfileInput = { ...draft, approvalTables: tables.split(/[\n,，]/).map(t => t.trim()).filter(Boolean),
      ...(changePassword ? { password } : {}), ...(!network ? { host: '', port: 1, database: '', username: '', sshConnectionId: undefined, tls: false, password: '' } : {}) }
    void action.run(async () => { await saveDatabase({ type: 'saveConnection', id: profile?.id, profile: input }, expectedRevision); setPassword(''); onClose() })
  }
  return <ModalFrame title={profile ? '编辑 Database 连接' : '新建 Database 连接'} onClose={onClose}>
    <form className="db-editor" onSubmit={event => { event.preventDefault(); save() }}>
      <fieldset className="db-form" disabled={action.busy}>
        <label>名称<input required maxLength={120} value={draft.name} onChange={event => patch({ name: event.target.value })} /></label>
        <label>数据库类型<select value={draft.kind} onChange={event => { const kind = event.target.value as DatabaseKind; patch({ kind, port: ports[kind], tls: kind === 'mssql', sshConnectionId: kind === 'sqlite' ? undefined : draft.sshConnectionId }) }}>{Object.entries(kindLabels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
        {network ? <>
          <label>数据库地址<input required maxLength={255} value={draft.host} onChange={event => patch({ host: event.target.value })} /></label>
          <label>端口<input required type="number" min={1} max={65535} value={draft.port} onChange={event => patch({ port: Number(event.target.value) })} /></label>
          <label>数据库名称<input required maxLength={128} value={draft.database} onChange={event => patch({ database: event.target.value })} /></label>
          <label>用户名<input required autoComplete="off" maxLength={128} value={draft.username} onChange={event => patch({ username: event.target.value })} /></label>
          <label className="db-wide">SSH 桥接<select value={draft.sshConnectionId ?? ''} onChange={event => patch({ sshConnectionId: event.target.value || undefined })}>
            <option value="">直接连接</option>{ssh.snapshot?.config.connections.map(connection => <option key={connection.id} value={connection.id}>{connection.name} · {connection.host}</option>)}
            {draft.sshConnectionId && !ssh.snapshot?.config.connections.some(connection => connection.id === draft.sshConnectionId) && <option value={draft.sshConnectionId}>原 SSH 连接不可用，请重新选择</option>}
          </select><small className="hint">桥接时数据库地址从 SSH 服务器访问；不会授予 SSH 命令权限。</small></label>
          {ssh.loadError && <p className="error db-wide">{ssh.loadError}</p>}
          <label className="db-check db-wide"><input type="checkbox" checked={draft.tls} onChange={event => patch({ tls: event.target.checked })} />启用 TLS（验证服务器证书）</label>
          {profile?.hasPassword && <label className="db-check db-wide"><input type="checkbox" checked={changePassword} onChange={event => setChangePassword(event.target.checked)} />修改已保存的密码</label>}
          {changePassword && <label className="db-wide">密码<input type="password" autoComplete="new-password" maxLength={8192} value={password} onChange={event => setPassword(event.target.value)} /><small className="hint">使用 Windows 凭据加密保存，不提供给 CLI；留空表示空密码。</small></label>}
        </> : <label className="db-wide">SQLite 文件<div className="db-row"><input readOnly required value={draft.filename} /><button type="button" onClick={() => { void action.run(async () => { const filename = await window.clichilds.databasePickFile(); if (filename) patch({ filename }) }) }}>选择文件</button></div></label>}
        <label className="db-wide">SELECT 需要批准的表<textarea rows={4} value={tables} onChange={event => setTables(event.target.value)} placeholder={'每行一个表名，例如 users 或 public.users'} /><small className="hint">适用于所有关联项目；同名表保守地一起保护，联表和子查询也检查。</small></label>
      </fieldset>
      {(validation || action.error) && <p className="error" role="alert">{validation || action.error}</p>}
      <div className="db-actions"><button type="button" onClick={onClose}>取消</button><button type="submit" className="primary" disabled={action.busy}>{action.busy ? '保存中…' : '保存'}</button></div>
    </form>
  </ModalFrame>
}
