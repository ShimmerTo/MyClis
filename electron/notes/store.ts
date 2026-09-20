import { randomUUID } from 'crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { basename, isAbsolute, join, relative, resolve } from 'path'
import { CH, NOTE_STATUSES } from '../../shared/types'
import type { Note, NoteKind, NoteStatus } from '../../shared/types'
import { NOTE_SPLIT_RE, noteFileStem, noteSplitNames, notesBaseDir, notesPath } from './paths'

/** 单条正文上限：正文是用户任意选区，不设限会让整表越来越重、每次全量改写越来越慢 */
const MAX_CONTENT = 100 * 1024
/** 标题上限：只用于列表展示 */
const MAX_TITLE = 200
/** 整表条数上限，超出淘汰最旧的 */
const KEEP = 1000

const KINDS: NoteKind[] = ['text', 'file', 'url']

type Emitter = (channel: string, payload: unknown) => void

/**
 * 文本净化：CRLF 归一成 LF，并去掉 C0 控制字符（含 ESC）。
 * 便签正文会被拼进 prompt 投递给 CLI，带 `\r` 会在粘贴中途被当成回车提前提交，
 * 带 ESC 会打断括号粘贴（`\x1b[200~`）让后半段变成键盘输入。
 */
export function sanitizeNoteText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
}

/** 标题兜底：file 取文件名、url 取网址、text 取正文前 20 字（折叠空白） */
function defaultTitle(kind: NoteKind, content: string): string {
  if (kind === 'file') return basename(content) || content
  if (kind === 'url') return content
  const flat = content.replace(/\s+/g, ' ').trim()
  if (!flat) return '新便签'
  return flat.length > 20 ? `${flat.slice(0, 20)}…` : flat
}

/**
 * 读时归一：只接受字段齐全的条目，畸形的直接丢弃。
 * 只防 JSON 语法错误是不够的 —— flush 被强杀会留下「合法 JSON 但某条缺字段」，
 * 那种条目放进去会让渲染层取到 undefined 再崩。
 */
function toNote(raw: unknown): Note | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Partial<Note>
  if (typeof item.content !== 'string') return null
  const workDir = typeof item.workDir === 'string' ? item.workDir.trim() : ''
  if (!workDir) return null
  const kind: NoteKind = KINDS.includes(item.kind as NoteKind) ? (item.kind as NoteKind) : 'text'
  const content = (kind === 'text' ? sanitizeNoteText(item.content) : item.content.trim()).slice(0, MAX_CONTENT)
  // 文本便签允许空正文（手动新建后再编辑）；文件/网址类没有目标就没有意义
  if (kind !== 'text' && !content) return null
  // file 类只认绝对路径：相对路径在预览端无从解析
  if (kind === 'file' && !isAbsolute(content)) return null
  const createdAt = Number.isFinite(item.createdAt) ? Number(item.createdAt) : Date.now()
  const updatedAt = Number.isFinite(item.updatedAt) ? Number(item.updatedAt) : createdAt
  const given = typeof item.title === 'string' ? sanitizeNoteText(item.title).replace(/\s+/g, ' ').trim() : ''
  return {
    id: typeof item.id === 'string' && item.id ? item.id : randomUUID(),
    workDir,
    kind,
    content,
    title: (given || defaultTitle(kind, content)).slice(0, MAX_TITLE),
    // 旧数据没有 status：一律按「未处理」归位
    status: NOTE_STATUSES.includes(item.status as NoteStatus) ? (item.status as NoteStatus) : 'todo',
    createdAt,
    updatedAt
  }
}

/**
 * 便签：跨重启保留在存储目录（默认 userData/clichilds，可在设置里改）下，
 * 按工作目录拆分存储 —— 每个目录两个文件：非已完成一份、已完成一份
 * （文件名规则见 paths.ts 的 noteFileStem / noteSplitNames）。
 * 旧版单文件 notes.json 仍可读：只要还没有拆分的目录文件，就整表读它，首次落盘自动完成拆分。
 * 只在主进程读写。读-改-写之间不夹 await，所以不需要加锁（同 HistoryStore）。
 */
export class NotesStore {
  private items: Note[] = []
  private loaded = false

  constructor(private emit: Emitter) {}

  private ensure(): void {
    if (this.loaded) return
    this.loaded = true
    this.items = []
    const dir = notesBaseDir()
    let splitFiles: string[] = []
    try {
      splitFiles = existsSync(dir) ? readdirSync(dir).filter((f) => NOTE_SPLIT_RE.test(f)) : []
    } catch (err) {
      console.error('扫描便签拆分目录失败，回退读旧版单文件', err)
    }
    if (splitFiles.length > 0) {
      const seen = new Set<string>()
      for (const file of splitFiles) {
        try {
          const raw = JSON.parse(readFileSync(join(dir, file), 'utf-8')) as unknown
          if (!Array.isArray(raw)) continue
          for (const entry of raw) {
            const note = toNote(entry)
            // 同一目录两份文件理论上互斥；手改文件造成的重复按先读到的为准
            if (!note || seen.has(note.id)) continue
            seen.add(note.id)
            this.items.push(note)
          }
        } catch (err) {
          // 单个拆分文件坏了只丢它，不牵连其它目录
          console.error(`读取便签文件失败：${file}`, err)
        }
      }
      // 合并多文件后没有天然的「最新在前」，按创建时间倒序恢复原口径
      this.items.sort((a, b) => b.createdAt - a.createdAt)
      this.items = this.items.slice(0, KEEP)
      return
    }
    try {
      const raw = JSON.parse(readFileSync(notesPath(), 'utf-8')) as unknown
      if (Array.isArray(raw)) {
        this.items = raw
          .map(toNote)
          .filter((item): item is Note => !!item)
          .slice(0, KEEP)
      }
    } catch {
      this.items = []
    }
  }

  /** 最新加入的在前 */
  list(): Note[] {
    this.ensure()
    return this.items.map((item) => ({ ...item }))
  }

  /**
   * 新增一条。file 类在这里做落盘校验（存在、是文件不是目录），
   * 越界路径在预览端只会显示「文件已不存在」，不如加入时就拒绝。
   */
  add(input: { workDir: string; kind: NoteKind; content: string; title?: string }): Note {
    this.ensure()
    const workDir = input.workDir.trim()
    if (!workDir) throw new Error('便签缺少工作目录')
    const kind: NoteKind = KINDS.includes(input.kind) ? input.kind : 'text'
    const content = (kind === 'text' ? sanitizeNoteText(input.content) : input.content.trim()).slice(0, MAX_CONTENT)
    // 文本便签允许空正文（「＋ 新建」建一条再编辑）；文件/网址类必须有目标
    if (kind !== 'text' && !content) throw new Error('便签内容为空')
    if (kind === 'file') {
      if (!isAbsolute(content)) throw new Error('便签只接受文件的绝对路径')
      let stat: ReturnType<typeof statSync>
      try {
        stat = statSync(content)
      } catch {
        throw new Error(`文件不存在：${content}`)
      }
      if (!stat.isFile()) throw new Error(`不是文件：${content}`)
    }
    if (kind === 'url' && !/^https?:\/\//i.test(content)) throw new Error('便签只接受 http/https 网址')

    const now = Date.now()
    const note: Note = {
      id: randomUUID(),
      workDir,
      kind,
      content,
      title: this.titleOf(input.title, kind, content),
      status: 'todo',
      createdAt: now,
      updatedAt: now
    }
    this.items.unshift(note)
    if (this.items.length > KEEP) this.items.length = KEEP
    this.flush()
    return { ...note }
  }

  /**
   * 改标题、正文与处理状态；类型不变（file 类的正文就是路径，改它等于换文件，交给删除+重加）。
   * 只给 status 时不能重算标题 —— 否则手动改过的标题会被正文兜底标题顶掉。
   */
  update(input: { id: string; title?: string; content?: string; status?: NoteStatus }): void {
    this.ensure()
    const note = this.items.find((item) => item.id === input.id)
    if (!note) return
    if (typeof input.content === 'string') {
      const content = (note.kind === 'text' ? sanitizeNoteText(input.content) : input.content.trim()).slice(
        0,
        MAX_CONTENT
      )
      if (note.kind !== 'text' && !content) throw new Error('便签内容不能为空')
      note.content = content
    }
    if (typeof input.title === 'string') {
      note.title = this.titleOf(input.title, note.kind, note.content)
    }
    if (NOTE_STATUSES.includes(input.status as NoteStatus)) {
      note.status = input.status as NoteStatus
    }
    note.updatedAt = Date.now()
    this.flush()
  }

  remove(id: string): void {
    this.ensure()
    const before = this.items.length
    this.items = this.items.filter((item) => item.id !== id)
    if (this.items.length !== before) this.flush()
  }

  /** 不带 workDir = 清全部（管理页），带上 = 只清该工作目录（浮窗） */
  clear(workDir?: string): void {
    this.ensure()
    const target = workDir?.trim()
    const next = target ? this.items.filter((item) => item.workDir !== target) : []
    if (next.length === this.items.length) return
    // 清除不可逆（跨目录、无回收站），先留一份可人工恢复的备份
    this.backup()
    this.items = next
    this.flush()
  }

  /** 标题：给了就用给的（截断），否则按类型兜底 */
  private titleOf(title: string | undefined, kind: NoteKind, content: string): string {
    const given = sanitizeNoteText(title ?? '').replace(/\s+/g, ' ').trim()
    return (given || defaultTitle(kind, content)).slice(0, MAX_TITLE)
  }

  /**
   * 切换便签存储目录：把便签数据（拆分文件；没有拆分文件时是旧版 notes.json）与 notes-assets/
   * 整体搬到新目录，指向旧资产目录的文件类便签同步改写成新路径（图片粘贴后落的就是这个目录，不改写会全部变成死链接）。
   *
   * 分寸：
   *  - 目标目录里已经有便签数据（notes.json 或任一拆分文件）时直接拒绝 —— 迁移会覆盖它们，
   *    宁可让用户换目录或先自行处理。
   *  - 先写好新文件、再动旧文件：任一步失败都不会「两边都没有」；旧 notes.json 退成 notes.json.bak，
   *    与清除操作的备份口径一致，迁移完还能人工找回；旧拆分文件删掉，避免将来换回旧目录时读到过期数据。
   *  - 配置写回（storageDir）由调用方在成功后进行，失败时配置仍指向旧目录、数据也还在旧目录。
   */
  setStorage(target: string): void {
    this.ensure()
    if (!target.trim()) throw new Error('便签存储目录不能为空')
    if (!isAbsolute(target.trim())) throw new Error('便签存储目录必须是绝对路径')
    const oldBase = notesBaseDir()
    const dir = resolve(target.trim())
    if (dir.replace(/[\\/]+$/, '').toLowerCase() === oldBase.replace(/[\\/]+$/, '').toLowerCase()) return
    let targetHasNotes = existsSync(join(dir, 'notes.json'))
    try {
      targetHasNotes = targetHasNotes || (existsSync(dir) && readdirSync(dir).some((f) => NOTE_SPLIT_RE.test(f)))
    } catch (err) {
      console.error('检查便签目标目录失败', err)
    }
    if (targetHasNotes) {
      throw new Error(`目标目录里已有便签数据，请换一个目录：${dir}`)
    }
    mkdirSync(dir, { recursive: true })

    const oldAssets = join(oldBase, 'notes-assets')
    const newAssets = join(dir, 'notes-assets')
    if (existsSync(oldAssets)) moveDir(oldAssets, newAssets)

    // 指向旧资产目录的文件类便签改写成新路径；不在旧目录下的便签不动
    for (const note of this.items) {
      if (note.kind !== 'file') continue
      const rel = relative(oldAssets, note.content)
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) continue
      note.content = join(newAssets, rel)
    }

    // 新目录按拆分格式落盘；此刻 notesBaseDir() 仍是旧目录（配置还没写回），所以显式传 dir
    writeSplitFiles(dir, this.items)

    const oldNotes = notesPath()
    try {
      if (existsSync(oldNotes)) renameSync(oldNotes, `${oldNotes}.bak`)
    } catch (err) {
      // 旧文件退备份失败不影响迁移结果，留着旧文件也只是多一份冗余
      console.error('便签迁移后处理旧文件失败', err)
    }
    try {
      for (const file of readdirSync(oldBase)) {
        if (NOTE_SPLIT_RE.test(file)) rmSync(join(oldBase, file), { force: true })
      }
    } catch (err) {
      console.error('便签迁移后清理旧拆分文件失败', err)
    }

    // 不重载内存：配置写回由调用方随后进行，此刻 notesPath()/notesBaseDir() 还指向旧目录，
    // 重载会读到刚被改名或清空的旧数据、把内存清空，界面从此显示为「无便签」。
    // 内存里的 items 与刚写出的新拆分文件完全一致，直接用即可。
    this.emit(CH.notesChanged, this.list())
  }

  private backup(): void {
    const p = notesPath()
    try {
      mkdirSync(join(p, '..'), { recursive: true })
      writeFileSync(`${p}.bak`, JSON.stringify(this.items, null, 2), 'utf-8')
    } catch (err) {
      console.error('写入便签备份失败', err)
    }
  }

  private flush(): void {
    const dir = notesBaseDir()
    try {
      mkdirSync(dir, { recursive: true })
      writeSplitFiles(dir, this.items)
    } catch (err) {
      console.error('写入便签失败', err)
    }
    this.emit(CH.notesChanged, this.list())
  }
}

/**
 * 按工作目录分组写拆分文件：每目录两个（非已完成 / 已完成），
 * 空组直接删文件；最后清掉本次不再有任何便签的孤儿拆分文件，
 * 否则删掉的便签会在下次启动时被旧文件复活。
 */
function writeSplitFiles(dir: string, items: Note[]): void {
  const groups = new Map<string, { open: Note[]; done: Note[] }>()
  for (const item of items) {
    const stem = noteFileStem(item.workDir)
    let group = groups.get(stem)
    if (!group) {
      group = { open: [], done: [] }
      groups.set(stem, group)
    }
    if (item.status === 'done') group.done.push(item)
    else group.open.push(item)
  }
  const keep = new Set<string>()
  for (const [stem, group] of groups) {
    const names = noteSplitNames(stem)
    keep.add(names.open)
    keep.add(names.done)
    writeSplitFile(join(dir, names.open), group.open)
    writeSplitFile(join(dir, names.done), group.done)
  }
  for (const file of readdirSync(dir)) {
    if (NOTE_SPLIT_RE.test(file) && !keep.has(file)) rmSync(join(dir, file), { force: true })
  }
}

/** 单个拆分文件：空组删文件，非空走「临时文件 + rename」原子替换 */
function writeSplitFile(path: string, items: Note[]): void {
  if (items.length === 0) {
    rmSync(path, { force: true })
    return
  }
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(items, null, 2), 'utf-8')
  renameSync(tmp, path)
}

/**
 * 移动目录：同盘符走 rename（瞬间完成），跨盘符或目标已存在时退化成「递归拷贝 + 删源」。
 * 拷贝是并入而不是先清空目标 —— 目标里若已有 notes-assets/（上一次用过这个目录），
 * 资产名带时间戳与随机串、撞名只会是同一份文件，不需要也不该删用户目录里的东西。
 */
function moveDir(from: string, to: string): void {
  try {
    renameSync(from, to)
    return
  } catch {
    cpSync(from, to, { recursive: true })
    rmSync(from, { recursive: true, force: true })
  }
}
