import { useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ApprovalContent, type ApprovalViewModel } from './ApprovalContent'
import { ApprovalDialog, ModalFrame } from './ApprovalDialog'

/** 单队列、单操作面宿主；内联和详情互斥，业务决定仍由调用方校验。待办清单弹窗由 SSH 宿主统一提供。 */
export function ApprovalHost({ views, activeContext, inlineContainer, detailId, onOpenDetail, onDecision, busyIds, errors, renderOutcome, disabled = false }: {
  views: ApprovalViewModel[]
  activeContext?: string
  inlineContainer?: HTMLElement | null
  detailId?: string
  onOpenDetail: (id?: string) => void
  onDecision: (id: string, decision: 'approve' | 'reject') => Promise<boolean>
  busyIds: ReadonlySet<string>
  errors: ReadonlyMap<string, string>
  renderOutcome?: (id: string) => ReactNode
  disabled?: boolean
}): JSX.Element {
  const [deferred, setDeferred] = useState<Set<string>>(new Set())
  const currentDetailId = useRef(detailId)
  currentDetailId.current = detailId
  const pending = views.filter((view) => view.pending)
  const inline = pending.find((view) => view.contextKey === activeContext && !deferred.has(view.id))
  const detail = views.find((view) => view.id === detailId)
  const defer = (id: string): void => {
    setDeferred((previous) => new Set([...previous, id]))
    if (id === currentDetailId.current) onOpenDetail(undefined)
  }
  function content(view: ApprovalViewModel, expanded: boolean) {
    return {
      view,
      busy: disabled || busyIds.has(view.id),
      error: errors.get(view.id),
      onDecision: async (id: string, decision: 'approve' | 'reject') => {
        if (await onDecision(id, decision)) defer(id)
      },
      onDefer: defer,
      onExpand: expanded ? undefined : onOpenDetail,
      outcome: !view.pending ? renderOutcome?.(view.id) : undefined
    }
  }
  return <>
    {inlineContainer && inline && !detailId && createPortal(
      <div className="approval-inline" key={inline.id}>
        <div className="approval-queue-caption">这个会话等你批准 {pending.filter((view) => view.contextKey === activeContext).length} 条</div>
        <ApprovalContent key={inline.id} {...content(inline, false)} />
      </div>, inlineContainer
    )}
    {detail && <ApprovalDialog key={detail.id} {...content(detail, true)} onClose={() => onOpenDetail(undefined)} />}
    {detailId && !detail && <ModalFrame title="这条申请已经不在了" onClose={() => onOpenDetail(undefined)}><p>它不在待处理列表里了，没法批准。请回到原来那个会话看看现在什么情况；系统不会自动重新提一次。</p></ModalFrame>}
  </>
}
