import { useEffect, useState, type ReactNode } from 'react'
import './approval.css'

/** 纯 UI 审批模型，不包含执行凭据、业务 API 或后端类型。 */
export interface ApprovalViewModel {
  id: string
  contextKey: string
  title: string
  sourceLabel: string
  contextItems: { label: string; value: string }[]
  detailText: string
  reason: string
  warnings: string[]
  expiresAt?: number
  status: string
  pending: boolean
  approveLabel: string
}

/** 通用受控审批内容的回调契约。 */
export interface ApprovalContentProps {
  view: ApprovalViewModel
  busy?: boolean
  error?: string
  onDecision: (id: string, decision: 'approve' | 'reject') => void
  onDefer?: (id: string) => void
  onExpand?: (id: string) => void
  outcome?: ReactNode
}

/** 日期按浏览器本地时区展示，同时兼容秒与毫秒 Unix 时间。 */
export function formatLocalDate(timestamp: number): string {
  return new Date(timestamp < 1e12 ? timestamp * 1000 : timestamp).toLocaleString()
}

/** 仅用于有效期展示，不触发批准、认证或自动重试。 */
export function useApprovalClock(): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  return now
}

/** 统一判断服务时间是否过期。 */
export function isExpired(expiresAt: number | undefined, now = Date.now()): boolean {
  return expiresAt !== undefined && (expiresAt < 1e12 ? expiresAt * 1000 : expiresAt) <= now
}

/** 无业务依赖的纯展示视图：所有来源文本均作为文本节点渲染。 */
export function ApprovalView({ view }: { view: ApprovalViewModel }): JSX.Element {
  return <>
    <div className="approval-heading"><strong>{view.title}</strong><span>{view.status}</span></div>
    <div className="approval-source">来源：{view.sourceLabel}</div>
    <dl className="approval-context">{view.contextItems.map((item, index) => <div key={`${item.label}-${index}`}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl>
    <div className="approval-scroll" tabIndex={0} aria-label="要执行的内容和风险说明">
      <h4>为什么要执行</h4><p className="approval-text">{view.reason || '没写原因'}</p>
      <h4>具体要执行的内容</h4><pre className="approval-command" dir="ltr">{view.detailText}</pre>
      {view.warnings.map((warning) => <p className="approval-warning" key={warning}>{warning}</p>)}
      {view.expiresAt !== undefined && <p>过了 {formatLocalDate(view.expiresAt)} 就作废</p>}
    </div>
  </>
}

/** 决定只能来自当前按钮手势；不绑定全局 Enter 或自动聚焦批准按钮。 */
export function ApprovalContent({ view, busy = false, error, onDecision, onDefer, onExpand, outcome }: ApprovalContentProps): JSX.Element {
  const now = useApprovalClock()
  const expired = isExpired(view.expiresAt, now)
  const [copyError, setCopyError] = useState('')
  const [copied, setCopied] = useState(false)
  async function copy(): Promise<void> {
    try { await navigator.clipboard.writeText(view.detailText); setCopied(true); setCopyError('') }
    catch { setCopyError('复制失败，请手动选择原文复制。') }
  }
  return <section className="approval-content" aria-label={view.title} onKeyDown={(event) => {
    if (event.key === 'Escape' && onDefer) { event.stopPropagation(); onDefer(view.id) }
  }}>
    <ApprovalView view={view} />
    {expired && view.pending && <p className="approval-warning">这条申请已经过期，不能再点了。请回到发起的一方让它重新提一次，系统不会自动重试。</p>}
    {(error || copyError) && <p role="alert" className="approval-error">{error || copyError}</p>}
    {outcome}
    <footer className="approval-actions">
      <button type="button" onClick={() => { void copy() }}>{copied ? '已复制' : '复制这段内容'}</button>
      {onDefer && <button type="button" onClick={() => onDefer(view.id)}>先放着</button>}
      {onExpand && <button type="button" data-approval-focus-key={`${view.id}:expand`} onClick={() => onExpand(view.id)}>看完整详情</button>}
      {view.pending && <>
        <button type="button" disabled={busy || expired} onClick={() => onDecision(view.id, 'reject')}>拒绝</button>
        <button type="button" className="approval-approve" disabled={busy || expired} onClick={() => onDecision(view.id, 'approve')}>{busy ? '提交中…' : view.approveLabel}</button>
      </>}
    </footer>
  </section>
}
