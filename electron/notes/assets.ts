import { clipboard, protocol } from 'electron'
import { randomUUID } from 'crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'fs'
import { extname, isAbsolute, join, sep } from 'path'
import { fileURLToPath } from 'url'
import type { ClipboardPayload, Note, NoteAssetResult } from '../../shared/types'
import { notesAssetsDir } from './paths'

/** 自定义协议：只按 noteId 取路径，渲染层永远不向主进程传任意文件路径 */
const NOTE_SCHEME = 'clichilds-note'

/** 单侧体积上限，与 outputs/store.ts 的取值对齐 */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_TEXT_BYTES = 5 * 1024 * 1024
/** 文本类一次最多读这么多，超出只给前一段并标「已截断」 */
const TEXT_READ_BYTES = 1024 * 1024
const MAX_DOC_BYTES = 20 * 1024 * 1024

/** 本应用落盘的图片命名模式：清理时只认这种名字，绝不碰用户自己放进来的文件 */
const ASSET_NAME = /^note-\d+-[0-9a-f]{8}\.png$/i
/** 清理时跳过这么新的资产：刚粘贴进来的图片可能还没被便签写入 */
const ASSET_MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml'
}

const MARKDOWN_EXTS = new Set(['.md', '.markdown', '.mdx'])

const TEXT_EXTS = new Set([
  '.txt', '.log', '.json', '.jsonc', '.json5', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.env',
  '.xml', '.html', '.htm', '.css', '.scss', '.less', '.csv', '.tsv', '.sql', '.sh', '.bash', '.zsh', '.ps1',
  '.bat', '.cmd', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.c', '.h', '.cpp', '.hpp', '.cs', '.php',
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.vue', '.svelte', '.diff', '.patch', '.gitignore', '.editorconfig'
])

/** 已知的二进制：不去嗅探，直接给事实与打开按钮 */
const BINARY_EXTS = new Set([
  '.zip', '.7z', '.rar', '.tar', '.gz', '.bz2', '.xz', '.exe', '.dll', '.msi', '.so', '.dylib', '.bin',
  '.doc', '.xls', '.ppt', '.xlsx', '.pptx', '.mp3', '.mp4', '.avi', '.mov', '.mkv', '.wav', '.flac', '.woff', '.woff2', '.ttf', '.otf'
])

/**
 * 自定义协议必须在 app ready 之前登记为特权 scheme。
 * `bypassCSP` 是 PDF 能内联的前提之一（渲染层的 CSP 是 default-src 'self'，
 * 自定义 scheme 既不是 'self' 也不是 data:，不放行就会被拦）。
 */
export function registerNotesScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: NOTE_SCHEME,
      privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, bypassCSP: true }
    }
  ])
}

/**
 * ready 之后接管协议。URL 形如 `clichilds-note://note/<id>`：
 * 只按 id 从便签表里查路径 —— 渲染层拿不到「按路径读文件」的能力，
 * 否则便签正文里的路径就变成了任意文件读取入口。
 *
 * docx 也走这里（转成 HTML 再返回），而不是用 iframe 的 srcDoc ——
 * srcdoc 同样受 frame-src 约束，走协议才和 pdf 共用一条已放行的路径。
 */
export function installNotesProtocol(lookup: (id: string) => Note | undefined): void {
  protocol.handle(NOTE_SCHEME, async (request) => {
    try {
      const url = new URL(request.url)
      const id = url.hostname === 'note' ? decodeURIComponent(url.pathname.replace(/^\//, '')) : ''
      const note = id ? lookup(id) : undefined
      if (!note || note.kind !== 'file') return notFound()
      const file = note.content
      const stat = statSync(file)
      if (!stat.isFile() || stat.size > MAX_DOC_BYTES) return notFound()
      if (extname(file).toLowerCase() === '.docx') {
        return new Response(await docxToHtml(file), {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
        })
      }
      return new Response(readFileSync(file), {
        status: 200,
        headers: { 'Content-Type': mimeOf(file), 'Cache-Control': 'no-store' }
      })
    } catch {
      return notFound()
    }
  })
}

function notFound(): Response {
  return new Response('这个文件读不到或已不存在。', {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' }
  })
}

/**
 * docx 转 HTML，内嵌图片转成 data URL。
 * mammoth 是纯 CPU 的同步转换，体积上限必须在调用方卡住，否则大文档会把主进程整个卡住。
 */
async function docxToHtml(file: string): Promise<string> {
  type Mammoth = typeof import('mammoth')
  // mammoth 是 CJS（export =）：打包成 CJS 后 require 拿到的就是本体，
  // 但类型上仍可能是 namespace 形态，两种形状都兼容一下
  const loaded = (await import('mammoth')) as unknown as Mammoth & { default?: Mammoth }
  const mammoth = loaded.default ?? loaded
  const { value } = await mammoth.convertToHtml(
    { path: file },
    {
      convertImage: mammoth.images.imgElement(async (image) => ({
        src: `data:${image.contentType};base64,${await image.read('base64')}`
      }))
    }
  )
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:0;padding:14px;font:14px/1.6 system-ui,'Microsoft YaHei',sans-serif;color:#222;background:#fff}
    img{max-width:100%}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 8px}
  </style></head><body>${value}</body></html>`
}

function mimeOf(file: string): string {
  const ext = extname(file).toLowerCase()
  return IMAGE_MIME[ext] ?? (ext === '.pdf' ? 'application/pdf' : 'application/octet-stream')
}

/** 未知扩展名靠嗅探前 8KB 里有没有 NUL 来判文本还是二进制 */
function looksBinary(file: string): boolean {
  let fd: number | null = null
  try {
    fd = openSync(file, 'r')
    const buf = Buffer.alloc(8192)
    const read = readSync(fd, buf, 0, buf.length, 0)
    return buf.subarray(0, read).includes(0)
  } catch {
    return true
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

function readTextCapped(file: string, size: number): { text: string; truncated: boolean } {
  const cap = Math.min(size, TEXT_READ_BYTES)
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(cap)
    const read = readSync(fd, buf, 0, cap, 0)
    return { text: buf.subarray(0, read).toString('utf-8'), truncated: size > read }
  } finally {
    closeSync(fd)
  }
}

/**
 * 把一条便签解析成渲染层能直接画的东西。
 * 每个分支都带体积上限：主进程是同步读文件的，一个 300MB 的日志会把所有 IPC 与终端输出转发一起卡死。
 */
export function readNoteAsset(note: Note): NoteAssetResult {
  if (note.kind === 'url') return { media: 'url', url: note.content, path: note.content }

  const file = note.content
  let size = 0
  try {
    const stat = statSync(file)
    if (!stat.isFile()) return { media: 'binary', path: file, reason: 'missing' }
    size = stat.size
  } catch {
    return { media: 'binary', path: file, reason: 'missing' }
  }

  const ext = extname(file).toLowerCase()

  if (IMAGE_MIME[ext]) {
    if (size > MAX_IMAGE_BYTES) return { media: 'binary', path: file, size, reason: 'too-large' }
    try {
      const dataUrl = `data:${IMAGE_MIME[ext]};base64,${readFileSync(file).toString('base64')}`
      return { media: 'image', dataUrl, path: file, size }
    } catch {
      return { media: 'binary', path: file, size, reason: 'unreadable' }
    }
  }

  if (ext === '.pdf') {
    if (size > MAX_DOC_BYTES) return { media: 'binary', path: file, size, reason: 'too-large' }
    return { media: 'pdf', url: `${NOTE_SCHEME}://note/${note.id}`, path: file, size }
  }

  if (ext === '.docx') {
    if (size > MAX_DOC_BYTES) return { media: 'binary', path: file, size, reason: 'too-large' }
    // 真正的转换在协议处理里做，这里只把地址给渲染层，免得每次预览都把整份 HTML 塞进 IPC
    return { media: 'docx', url: `${NOTE_SCHEME}://note/${note.id}`, path: file, size }
  }

  if (MARKDOWN_EXTS.has(ext) || TEXT_EXTS.has(ext) || (!BINARY_EXTS.has(ext) && !looksBinary(file))) {
    if (size > MAX_TEXT_BYTES) return { media: 'binary', path: file, size, reason: 'too-large' }
    try {
      const { text, truncated } = readTextCapped(file, size)
      return { media: MARKDOWN_EXTS.has(ext) ? 'markdown' : 'text', text, path: file, size, truncated }
    } catch {
      return { media: 'binary', path: file, size, reason: 'unreadable' }
    }
  }

  return { media: 'binary', path: file, size }
}

/** 剪贴板里的图片落盘到持久目录，返回绝对路径 */
export function saveClipboardImage(): string | null {
  const image = clipboard.readImage()
  if (image.isEmpty()) return null
  const dir = notesAssetsDir()
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `note-${Date.now()}-${randomUUID().slice(0, 8)}.png`)
  writeFileSync(file, image.toPNG())
  return file
}

/**
 * 剪贴板里的文件路径。资源管理器复制文件走 CF_HDROP，只能用 FileNameW 这个自定义格式取，
 * 而且必须按 UTF-16 解码 —— clipboard.read('FileNameW') 会按 UTF-8 解成乱码。
 * text/uri-list 对「复制文件」这个场景基本无效，只当最后兜底。
 */
function clipboardFilePaths(): string[] {
  try {
    const buf = clipboard.readBuffer('FileNameW')
    if (buf && buf.length > 0) {
      const text = buf.toString('ucs2').replace(/^\uFEFF/, '')
      const paths = text
        .split('\u0000')
        .map((item) => item.trim())
        .filter((item) => !!item && isAbsolute(item) && existsSync(item))
      if (paths.length > 0) return paths
    }
  } catch {
    // 该格式不存在时继续往下兜底
  }
  try {
    return clipboard
      .read('text/uri-list')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith('file://'))
      .map((line) => {
        try {
          return fileURLToPath(line)
        } catch {
          return ''
        }
      })
      .filter((item) => !!item && existsSync(item))
  } catch {
    return []
  }
}

/**
 * 读一次剪贴板。优先级 文件 → 图片 → 文本：
 * 与终端粘贴的「图片优先」相反 —— 便签要的是地址而不是字节，
 * 而资源管理器复制图片文件时剪贴板同时带图片表示，按图片优先会复制出一份字节副本。
 */
export function readClipboardForNote(): ClipboardPayload {
  const files = clipboardFilePaths()
  if (files.length > 0) return { kind: 'files', paths: files }
  const image = saveClipboardImage()
  if (image) return { kind: 'image', path: image }
  const text = clipboard.readText()
  if (text.trim()) return { kind: 'text', text }
  return { kind: 'empty' }
}

/**
 * 清理 notes-assets/ 里已经没有便签引用的图片。
 *
 * 判定口径刻意收紧，因为便签的注入行为本身就在把这些路径传播到 CLI 会话与用户剪贴板里，
 * 它们已经不属于 notes.json 的引用集合 —— 绝不能实现成「不在便签里出现就删」：
 *   1. 只认本应用落盘的命名（note-<时间>-<8位十六进制>.png）
 *   2. 跳过 7 天内新建的（可能还没写进便签）
 *   3. realpath 之后必须仍在 notes-assets/ 内（防符号链接越界）
 *   4. 不在任何便签的 content 里出现（跨全部工作目录比对，realpath 后的小写全路径）
 *   5. dryRun 先只统计，由调用方展示数量与体积并二次确认
 */
export function cleanupUnusedAssets(notes: Note[], dryRun: boolean): { removed: number; bytes: number } {
  const dir = notesAssetsDir()
  let root = ''
  try {
    root = realpathSync(dir).toLowerCase()
  } catch {
    return { removed: 0, bytes: 0 }
  }
  const used = new Set<string>()
  for (const note of notes) {
    if (note.kind !== 'file') continue
    try {
      used.add(realpathSync(note.content).toLowerCase())
    } catch {
      // 引用的文件已经不在了：不算引用，但也不影响清理
    }
  }
  const cutoff = Date.now() - ASSET_MIN_AGE_MS
  let removed = 0
  let bytes = 0
  for (const name of readdirSync(dir)) {
    if (!ASSET_NAME.test(name)) continue
    let real = ''
    let size = 0
    let mtimeMs = 0
    try {
      real = realpathSync(join(dir, name))
      const stat = statSync(real)
      if (!stat.isFile()) continue
      size = stat.size
      mtimeMs = stat.mtimeMs
    } catch {
      continue
    }
    const key = real.toLowerCase()
    if (!key.startsWith(`${root}${sep}`)) continue
    if (mtimeMs > cutoff) continue
    if (used.has(key)) continue
    removed += 1
    bytes += size
    if (!dryRun) {
      try {
        rmSync(real, { force: true })
      } catch {
        removed -= 1
        bytes -= size
      }
    }
  }
  return { removed, bytes }
}
