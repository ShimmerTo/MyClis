import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { NOTE_STATUSES } from '@shared/types'
import type { Note, NoteStatus } from '@shared/types'
import { ipcErrorText, noteKindLabel, noteStamp, noteStatusLabel, noteTitle } from '../notes'
import { ConfirmDialog } from './ConfirmDialog'
import { NoteMedia } from './NoteMedia'
import { toast } from './ToastHost'

/* 图标统一 1px 细线 / 13px 网格，与表头那组同风格 */
function IconEdit(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
      <path
        d="M11.3 2.7 13.3 4.7 5.9 12.1 3.2 12.8 3.9 10.1z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path d="M9.9 4.1 11.9 6.1" fill="none" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  )
}

function IconTrash(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
      <path d="M3.3 4.6h9.4" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <path d="M6.5 4.6V3.3h3v1.3" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path
        d="M4.9 4.6l.6 8.1h5l.6-8.1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function IconSave(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
      <path
        d="M3.3 8.5 6.3 11.5 12.7 5.1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function IconCancel(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
      <path
        d="M4.3 4.3 11.7 11.7M11.7 4.3 4.3 11.7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  )
}

function IconCopy(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
      <rect
        x="5.8"
        y="5.6"
        width="7.6"
        height="7.8"
        rx="1.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path
        d="M10.4 5.6V4.2a1.6 1.6 0 0 0-1.6-1.6H4.2a1.6 1.6 0 0 0-1.6 1.6v4.6a1.6 1.6 0 0 0 1.6 1.6h1.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  )
}

/** 发送到 CLI 执行：终端框 + 运行三角（与状态栏子 CLI 图标同风格） */
function IconRun(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
      <rect
        x="1.7"
        y="2.8"
        width="12.6"
        height="10.4"
        rx="1.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path d="M6 6 8.7 8 6 10z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  )
}

interface Props {
  note: Note
  leading?: ReactNode
  trailing?: ReactNode
  /** 保存标题（与文本类便签的正文） */
  onSave: (patch: { title: string; content: string }) => Promise<void>
  onRemove: () => void
  /** 拉起新建会话弹窗并预勾选这条便签 */
  onExecute?: () => void
  /** 默认展开正文 */
  defaultOpen?: boolean
  /** 建好就进编辑态（「＋ 新建」用） */
  autoEdit?: boolean
}

/**
 * 一条便签：标题 + 类型 + 状态 + 添加时间一行，展开看正文，可就地编辑。
 * 状态栏浮窗与主菜单管理页共用同一份，避免两处展示口径分叉。
 */
export function NoteItem({ note, leading, trailing, onSave, onRemove, onExecute, defaultOpen, autoEdit }: Props): JSX.Element {
  const [open, setOpen] = useState(!!defaultOpen || !!autoEdit)
  const [editing, setEditing] = useState(!!autoEdit)
  const [title, setTitle] = useState(note.title)
  const [content, setContent] = useState(note.content)
  const [confirmRemove, setConfirmRemove] = useState(false)

  useEffect(() => {
    if (autoEdit) {
      setEditing(true)
      setOpen(true)
    }
  }, [autoEdit])

  // 主进程每次变更后整表推送，非编辑态要跟着刷新，否则看到的是旧正文
  useEffect(() => {
    if (editing) return
    setTitle(note.title)
    setContent(note.content)
  }, [note.title, note.content, editing])

  // 文件/网址类便签的正文就是路径，改了等于换一个目标，只能删了重加
  const editableBody = note.kind === 'text'

  // 点正文进编辑态时光标直接落到内容框；点编辑图标或新建仍从标题开始
  const titleRef = useRef<HTMLInputElement>(null)
  const bodyRef = useRef<HTMLTextAreaElement>(null)
  const focusBody = useRef(false)
  useEffect(() => {
    if (!editing) return
    if (focusBody.current) bodyRef.current?.focus()
    else titleRef.current?.focus()
    focusBody.current = false
  }, [editing])

  const saving = useRef(false)
  const [busy, setBusy] = useState(false)
  const save = async (): Promise<void> => {
    if (saving.current) return
    saving.current = true
    setBusy(true)
    try {
      await onSave({ title, content: editableBody ? content : note.content })
      setEditing(false)
      toast('保存成功')
    } catch (error) {
      toast(ipcErrorText(error))
    } finally {
      saving.current = false
      setBusy(false)
    }
  }

  const cancel = (): void => {
    setTitle(note.title)
    setContent(note.content)
    setEditing(false)
  }

  const statusSaving = useRef(false)
  const [statusBusy, setStatusBusy] = useState(false)
  const changeStatus = async (next: NoteStatus): Promise<void> => {
    if (statusSaving.current || next === note.status) return
    statusSaving.current = true
    setStatusBusy(true)
    try {
      await window.clichilds.notesUpdate({ id: note.id, status: next })
      if (next === 'done') toast('已标记为已完成，默认隐藏；勾选「显示已完成」可查看')
    } catch (error) {
      toast(ipcErrorText(error))
    } finally {
      statusSaving.current = false
      setStatusBusy(false)
    }
  }

  const copyContent = (): void => {
    void navigator.clipboard
      .writeText(note.content)
      .then(() => toast('已复制这一条的内容'))
      .catch(() => toast('复制失败'))
  }

  return (
    <div
      className={`note-item ${editing ? 'editing' : ''} ${open || editing ? 'open' : ''} status-${note.status}`}
    >
      <div className="note-head">
        {leading}
        <button
          type="button"
          className="note-toggle"
          title={open ? '收起正文' : '展开正文'}
          onClick={() => setOpen((v) => !v)}
        >
          <span className="note-caret">{open ? '▾' : '▸'}</span>
          <span className="note-title">{noteTitle(note)}</span>
        </button>
        <span className={`note-kind ${note.kind}`}>{noteKindLabel(note.kind)}</span>
        <select
          className={`note-status ${note.status}`}
          value={note.status}
          disabled={statusBusy}
          aria-label="便签状态"
          aria-busy={statusBusy}
          onChange={(event) => void changeStatus(event.target.value as NoteStatus)}
          title="选择便签状态"
        >
          {NOTE_STATUSES.map((status) => <option key={status} value={status}>{noteStatusLabel(status)}</option>)}
        </select>
        {trailing}
        <span className="note-time" title={`添加于 ${noteStamp(note.createdAt)}`}>
          {noteStamp(note.createdAt)}
        </span>
        {/* 图标按钮靠右：无边框、只在悬停时给底色 */}
        <span className="note-actions">
          {editing ? (
            <>
              <button type="button" className="note-act" disabled={busy} onClick={() => void save()} title="保存 (Ctrl+S)">
                <IconSave />
              </button>
              <button type="button" className="note-act" disabled={busy} onClick={cancel} title="放弃修改">
                <IconCancel />
              </button>
            </>
          ) : (
            <>
              {onExecute ? (
                <button
                  type="button"
                  className="note-act"
                  onClick={onExecute}
                  title="发送到 CLI：新建一个会话并注入这条便签"
                >
                  <IconRun />
                </button>
              ) : null}
              <button type="button" className="note-act" onClick={copyContent} title="复制这条便签的内容">
                <IconCopy />
              </button>
              <button
                type="button"
                className="note-act"
                onClick={() => {
                  focusBody.current = false
                  setEditing(true)
                  setOpen(true)
                }}
                title="修改标题与正文"
              >
                <IconEdit />
              </button>
              <button
                type="button"
                className="note-act danger"
                onClick={() => setConfirmRemove(true)}
                title="删除这条便签"
              >
                <IconTrash />
              </button>
            </>
          )}
        </span>
      </div>

      {editing ? (
        <div className="note-edit" onKeyDown={(event) => {
          if (event.ctrlKey && !event.altKey && event.key.toLowerCase() === 's') {
            event.preventDefault()
            event.stopPropagation()
            if (!event.nativeEvent.isComposing) void save()
          }
        }}>
          <input
            className="note-input"
            ref={titleRef}
            disabled={busy}
            value={title}
            placeholder="标题"
            onChange={(e) => setTitle(e.target.value)}
          />
          {editableBody ? (
            // 高度由 CSS 按内容算（.note-textarea 的 field-sizing），所以不设 rows
            <textarea
              className="note-textarea"
              ref={bodyRef}
              disabled={busy}
              value={content}
              placeholder="正文"
              onChange={(e) => setContent(e.target.value)}
            />
          ) : (
            <div className="note-path" title={note.content}>
              {note.content}
            </div>
          )}
        </div>
      ) : open ? (
        note.kind === 'text' ? (
          <pre className="note-body" role="button" tabIndex={0} title="点击编辑正文"
            onClick={() => {
              if (!window.getSelection()?.isCollapsed) return
              focusBody.current = true
              setEditing(true)
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return
              event.preventDefault()
              focusBody.current = true
              setEditing(true)
            }}>{note.content || '点击编辑正文'}</pre>
        ) : (
          <NoteMedia note={note} />
        )
      ) : null}

      {confirmRemove ? (
        <ConfirmDialog
          title="删除便签"
          confirmText="删除"
          onCancel={() => setConfirmRemove(false)}
          onConfirm={() => {
            setConfirmRemove(false)
            onRemove()
          }}
        >
          将删除「{noteTitle(note)}」这条便签，不可撤销。
        </ConfirmDialog>
      ) : null}
    </div>
  )
}
