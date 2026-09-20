import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'

interface Props {
  title: string
  /** 说明文字：讲清楚删什么、有什么后果 */
  children: ReactNode
  /** 确认按钮文案（动词开头，如「删除」「确认清除」） */
  confirmText: string
  onConfirm: () => void
  onCancel: () => void
}

/**
 * 小确认弹窗：删除单条便签、清除目录/全部便签这类不可逆操作先问一句。
 * portal 到 body，z-index 必须高于便签浮窗（1200），否则在浮窗里点删除时弹窗被盖住、
 * 点击还会穿透到浮窗上。Esc / 点遮罩 = 取消，不额外绑回车（焦点在「取消」上，回车也是取消）。
 * Esc 走捕获阶段：便签浮窗自己也监听 Esc（收起浮窗），不拦住它就会连浮窗一起关掉。
 */
export function ConfirmDialog({ title, children, confirmText, onConfirm, onCancel }: Props): JSX.Element {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onCancel()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onCancel])

  return createPortal(
    <div
      className="confirm-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel()
      }}
    >
      <div className="confirm-panel" role="dialog" aria-modal="true" aria-label={title}>
        <b className="confirm-title">{title}</b>
        <div className="confirm-body">{children}</div>
        <div className="confirm-foot">
          <span className="spacer" />
          <button autoFocus onClick={onCancel}>
            取消
          </button>
          <button className="danger" onClick={onConfirm}>
            {confirmText}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
