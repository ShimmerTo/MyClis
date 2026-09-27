import { useEffect, useRef, useState } from 'react'
import type { DbResult } from '@shared/database'
import { ApprovalHost, ModalFrame, type ApprovalViewModel } from '../components/approval'
import { dbError, refreshDatabase, requestKey, showDatabaseRequest, stateLabels, useDatabase } from './store'
import './database.css'

function Outcome({ sessionId, requestId }: { sessionId: string; requestId: string }): JSX.Element {
  const [result, setResult] = useState<DbResult | undefined>(), [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    void window.clichilds.database.requestInspect({ sessionId, requestId }).then(request => {
      if (alive) { setResult(request.result); setError(request.error?.message ?? '') }
    }).catch(cause => { if (alive) setError(dbError(cause)) })
    return () => { alive = false }
  }, [sessionId, requestId])
  return <>{error && <p className="error">{error}</p>}{result && <><p>{result.rows.length} 行 · 影响 {result.affectedRows} 行 · {result.durationMs} ms{result.truncated ? ' · 结果已截断' : ''}</p><pre className="db-result">{JSON.stringify({ columns: result.columns, rows: result.rows }, null, 2)}</pre></>}</>
}

export function DatabaseStatusTrigger({ workDir }: { workDir: string }): JSX.Element {
  const { snapshot, error } = useDatabase()
  const [resolved, setResolved] = useState<{ workDir: string; scopeId?: string; error?: string }>()
  const [open, setOpen] = useState(false)
  useEffect(() => {
    let alive = true
    setOpen(false)
    void window.clichilds.databaseResolveScope(workDir).then(scope => {
      if (alive) setResolved({ workDir, scopeId: scope.scopeId })
    }).catch(() => {
      if (alive) setResolved({ workDir, error: '无法读取当前工作目录的数据库关联。' })
    })
    return () => { alive = false }
  }, [workDir])
  const current = resolved?.workDir === workDir ? resolved : undefined
  const problem = current?.error || error || snapshot?.error?.message
  const loading = !current || !snapshot
  const ids = snapshot?.config.scopes.find(scope => scope.scopeId === current?.scopeId)?.connectionIds ?? []
  const connections = snapshot?.config.connections.filter(profile => ids.includes(profile.id)) ?? []
  const status = problem ? '读取失败' : loading ? '加载中…' : `已关联 ${connections.length} 个数据库`
  const title = [workDir, status, ...connections.map(profile => `${profile.name} · ${profile.kind} · ${profile.database || profile.filename}`), snapshot && !snapshot.config.skillEnabled ? '/myclis-db 已关闭' : ''].filter(Boolean).join('\n')
  return <>
    <button type="button" className="output-trigger status-pill db-status-trigger" title={title} aria-label={`Database：${status}`} onClick={() => setOpen(true)}>
      DB <span className="status-count">{problem ? '!' : loading ? '…' : connections.length}</span>
    </button>
    {open && <ModalFrame title="关联的数据库" className="db-connections-modal" backdropClose onClose={() => setOpen(false)}>
      <p className="path">{workDir}</p>
      {problem ? <p role="alert" className="error">{problem}</p> : loading ? <p className="hint">加载中…</p> : <>
        {!connections.length && <p className="hint">当前目录尚未关联数据库，可在 Database 页面勾选关联项目。</p>}
        {snapshot && !snapshot.config.skillEnabled && <p className="hint">/myclis-db 已关闭，关联保留，但主 CLI 暂不可使用。</p>}
        <div className="db-grid">
          {connections.map(profile => <article key={profile.id} className="unit-card db-card">
            <div className="unit-card-head"><b>{profile.name}</b><span className="hint">{profile.kind}</span></div>
            <p className="path">{profile.kind === 'sqlite' ? profile.filename : `${profile.host}:${profile.port} / ${profile.database}`}</p>
          </article>)}
        </div>
      </>}
    </ModalFrame>}
  </>
}

export function DatabaseBadge({ sessionId }: { sessionId?: string }): JSX.Element | null {
  const { snapshot } = useDatabase()
  const requests = snapshot?.requests.filter(r => r.state === 'pending_approval' && (!sessionId || r.sessionId === sessionId)) ?? []
  if (!requests.length) return null
  return <button className="db-badge" title="处理 Database 审批" onClick={event => { event.stopPropagation(); showDatabaseRequest(requestKey(requests[0])) }}>DB 待批准 {requests.length}</button>
}

export function DatabaseHost({ activeSessionId, inlineContainer }: { activeSessionId?: string; inlineContainer?: HTMLElement | null }): JSX.Element {
  const { snapshot, error, detailId } = useDatabase()
  const [busy, setBusy] = useState(new Set<string>()), [errors, setErrors] = useState(new Map<string, string>())
  const locks = useRef(new Set<string>()), mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const requests = snapshot?.requests ?? []
  const views: ApprovalViewModel[] = requests.map(request => ({
    id: requestKey(request), contextKey: request.sessionId, title: 'Database：SQL 执行申请',
    sourceLabel: request.sessionLabel, contextItems: [
      { label: '项目', value: request.scopeLabel }, { label: '数据库', value: request.target },
      { label: '会话', value: `${request.sessionLabel} (${request.sessionId})` }, { label: '审批原因', value: request.policyReason }
    ], detailText: `${request.sql}\n\n参数：${JSON.stringify(request.params)}`, reason: request.reason,
    warnings: ['批准仅执行这一次；写入和结构变更可能不可撤销，超时或断连不代表回滚。'],
    pending: request.state === 'pending_approval', status: stateLabels[request.state], expiresAt: request.expiresAt, approveLabel: '批准本次 SQL'
  }))
  async function decide(id: string, decision: 'approve' | 'reject'): Promise<boolean> {
    const request = requests.find(r => requestKey(r) === id)
    if (!request?.nonce || request.state !== 'pending_approval' || locks.current.has(id)) return false
    locks.current.add(id); setBusy(new Set(locks.current))
    try {
      await window.clichilds.database.requestDecide({ sessionId: request.sessionId, requestId: request.requestId, nonce: request.nonce, digest: request.digest, decision })
      return true
    } catch (cause) { if (mounted.current) setErrors(old => new Map(old).set(id, dbError(cause))); return false }
    finally { locks.current.delete(id); if (mounted.current) setBusy(new Set(locks.current)); void refreshDatabase() }
  }
  return <>
    <ApprovalHost views={views} activeContext={activeSessionId} inlineContainer={inlineContainer} detailId={detailId} onOpenDetail={showDatabaseRequest}
      onDecision={decide} busyIds={busy} errors={errors} disabled={!!error || !!snapshot?.error}
      renderOutcome={id => { const request = requests.find(r => requestKey(r) === id); return request ? <Outcome key={`${id}:${request.state}`} sessionId={request.sessionId} requestId={request.requestId} /> : null }} />
    {!detailId && <div className="db-notice"><DatabaseBadge /></div>}
  </>
}
