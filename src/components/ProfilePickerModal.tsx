import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CliConfig, CliStatus } from '@shared/types'
import { ProfileChoiceGrid } from './ProfileChoiceGrid'

interface Props {
  title: string
  /** 出现在标题里的命令名，用于空态说明「不注入哪条命令」 */
  command: string
  profiles: CliConfig[]
  clis: CliStatus[]
  selectedIds: string[]
  multiple: boolean
  /** 只在点「确定」时回调一次：每保存一次都会重新注入各 CLI 的命令文件 */
  onCommit: (ids: string[]) => void
  onClose: () => void
}

/** 弹窗挑选执行 CLI：勾选只改草稿，取消 / ESC / 点遮罩都不落盘。 */
export function ProfilePickerModal(props: Props): JSX.Element {
  const [draft, setDraft] = useState<string[]>(props.selectedIds)
  const panel = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const opener = document.activeElement
    panel.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') props.onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      if (opener instanceof HTMLElement) opener.focus()
    }
    // 只挂一次；onClose 只做父组件的 setState，首帧闭包够用
  }, [])

  return createPortal(
    <div
      className="picker-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) props.onClose()
      }}
    >
      <div className="picker-panel" ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-label={props.title}>
        <div className="picker-head">
          <h2>{props.title} · 选择 CLI</h2>
          <span className="hint">{props.multiple ? '可多选，勾选顺序就是执行顺序' : '只选一个'}</span>
          <span className="spacer" />
          <span className="hint">已选 {draft.length}</span>
        </div>
        <ProfileChoiceGrid
          profiles={props.profiles}
          clis={props.clis}
          selectedIds={draft}
          multiple={props.multiple}
          allowEmpty
          onChange={setDraft}
        />
        <div className="picker-foot">
          <span className="hint">确定后才会写入配置，并重新注入 {`/${props.command}`}</span>
          <span className="spacer" />
          <button type="button" onClick={props.onClose}>
            取消
          </button>
          <button type="button" className="primary" onClick={() => props.onCommit(draft)}>
            确定
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
