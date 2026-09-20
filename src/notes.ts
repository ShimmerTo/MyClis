import type { Note, NoteKind, NoteStatus } from '@shared/types'

/** 取路径最后一段：提示文案与分组标题都用它 */
export const dirBase = (p: string): string => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p

const STATUS_LABEL: Record<NoteStatus, string> = { todo: '未处理', doing: '进行中', done: '已完成' }

export const noteStatusLabel = (status: NoteStatus): string => STATUS_LABEL[status]

/** 点状态标签的循环口径：未处理 → 进行中 → 已完成 → 未处理 */
export function nextNoteStatus(status: NoteStatus): NoteStatus {
  return status === 'todo' ? 'doing' : status === 'doing' ? 'done' : 'todo'
}

/**
 * 是否显示已完成的便签：浮窗与管理页共用一份开关。
 * 只记在前端（localStorage），不进配置 —— 它是「这次看列表」的临时视图，不是产品设置。
 */
const SHOW_DONE_KEY = 'clichilds.notesShowDone'
let showDoneCache: boolean | null = null

export function notesShowDone(): boolean {
  if (showDoneCache !== null) return showDoneCache
  try {
    showDoneCache = localStorage.getItem(SHOW_DONE_KEY) === '1'
  } catch {
    showDoneCache = false
  }
  return showDoneCache
}

export function rememberNotesShowDone(value: boolean): void {
  showDoneCache = value
  try {
    localStorage.setItem(SHOW_DONE_KEY, value ? '1' : '0')
  } catch {
    // 存不下就算了，不影响功能
  }
}

/** IPC 错误文案归一：去掉 Electron 包的「Error invoking remote method …」前缀 */
export function ipcErrorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(
    /^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/i,
    ''
  )
}

/** 字节数按量级给人类可读值 */
export function bytesText(bytes?: number): string {
  if (bytes === undefined) return ''
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

/**
 * 工作目录比较口径：去掉尾部分隔符 + 忽略大小写。
 * 与 SessionHistoryRail 里的同名判定保持一致 —— 口径分叉会让 `d:\X` 与 `D:\X\`
 * 被算成两个目录，浮窗里就看不到自己刚加的便签。
 */
export function sameDir(a: string, b: string): boolean {
  return a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase()
}

/** 某个工作目录下的便签（主进程已按加入时间倒序，这里保持原序） */
export function notesForDir(notes: Note[], workDir: string): Note[] {
  if (!workDir) return []
  return notes.filter((note) => sameDir(note.workDir, workDir))
}

/** 标题：主进程写入时已给过，这里只兜旧数据 */
export function noteTitle(note: Note): string {
  const given = note.title?.trim()
  if (given) return given
  if (note.kind === 'file') return note.content.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || note.content
  const flat = note.content.replace(/\s+/g, ' ').trim()
  return flat.length > 20 ? `${flat.slice(0, 20)}…` : flat
}

const TIME_OPTS: Intl.DateTimeFormatOptions = {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false
}

/** 添加时间：列表里按本地时区展示 */
export const noteStamp = (ts: number): string => new Date(ts).toLocaleString('zh-CN', TIME_OPTS)

const KIND_LABEL: Record<NoteKind, string> = { text: '文本', file: '文件', url: '网址' }

export const noteKindLabel = (kind: NoteKind): string => KIND_LABEL[kind]

/** 便签占用的一行摘要：文件/网址便签在列表里显示路径，文本便签显示正文首行 */
export function noteSummary(note: Note): string {
  if (note.kind === 'text') {
    const first = note.content.split('\n').find((line) => line.trim()) ?? ''
    return first.length > 60 ? `${first.slice(0, 60)}…` : first
  }
  return note.content
}

/**
 * 注入新会话的总长上限。
 * 投递靠「首 32 + 末 32 字符」两个回显探针确认，超长文本经 pty 投递本身就不是可靠通道，
 * 所以宁可在产品侧限长，也不让状态机走进「回车后再重贴」的回退。
 */
export const NOTES_PROMPT_LIMIT = 8000

/**
 * 把勾选的便签拼成投递文本。超出上限时截断当前一条并省略其余，返回被省略的条数。
 */
export function buildNotesPrompt(notes: Note[]): { text: string; omitted: number } {
  if (notes.length === 0) return { text: '', omitted: 0 }
  let text = `以下是我加入便签的内容（共 ${notes.length} 条），请作为本次对话的背景参考：`
  let omitted = 0
  for (const [index, note] of notes.entries()) {
    const block = `\n\n【${index + 1}】${noteTitle(note)}\n${note.content}`
    if (text.length + block.length <= NOTES_PROMPT_LIMIT) {
      text += block
      continue
    }
    // 放不下就截断这一条，后面的全部省略；剩余空间太小时直接整条略过
    const room = NOTES_PROMPT_LIMIT - text.length
    if (room > 200) {
      text += `${block.slice(0, room)}\n…（本条已截断）`
      omitted = notes.length - index - 1
    } else {
      omitted = notes.length - index
    }
    break
  }
  return { text, omitted }
}

/** 「复制所有」的文本：标题 + 内容，条与条之间空行分隔 */
export function buildNotesCopyText(notes: Note[]): string {
  return notes.map((note) => `【${noteTitle(note)}】\n${note.content}`).join('\n\n')
}
