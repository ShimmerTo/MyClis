import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ChatEntry, CliId, TranscriptPage } from '@shared/types'
import { useNoteMenu } from './NoteContextMenu'

/** 一个可看正文的会话页签：主 CLI 一条，每个子 CLI 一条 */
export interface TranscriptTab {
  key: string
  label: string
  cli: CliId
  nativeSessionId?: string
  cwd?: string
  done?: boolean
}

interface Props {
  title: string
  subtitle?: string
  tabs: TranscriptTab[]
  onClose: () => void
  onResume?: () => void
  resumeDisabledReason?: string
  /** 「用其他 CLI 继续」：把当前页签的问答整理成 txt，再起一个新 CLI 接着做 */
  onContinueOther?: (tab: TranscriptTab) => void
}

const KIND_LABEL: Record<ChatEntry['kind'], string> = {
  user: '用户',
  assistant: '助手',
  reasoning: '思考',
  tool: '工具',
  system: '系统'
}

const clock = (ts?: number): string =>
  ts ? new Date(ts).toLocaleTimeString('zh-CN', { hour12: false }) : ''

const sizeText = (bytes: number): string =>
  bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`

/** 会话正文弹窗：切到某个页签才去读它自己的 transcript。 */
export function TranscriptModal(props: Props): JSX.Element {
  const [active, setActive] = useState(props.tabs[0]?.key ?? '')
  const [page, setPage] = useState<TranscriptPage | null>(null)
  const [loading, setLoading] = useState(false)
  const panel = useRef<HTMLDivElement>(null)
  const tab = props.tabs.find((item) => item.key === active) ?? props.tabs[0]
  // 正文选区右键：便签归属这条会话自己的工作目录（拿不到 cwd 时只保留复制，不给加入便签）
  const noteMenu = useNoteMenu({ workDir: tab?.cwd, selectionCopyLabel: '复制选中' })

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

  useEffect(() => {
    let alive = true
    if (!tab?.nativeSessionId) {
      setPage(null)
      return () => {
        alive = false
      }
    }
    setLoading(true)
    setPage(null)
    window.clichilds
      .transcriptRead({ cli: tab.cli, nativeSessionId: tab.nativeSessionId })
      .then((p) => alive && setPage(p))
      .catch(() =>
        alive && setPage({ entries: [], truncated: false, totalBytes: 0, reason: 'file-missing' })
      )
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab?.cli, tab?.nativeSessionId])

  const body = (): JSX.Element => {
    if (!tab?.nativeSessionId) return <div className="chat-empty">未记录该 CLI 的 session id，读不到正文</div>
    if (loading || !page) return <div className="chat-empty">读取中…</div>
    if (page.reason) {
      return (
        <div className="chat-empty">
          {page.reason === 'dir-missing' ? '该 CLI 的会话目录不存在' : '找不到该会话的记录文件'}
          {page.file ? <div className="dim">{page.file}</div> : null}
        </div>
      )
    }
    if (page.entries.length === 0) return <div className="chat-empty">这条会话还没有正文</div>
    return (
      <>
        {page.entries.map((entry, i) => (
          <div key={i} className={`chat-line ${entry.kind}`}>
            <span className="chat-role">{KIND_LABEL[entry.kind]}</span>
            <span className="chat-time dim">{clock(entry.ts)}</span>
            <span className="chat-text">{entry.text}</span>
          </div>
        ))}
        {page.truncated ? <div className="chat-empty dim">只展示了最近的部分正文</div> : null}
      </>
    )
  }

  return createPortal(
    <div
      className="picker-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) props.onClose()
      }}
    >
      <div
        className="picker-panel chat-panel"
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="会话详情"
      >
        <div className="picker-head">
          <h2>{props.title}</h2>
          <span className="hint">{props.subtitle}</span>
          <span className="spacer" />
          <button type="button" onClick={props.onClose}>
            关闭
          </button>
        </div>
        <div className="chat-tabs">
          {props.tabs.map((item) => (
            <button
              key={item.key}
              type="button"
              className={`chat-tab ${item.key === tab?.key ? 'on' : ''}`}
              onClick={() => setActive(item.key)}
              title={item.nativeSessionId ?? '未记录 session id'}
            >
              {item.label}
              {item.done ? <span className="tag">完成</span> : null}
            </button>
          ))}
        </div>
        <div className="chat-body" onContextMenu={noteMenu.onContextMenu}>
          {body()}
        </div>
        {noteMenu.menu}
        <div className="picker-foot">
          <span className="hint">
            {tab?.nativeSessionId ? (
              <>
                原生 id {tab.nativeSessionId}
                {page && page.totalBytes > 0 ? ` · ${sizeText(page.totalBytes)}` : ''}
                {tab.cwd ? ` · ${tab.cwd}` : ''}
              </>
            ) : (
              '未记录原生 session id'
            )}
          </span>
          <span className="spacer" />
          {props.onContinueOther && tab?.nativeSessionId ? (
            <button
              type="button"
              title="把这条会话的提问与回复整理成 txt 落盘，再用另一个 CLI 开新会话接着做"
              onClick={() => props.onContinueOther?.(tab)}
            >
              使用其他 CLI 继续
            </button>
          ) : null}
          {props.onResume || props.resumeDisabledReason ? (
            <button
              type="button"
              disabled={!props.onResume || !!props.resumeDisabledReason}
              title={props.resumeDisabledReason || '用该 CLI 的原生 resume 继续此主会话'}
              onClick={props.onResume}
            >
              继续此会话
            </button>
          ) : null}
          {tab?.nativeSessionId ? (
            <button
              type="button"
              onClick={() => void navigator.clipboard.writeText(tab.nativeSessionId ?? '')}
            >
              复制 id
            </button>
          ) : null}
        </div>
      </div>
    </div>,
    document.body
  )
}
