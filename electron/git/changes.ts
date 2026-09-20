import { execFile } from 'child_process'
import { closeSync, openSync, readSync, statSync, watch, type FSWatcher } from 'fs'
import { join } from 'path'
import { CH, type ChangeFile, type ChangeKind, type GitDiffResult } from '../../shared/types'
import { isImagePath, toDataUrl } from '../media'

/**
 * 变更清单上限：没写 .gitignore 的大目录（构建产物、依赖）不至于把一次 IPC 撑爆。
 * 真到了这个量级，用户要看的是 .gitignore，不是逐行滚动。
 */
const MAX_FILES = 2000

/** diff 单侧正文上限：超过只给前一段，避免渲染层被巨型文件卡死 */
const MAX_DIFF_BYTES = 1_000_000

/** 图片预览上限：超过就只给路径与大小，不把 base64 塞进 IPC */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024

/**
 * 这些目录里的写入一律不触发重算：node_modules 在装依赖时会刷屏。
 * 只做触发过滤，最终清单仍以 git status 为准，所以不会漏报已跟踪文件。
 */
const NOISE = new Set(['node_modules'])

/**
 * `.git` 下要放行的状态文件：提交、切分支、合并、reset、stash 都会写它们。
 * 整块丢掉 `.git` 的话，用户在终端里 commit 完，底部的「N 个文件变动」会一直停在旧数字上。
 */
const GIT_STATE = new Set(['HEAD', 'ORIG_HEAD', 'packed-refs', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'])
/** `.git` 下按目录放行的（refs/heads/master 这类），rebase 的中间状态也在这些目录里 */
const GIT_STATE_DIRS = new Set(['refs', 'rebase-merge', 'rebase-apply'])
/**
 * `.git` 下明确要丢的：objects / logs 事件量巨大；
 * index 不能放行 —— `git status` 自己会回写它（刷新 stat 缓存），放行就成了「重算触发重算」的自激循环。
 * 代价是 `git add` 单独执行时不会刷新（紧接着的 commit 会写 refs，那一步能补上）。
 */
const GIT_IGNORE = new Set(['objects', 'logs', 'index', 'index.lock'])

/** git 命令统一出口；失败（含 git 不存在）抛错由调用方兜底 */
function git(args: string[], cwd: string, timeout = 8000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (err, stdout) => (err ? reject(err) : resolve(stdout))
    )
  })
}

/**
 * 路径是否该跳过。node_modules 里任意一段命中就跳过；
 * `.git` 里只放行状态文件与 refs，其余（objects / logs / index…）都当噪声。
 */
function isNoise(relPath: string): boolean {
  const segments = relPath.split(/[\\/]/)
  if (segments.some((segment) => NOISE.has(segment))) return true
  const dotGit = segments.indexOf('.git')
  if (dotGit < 0) return false
  const rest = segments.slice(dotGit + 1)
  if (rest.length === 0) return true
  const [head, ...tail] = rest
  if (GIT_IGNORE.has(head)) return true
  if (GIT_STATE_DIRS.has(head)) return false
  return !(GIT_STATE.has(head) && tail.length === 0)
}

/**
 * 行尾归一化：Windows 检出普遍是 CRLF，而 git 对象里存的是 LF（autocrlf），
 * 不归一化就是"每一行都不一样"，整个文件会显示成全删全增。
 * 归一后两侧都是 LF，差异才是真正的差异。
 */
function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

/** 只取 UI 需要的粗分类；`??` 之外的组合都归到 modified */
function kindOf(x: string, y: string): ChangeKind | null {
  const pair = x + y
  if (pair === '??') return 'untracked'
  if (pair === '!!') return null
  if (x === 'U' || y === 'U' || pair === 'AA' || pair === 'DD') return 'conflicted'
  if (x === 'R' || y === 'R') return 'renamed'
  if (x === 'A' || y === 'A') return 'added'
  if (x === 'D' || y === 'D') return 'deleted'
  if (x === 'T' || y === 'T') return 'typechange'
  return 'modified'
}

/**
 * 解析 `git status --porcelain=v1 -z`：条目以 NUL 分隔，
 * 重命名/复制占两项（先新路径，后原路径），路径一律相对仓库根。
 */
export function parsePorcelain(out: string): ChangeFile[] {
  const tokens = out.split('\0')
  const files: ChangeFile[] = []
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (token.length < 4) continue
    const x = token[0]
    const y = token[1]
    const path = token.slice(3)
    const kind = kindOf(x, y)
    if (!kind) continue
    const file: ChangeFile = { path, x, y, kind }
    if (kind === 'renamed' || x === 'C' || y === 'C') {
      const orig = tokens[i + 1]
      if (orig) {
        file.origPath = orig
        i += 1
      }
    }
    files.push(file)
    if (files.length >= MAX_FILES) break
  }
  return files
}

interface Entry {
  workDir: string
  refs: number
  watcher?: FSWatcher
  timer?: NodeJS.Timeout
  files: ChangeFile[]
}

/**
 * 工作目录变更服务。
 *
 * 清单以 `git status` 为准（天然遵守 .gitignore，能区分新增/删除/重命名/冲突），
 * 目录监听只当"该重算了"的触发器：只用 fs.watch 自己攒文件列表会把忽略规则、
 * 构建产物、编辑器的临时写盘全算进来，噪声大且判定不出新增还是删除。
 *
 * 生命周期跟着主会话走：主终端拉起时 track，退出时 untrack（同一目录多开按引用计数）。
 */
export class ChangesService {
  private entries = new Map<string, Entry>()
  private roots = new Map<string, string | null>()

  constructor(private send: (channel: string, payload: unknown) => void) {}

  /** 主终端拉起：开始监听该工作目录 */
  track(workDir: string): void {
    const key = workDir
    const existing = this.entries.get(key)
    if (existing) {
      existing.refs += 1
      return
    }
    // 每次重新盯一个目录都重新解析仓库根：中途 git init 的目录不该一直算作非仓库
    this.roots.delete(key)
    const entry: Entry = { workDir: key, refs: 1, files: [] }
    this.entries.set(key, entry)
    try {
      const watcher = watch(key, { recursive: true, persistent: false }, (_event, filename) => {
        if (filename && isNoise(String(filename))) return
        this.schedule(entry)
      })
      watcher.on('error', () => {
        // 目录被删/无权限：监听失效，但不影响手动刷新
      })
      entry.watcher = watcher
    } catch {
      // 目录不存在或平台不支持递归监听：退化成只在打开时算一次
    }
    void this.refresh(entry)
  }

  /** 主终端退出：最后一个引用没了就停监听 */
  untrack(workDir: string): void {
    const entry = this.entries.get(workDir)
    if (!entry) return
    entry.refs -= 1
    if (entry.refs > 0) return
    entry.watcher?.close()
    if (entry.timer) clearTimeout(entry.timer)
    this.entries.delete(workDir)
  }

  /** 不依赖进度的即时查询：切标签/新建抽屉时先拿一份，别等 watcher */
  async list(workDir: string): Promise<ChangeFile[]> {
    const files = await this.compute(workDir)
    const entry = this.entries.get(workDir)
    if (entry) entry.files = files
    return files
  }

  /**
   * 单文件改动前后全文：old 取 HEAD，new 取工作区。
   * 顺带把「非文本文件也要能看」的元信息一起带回去：绝对路径、字节数、git 记录的权限位，
   * 图片再给一份 data URL —— 渲染层拿不到工作区文件，只能由这里给。
   */
  async diff(workDir: string, path: string, origPath?: string): Promise<GitDiffResult> {
    const root = await this.root(workDir)
    if (!root) return { path, oldText: '', newText: '' }
    const absolutePath = join(root, ...path.split('/'))

    const oldPath = origPath ?? path
    let oldText = ''
    try {
      oldText = await git(['show', `HEAD:${oldPath}`], root)
    } catch {
      // 新增文件 / 未跟踪文件在 HEAD 里没有对应项
      oldText = ''
    }

    let newText = ''
    let binary = false
    let truncated = false
    let size: number | undefined
    try {
      const stat = statSync(absolutePath)
      if (stat.isFile()) {
        size = stat.size
        const readBytes = Math.min(stat.size, MAX_DIFF_BYTES)
        truncated = stat.size > MAX_DIFF_BYTES
        const buffer = Buffer.alloc(readBytes)
        const fd = openSync(absolutePath, 'r')
        try {
          readSync(fd, buffer, 0, readBytes, 0)
        } finally {
          closeSync(fd)
        }
        binary = buffer.subarray(0, 8000).includes(0)
        newText = binary ? '' : buffer.toString('utf8')
      }
    } catch {
      // 已删除的文件读不到：正文给空（diff 显示为整段删除），大小回落到 HEAD 里那份
      newText = ''
      size = await this.headSize(root, oldPath)
    }

    const mode = await this.indexMode(root, path)
    const dataUrl = await this.imageDataUrl(absolutePath, path)

    if (Buffer.byteLength(oldText) > MAX_DIFF_BYTES) {
      oldText = oldText.slice(0, MAX_DIFF_BYTES)
      truncated = true
    }

    return {
      path,
      oldText: normalizeEol(oldText),
      newText: normalizeEol(newText),
      binary: binary || undefined,
      truncated: truncated || undefined,
      absolutePath,
      size,
      mode,
      dataUrl
    }
  }

  /** 文件在磁盘上的绝对路径：清单里的 path 是仓库根相对 */
  async resolvePath(workDir: string, path: string): Promise<string> {
    const root = await this.root(workDir)
    return join(root ?? workDir, ...path.split('/'))
  }

  /**
   * git 记录的权限位：100644 普通 / 100755 可执行 / 120000 符号链接。
   * Windows 上 stat 的 mode 恒为 100666（连 .exe 也没有执行位），仓库里真正的可执行标记只有 git 在记。
   * 未跟踪文件在 index 里没有记录，返回 undefined。
   */
  private async indexMode(root: string, path: string): Promise<string | undefined> {
    try {
      const out = await git(['ls-files', '-s', '--', path], root)
      const mode = out.split(/\s+/)[0]
      return /^\d{6}$/.test(mode) ? mode : undefined
    } catch {
      return undefined
    }
  }

  /** 已删除的文件读不到工作区，大小回落到 HEAD 里那份 */
  private async headSize(root: string, path: string): Promise<number | undefined> {
    try {
      const out = await git(['cat-file', '-s', `HEAD:${path}`], root)
      const size = Number.parseInt(out.trim(), 10)
      return Number.isFinite(size) ? size : undefined
    } catch {
      return undefined
    }
  }

  /** 图片给一份 data URL 让渲染层直接画；非图片、读不到或超上限都不给 */
  private async imageDataUrl(absolutePath: string, path: string): Promise<string | undefined> {
    if (!isImagePath(path)) return undefined
    try {
      const stat = statSync(absolutePath)
      if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) return undefined
      return toDataUrl(absolutePath)
    } catch {
      // 已删除 / 读不动：退化成只给路径与大小
      return undefined
    }
  }

  private async root(workDir: string): Promise<string | null> {
    if (this.roots.has(workDir)) return this.roots.get(workDir) ?? null
    let root: string | null = null
    try {
      root = (await git(['rev-parse', '--show-toplevel'], workDir)).trim() || null
    } catch {
      root = null
    }
    this.roots.set(workDir, root)
    return root
  }

  /** 以工作目录为范围（含子目录）取清单：路径仍是仓库根相对 */
  private async compute(workDir: string): Promise<ChangeFile[]> {
    try {
      const out = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.'], workDir)
      return parsePorcelain(out).sort((a, b) => a.path.localeCompare(b.path))
    } catch {
      return []
    }
  }

  /** 防抖：排队期间来的事件不必单独记账，那次重算发生在触发之后，天然看得到最新状态 */
  private schedule(entry: Entry): void {
    if (entry.timer) return
    entry.timer = setTimeout(() => {
      entry.timer = undefined
      void this.refresh(entry)
    }, 350)
  }

  private async refresh(entry: Entry): Promise<void> {
    if (!this.entries.has(entry.workDir)) return
    const files = await this.compute(entry.workDir)
    entry.files = files
    // 每次都推：清单可能一字未变，但文件正文变了，渲染层要刷新右侧 diff。
    // 真正的写入已经过了 350ms 防抖，这里的频率就是"一轮编辑"的频率。
    this.send(CH.gitChanges, { workDir: entry.workDir, files })
  }
}
