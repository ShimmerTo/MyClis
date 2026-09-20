import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import type { Note } from '@shared/types'
import { useNotes, useSettings } from '../store'
import { buildNotesCopyText, dirBase, ipcErrorText, notesForDir, notesShowDone, rememberNotesShowDone } from '../notes'
import { useNoteIntake } from '../noteIntake'
import { focusTerminal } from '../terminalPool'
import { ConfirmDialog } from './ConfirmDialog'
import { NoteItem } from './NoteItem'
import { toast } from './ToastHost'

interface PanelRect {
  left: number
  top: number
  width: number
  height: number
}

const RECT_KEY = 'clichilds.notesPanelRect'
const DEFAULT_SIZE = { width: 450, height: 300 }
const MIN_WIDTH = 360
const MIN_HEIGHT = 140
/** 往屏幕外拖时至少留这么多像素可见，免得拖没了找不回来 */
const KEEP_VISIBLE = 80
/** 状态栏高度：默认位置要浮在它上面 */
function statusHeight(): number {
  const value = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--status-h'))
  return Number.isFinite(value) ? value : 24
}

/** 尺寸与位置只记在前端：localStorage 一份，会话内再缓存一份，避免每次打开都读盘 */
let rectCache: PanelRect | null = null

function clamp(min: number, max: number, value: number): number {
  return Math.min(max, Math.max(min, value))
}

/** 默认贴在右下角、浮在状态栏上方 */
function defaultRect(): PanelRect {
  const width = DEFAULT_SIZE.width
  const height = DEFAULT_SIZE.height
  return {
    left: Math.max(12, window.innerWidth - 12 - width),
    top: Math.max(40, window.innerHeight - statusHeight() - 6 - height),
    width,
    height
  }
}

/**
 * 位置允许跑到屏幕外一部分（用户明确要的），但每个方向都留 KEEP_VISIBLE 像素，
 * 否则拖过头就再也点不到了。
 */
function clampRect(rect: Partial<PanelRect>): PanelRect {
  const base = defaultRect()
  const maxWidth = Math.max(MIN_WIDTH, window.innerWidth - 24)
  const maxHeight = Math.max(MIN_HEIGHT, window.innerHeight - 120)
  const width = Math.round(clamp(MIN_WIDTH, maxWidth, rect.width ?? base.width))
  const height = Math.round(clamp(MIN_HEIGHT, maxHeight, rect.height ?? base.height))
  return {
    width,
    height,
    left: Math.round(clamp(KEEP_VISIBLE - width, window.innerWidth - KEEP_VISIBLE, rect.left ?? base.left)),
    top: Math.round(clamp(KEEP_VISIBLE - height, window.innerHeight - KEEP_VISIBLE, rect.top ?? base.top))
  }
}

function panelRect(): PanelRect {
  if (rectCache) return rectCache
  try {
    const raw = localStorage.getItem(RECT_KEY)
    rectCache = raw ? clampRect(JSON.parse(raw) as Partial<PanelRect>) : defaultRect()
  } catch {
    rectCache = defaultRect()
  }
  return rectCache
}

function rememberRect(rect: PanelRect): void {
  rectCache = rect
  try {
    localStorage.setItem(RECT_KEY, JSON.stringify(rect))
  } catch {
    // 存不下就算了，不影响功能
  }
}

function NoteIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
      <path
        d="M3.5 2.5h6.6l2.4 2.4v8.6H3.5z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path d="M10 2.6v2.6h2.5" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M5.6 8.4h4.8M5.6 10.8h3.4" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

/**
 * 状态栏上的便签入口：图标 + 当前工作目录的条数，点击向上浮出便签面板。
 * 挂在工作台的 statusExtra 插槽里，子终端那条状态栏不传插槽所以不受影响。
 */
export function NotesTrigger({
  workDir,
  termId,
  onExecuteNote
}: {
  workDir: string
  termId?: string
  /** 「发送到 CLI」：由工作台拉起新建会话弹窗并预勾选该便签 */
  onExecuteNote?: (note: Note) => void
}): JSX.Element {
  const notes = useNotes()
  const [open, setOpen] = useState(false)
  const mine = useMemo(() => notesForDir(notes, workDir), [notes, workDir])
  // 状态栏计数不含已完成；浮窗里仍可通过「显示已完成」开关看到全部
  const openCount = useMemo(() => mine.filter((n) => n.status !== 'done').length, [mine])
  // 关闭时把键盘焦点还给终端 —— 浮窗打开时会聚焦自己（否则 Ctrl+V 派发不到它）
  const close = useCallback(() => {
    setOpen(false)
    if (termId) focusTerminal(termId)
  }, [termId])
  // 先收浮窗再拉弹窗：浮窗 z-index 高于模态，不收起会盖在新建会话弹窗上面
  const execNote = (note: Note): void => {
    close()
    onExecuteNote?.(note)
  }

  return (
    <>
      <button
        type="button"
        className={`notes-trigger ${openCount > 0 ? 'has' : ''}`}
        title={`便签：${openCount} 条（${dirBase(workDir)}）`}
        onClick={() => setOpen((v) => !v)}
      >
        <NoteIcon />
        <span className="notes-count">{openCount}</span>
      </button>
      {open ? (
        <NotesPanel workDir={workDir} notes={mine} onClose={close} onExecuteNote={onExecuteNote ? execNote : undefined} />
      ) : null}
    </>
  )
}

/**
 * 便签浮窗。portal 到 body：工作台的 `.app-root` 是 `overflow: hidden`，
 * 留在里面会被裁掉；z-index 必须高于 `.picker-overlay` 的 1000，
 * 否则模态打开时浮窗被盖住、点击穿透到遮罩上还会把模态关掉。
 *
 * 默认常驻（点右上角的「—」或 Esc 才隐藏）；设置里可选「失去焦点后隐藏」，
 * 此时点到浮窗外面就收起，但确认弹窗 / 模态 / 自身入口按钮不算「外面」。
 * 尺寸可拖拽，记在前端（localStorage），不是配置项。
 */
function NotesPanel({
  workDir,
  notes,
  onClose,
  onExecuteNote
}: {
  workDir: string
  notes: Note[]
  onClose: () => void
  onExecuteNote?: (note: Note) => void
}): JSX.Element {
  const [confirmClear, setConfirmClear] = useState(false)
  const [freshId, setFreshId] = useState('')
  const [rect, setRect] = useState<PanelRect>(panelRect)
  const [showDone, setShowDone] = useState(notesShowDone)
  const panel = useRef<HTMLDivElement>(null)
  const intake = useNoteIntake(workDir)
  const { cfg } = useSettings()
  const panelMode = cfg?.notes?.panelMode ?? 'pinned'
  /** 已完成的便签默认不显示；顶部勾选后展示（管理页共用同一个开关） */
  const visible = useMemo(() => (showDone ? notes : notes.filter((n) => n.status !== 'done')), [notes, showDone])

  // 打开就聚焦：Ctrl+V 的粘贴事件只会派发到获得焦点的元素上
  useEffect(() => {
    panel.current?.focus()
  }, [])

  // Escape 仍然保留：它是明确的键盘动作，不是「失焦就自动收起」
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // 「失去焦点后隐藏」：点到浮窗外面就收起。确认弹窗 / 新建会话弹窗 / 自己的入口按钮
  // 不算「外面」—— 点确认、点遮罩、点入口切换开关时浮窗都不该消失。
  useEffect(() => {
    if (panelMode !== 'blur') return
    const onDown = (event: MouseEvent): void => {
      const target = event.target
      if (!(target instanceof HTMLElement)) return
      if (panel.current?.contains(target)) return
      if (target.closest('.confirm-overlay, .picker-overlay, .notes-menu, .notes-trigger')) return
      onClose()
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [panelMode, onClose])

  /**
   * 一个拖动处理管三件事：move = 左上角拖动整个面板，w / h = 左右/上下边条调宽高。
   * 面板统一按左上角定位（默认位置是算出来的右下角），所以调宽高时左/上边要跟着一起走，
   * 拖动后调尺寸才不会错位。
   */
  const startDrag = (event: ReactPointerEvent<HTMLDivElement>, mode: 'move' | 'w' | 'h'): void => {
    event.preventDefault()
    const startX = event.clientX
    const startY = event.clientY
    const start = rect
    let latest = start
    const move = (e: PointerEvent): void => {
      const dx = e.clientX - startX
      const dy = e.clientY - startY
      const next = clampRect(
        mode === 'move'
          ? { ...start, left: start.left + dx, top: start.top + dy }
          : mode === 'w'
            ? { ...start, left: start.left + dx, width: start.width - dx }
            : { ...start, top: start.top + dy, height: start.height - dy }
      )
      latest = next
      setRect(next)
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.classList.remove(`notes-dragging-${mode}`)
      rememberRect(latest)
    }
    document.body.classList.add(`notes-dragging-${mode}`)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up, { once: true })
  }

  const save = (id: string, patch: { title: string; content: string }): void => {
    void window.clichilds
      .notesUpdate({ id, ...patch })
      .then(() => setFreshId(''))
      .catch((error: unknown) => toast(ipcErrorText(error)))
  }

  const remove = (id: string): void => {
    void window.clichilds.notesRemove(id).catch((error: unknown) => toast(ipcErrorText(error)))
  }

  const create = (): void => {
    void window.clichilds
      .notesAdd({ workDir, kind: 'text', content: '' })
      .then((note) => {
        setFreshId(note.id)
        toast('已新建便签，直接输入内容即可')
      })
      .catch((error: unknown) => toast(ipcErrorText(error)))
  }

  const copyAll = (): void => {
    void navigator.clipboard
      .writeText(buildNotesCopyText(notes))
      .then(() => toast(`已复制 ${notes.length} 条便签`))
      .catch(() => toast('复制失败'))
  }

  const clearAll = (): void => {
    void window.clichilds
      .notesClear({ workDir })
      .then(() => {
        setConfirmClear(false)
        toast('已清除该目录的便签（原内容已备份为 notes.json.bak）')
      })
      .catch((error: unknown) => toast(ipcErrorText(error)))
  }

  return createPortal(
    <div
      className={`notes-panel ${intake.dragging ? 'dragging' : ''}`}
      ref={panel}
      tabIndex={-1}
      style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
      onDragOver={intake.onDragOver}
      onDragLeave={intake.onDragLeave}
      onDrop={intake.onDrop}
      onPaste={intake.onPaste}
    >
      {/* 左上角拖动整块面板（可以拖到屏幕外一部分）；上/左边条调宽高 */}
      <div className="notes-grip corner" onPointerDown={(e) => startDrag(e, 'move')} title="拖动移动便签面板" />
      <div className="notes-grip top" onPointerDown={(e) => startDrag(e, 'h')} title="拖动调整高度" />
      <div className="notes-grip left" onPointerDown={(e) => startDrag(e, 'w')} title="拖动调整宽度" />

      <header className="notes-panel-head">
        <b>便签</b>
        <span className="hint">
          {notes.length} 条 · {dirBase(workDir)}
        </span>
        <label className="notes-showdone" title="已完成的便签默认隐藏，勾选后显示（管理页共用这个开关）">
          <input
            type="checkbox"
            checked={showDone}
            onChange={(e) => {
              setShowDone(e.target.checked)
              rememberNotesShowDone(e.target.checked)
            }}
          />
          显示已完成
        </label>
        <span className="spacer" />
        <button type="button" onClick={create} title="新建一条空便签">
          ＋ 新建
        </button>
        <button
          type="button"
          onClick={intake.paste}
          disabled={intake.busy}
          title="粘贴剪贴板里的文件、图片或文本（也可以直接在面板里按 Ctrl+V）"
        >
          粘贴
        </button>
        <button type="button" onClick={copyAll} disabled={notes.length === 0} title="复制全部便签的标题与正文">
          复制所有
        </button>
        <button
          type="button"
          className="danger"
          onClick={() => setConfirmClear(true)}
          disabled={notes.length === 0}
          title="清除当前工作目录的全部便签"
        >
          清除所有
        </button>
        <button type="button" onClick={onClose} title="最小化便签面板（点状态栏图标可再展开）">
          —
        </button>
      </header>

      {confirmClear ? (
        <ConfirmDialog
          title="清除全部便签"
          confirmText="确认清除"
          onCancel={() => setConfirmClear(false)}
          onConfirm={clearAll}
        >
          将删除 {dirBase(workDir)} 目录下的 {notes.length} 条便签，不可撤销（原内容会自动备份成
          notes.json.bak）。
        </ConfirmDialog>
      ) : null}

      <div className="notes-panel-body">
        {notes.length === 0 ? (
          <p className="hint">
            这个工作目录还没有便签。在终端、对话详情、产出或变更窗口里选中内容后右键「加入便签」，
            也可以直接把文件拖进来或按 Ctrl+V 粘贴。
          </p>
        ) : visible.length === 0 ? (
          <p className="hint">已完成的 {notes.length} 条便签默认隐藏 —— 勾选顶部的「显示已完成」查看。</p>
        ) : (
          visible.map((note) => (
            <NoteItem
              key={note.id}
              note={note}
              autoEdit={note.id === freshId}
              onSave={(patch) => save(note.id, patch)}
              onRemove={() => remove(note.id)}
              onExecute={onExecuteNote ? () => onExecuteNote(note) : undefined}
            />
          ))
        )}
      </div>
      <div className="notes-panel-foot">
        拖入文件、或 Ctrl+V 粘贴文件 / 图片 / 文本 → 存地址；文件类便签展开即按内容预览
      </div>
    </div>,
    document.body
  )
}
