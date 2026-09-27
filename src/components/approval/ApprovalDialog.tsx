import { useEffect, useId, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ApprovalContent, type ApprovalContentProps } from './ApprovalContent'
import './approval.css'

const modalStack: string[] = []

/** 通用主动打开的模态容器：焦点圈定、Esc 关闭并回到原控件；backdropClose 时点蒙层也关闭。 */
export function ModalFrame({ title, children, onClose, className = '', backdropClose = false }: {
  title: string
  children: ReactNode
  onClose: () => void
  className?: string
  /** 点到对话框以外的蒙层时直接关闭（用于纯查看/草稿型弹窗；审批类保持默认不关） */
  backdropClose?: boolean
}): JSX.Element {
  const id = useId()
  const root = useRef<HTMLDivElement>(null)
  const close = useRef<HTMLButtonElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const returnKey = previous?.dataset.approvalFocusKey
    modalStack.push(id)
    close.current?.focus()
    const onKey = (event: KeyboardEvent): void => {
      if (modalStack[modalStack.length - 1] !== id) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onCloseRef.current()
      }
      if (event.key !== 'Tab') return
      const nodes = [...(root.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]'
      ) ?? [])].filter((node) => node.getClientRects().length > 0)
      const first = nodes[0]
      const last = nodes[nodes.length - 1]
      if (!first) { event.preventDefault(); root.current?.focus(); return }
      if (event.shiftKey && (document.activeElement === first || !root.current?.contains(document.activeElement))) {
        event.preventDefault(); last.focus()
      } else if (!event.shiftKey && (document.activeElement === last || !root.current?.contains(document.activeElement))) {
        event.preventDefault(); first.focus()
      }
    }
    const containFocus = (event: FocusEvent): void => {
      if (modalStack[modalStack.length - 1] === id && event.target instanceof Node && !root.current?.contains(event.target)) close.current?.focus()
    }
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('focusin', containFocus)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('focusin', containFocus)
      const index = modalStack.indexOf(id)
      const wasTop = index === modalStack.length - 1
      if (index >= 0) modalStack.splice(index, 1)
      if (wasTop && previous?.isConnected) previous.focus()
      else if (wasTop && returnKey) {
        const replacement = [...document.querySelectorAll<HTMLElement>('[data-approval-focus-key]')].find((node) => node.dataset.approvalFocusKey === returnKey)
        replacement?.focus()
      }
    }
  }, [id])
  return createPortal(
    <div className={`approval-backdrop ${className}`} onMouseDown={backdropClose ? (event) => { if (event.target === event.currentTarget) onCloseRef.current() } : undefined}>
      <div ref={root} className="approval-dialog" role="dialog" aria-modal="true" aria-labelledby={id} tabIndex={-1}>
        <header className="approval-dialog-header"><h2 id={id}>{title}</h2><button ref={close} className="dialog-close" type="button" onClick={onClose} aria-label="关闭对话框">✕</button></header>
        <div className="approval-dialog-body">{children}</div>
      </div>
    </div>, document.body
  )
}

/** 详情与内联使用同一受控内容，不创建第二份审批状态。 */
export function ApprovalDialog(props: ApprovalContentProps & { onClose: () => void }): JSX.Element {
  return <ModalFrame title={props.view.title} onClose={props.onClose}><ApprovalContent {...props} /></ModalFrame>
}
