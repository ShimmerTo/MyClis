import { useEffect, useMemo, useState } from 'react'
import type { CSSProperties, MouseEvent as ReactMouseEvent } from 'react'
import { DiffModeEnum, DiffView } from '@git-diff-view/react'
import { generateDiffFile, getLang } from '@git-diff-view/file'
import '@git-diff-view/react/styles/diff-view-pure.css'
import type { ChangeFile, ChangeKind, GitDiffResult } from '@shared/types'
import { useDrawerHeight } from './useDrawerHeight'
import { useNoteMenu } from './NoteContextMenu'

/** 变更清单面板的状态挂在工作台里：状态栏入口与抽屉共用一份 */
export interface ChangesSession {
  /** 当前监听的工作目录；变更清单里的 path 是仓库根相对，解析绝对路径要用它 */
  workDir: string
  files: ChangeFile[]
  count: number
  open: boolean
  setOpen: (open: boolean) => void
  /** 整屏展示对比（盖住工作区，左侧树仍在，方便继续换文件） */
  maximized: boolean
  setMaximized: (maximized: boolean) => void
  selected: string
  select: (path: string) => void
  diff: GitDiffResult | null
  loading: boolean
  error: string
  /** false = 统一视图，true = 并排 */
  split: boolean
  setSplit: (split: boolean) => void
  /** 折叠的目录路径集合 */
  collapsed: Set<string>
  toggleDir: (path: string) => void
  /** 在资源管理器里定位该文件 */
  reveal: (path: string) => void
}

const BADGE: Record<ChangeKind, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
  conflicted: 'C',
  typechange: 'T'
}

const KIND_TITLE: Record<ChangeKind, string> = {
  modified: '已修改',
  added: '新增（已暂存）',
  deleted: '已删除',
  renamed: '重命名',
  untracked: '新文件（未跟踪）',
  conflicted: '有冲突',
  typechange: '类型变化'
}

function errorText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).replace(
    /^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/i,
    ''
  )
}

/**
 * 工作目录的 git 变更：主进程按 workDir 推清单（目录监听 + git status），
 * 这里只负责按当前工作目录过滤、选文件、取 diff。
 * 对比模式由调用方持有（存进配置，跨会话与重启都记得）。
 */
export function useChanges(workDir: string, split: boolean, setSplit: (split: boolean) => void): ChangesSession {
  const [files, setFiles] = useState<ChangeFile[]>([])
  const [open, setOpen] = useState(false)
  const [maximized, setMaximized] = useState(false)
  const [selected, setSelected] = useState('')
  const [diff, setDiff] = useState<GitDiffResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  useEffect(() => {
    setFiles([])
    setSelected('')
    setDiff(null)
    setError('')
    setMaximized(false)
    setCollapsed(new Set())
    if (!workDir) return
    let alive = true
    window.clichilds
      .gitChangesList(workDir)
      .then((list) => alive && setFiles(list))
      .catch(() => undefined)
    const off = window.clichilds.onGitChanges((payload) => {
      if (alive && payload.workDir === workDir) setFiles(payload.files)
    })
    return () => {
      alive = false
      off()
    }
  }, [workDir])

  // 选中的文件改回原样 / 被提交后就不在清单里了，清掉正文免得看到过期的 diff
  useEffect(() => {
    if (selected && !files.some((file) => file.path === selected)) setDiff(null)
  }, [files, selected])

  useEffect(() => {
    if (!selected) {
      setDiff(null)
      return
    }
    const file = files.find((item) => item.path === selected)
    let alive = true
    setLoading(true)
    setError('')
    window.clichilds
      .gitDiff({ workDir, path: selected, origPath: file?.origPath })
      .then((result) => alive && setDiff(result))
      .catch((e: unknown) => {
        if (!alive) return
        setDiff(null)
        setError(errorText(e))
      })
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [workDir, selected, files])

  const select = (path: string): void => {
    setSelected(path)
    setOpen(true)
  }

  const toggleDir = (path: string): void => {
    setCollapsed((old) => {
      const next = new Set(old)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const reveal = (path: string): void => {
    void window.clichilds.gitReveal({ workDir, path }).catch(() => undefined)
  }

  return {
    workDir,
    files,
    count: files.length,
    open,
    setOpen,
    maximized,
    setMaximized,
    selected,
    select,
    diff,
    loading,
    error,
    split,
    setSplit,
    collapsed,
    toggleDir,
    reveal
  }
}

/** 状态栏最右侧的变更入口；没有改动时不占位 */
export function ChangesTrigger({ session }: { session: ChangesSession }): JSX.Element | null {
  if (session.count === 0) return null
  return (
    <button
      className="output-trigger"
      title="查看工作目录的变更文件与改动内容"
      onClick={() => session.setOpen(!session.open)}
    >
      {session.count} 个文件变动
    </button>
  )
}

/* ---------------- 图标：统一细线 1px / 16px 网格，跟表头那组同风格 ---------------- */

function IconSplit(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <g fill="none" stroke="currentColor" strokeWidth="1">
        <rect x="2.5" y="3.5" width="11" height="9" rx="1" />
        <path d="M8 3.5v9" />
      </g>
    </svg>
  )
}

function IconUnified(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" fill="none" stroke="currentColor" strokeWidth="1" />
    </svg>
  )
}

/** 最大化：四角向外的箭头 */
function IconExpand(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" fill="none" stroke="currentColor" strokeWidth="1" />
    </svg>
  )
}

/** 还原：四角向内的箭头 */
function IconRestore(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path d="M6 2.5V6H2.5M13.5 6H10V2.5M10 13.5V10h3.5M2.5 10H6v3.5" fill="none" stroke="currentColor" strokeWidth="1" />
    </svg>
  )
}

/** 在资源管理器中打开：文件夹轮廓 */
function IconFolder(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path
        d="M2.5 12.5V4.5h4l1.3 1.8h5.7v6.2z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
        strokeLinejoin="round"
      />
    </svg>
  )
}

interface TreeNode {
  name: string
  path: string
  dir: boolean
  children: Map<string, TreeNode>
  file?: ChangeFile
}

/** 把扁平路径拼成目录树；目录在前、同层按名字排 */
function buildTree(files: ChangeFile[]): TreeNode {
  const root: TreeNode = { name: '', path: '', dir: true, children: new Map() }
  for (const file of files) {
    const parts = file.path.split('/')
    let node = root
    parts.forEach((part, index) => {
      const isFile = index === parts.length - 1
      let next = node.children.get(part)
      if (!next) {
        next = { name: part, path: parts.slice(0, index + 1).join('/'), dir: !isFile, children: new Map() }
        node.children.set(part, next)
      }
      if (isFile) next.file = file
      node = next
    })
  }
  return root
}

function sortedChildren(node: TreeNode): TreeNode[] {
  return [...node.children.values()].sort((a, b) => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

/**
 * 一个变更文件行。单独抽成组件是为了让每行都有自己的右键菜单（hooks 不能写在 map 里）：
 * 「复制路径」与「加入便签」都要绝对路径，而清单里的 path 是仓库根相对，
 * 只能交给主进程解析（工作目录可能是仓库的子目录，渲染层拼不出正确的根）。
 */
function ChangeFileRow({
  session,
  file,
  name,
  pad,
  active
}: {
  session: ChangesSession
  file: ChangeFile
  name: string
  pad: CSSProperties
  active: boolean
}): JSX.Element {
  const menu = useNoteMenu({
    workDir: session.workDir,
    target: { label: file.path, kind: 'file', relativePath: file.path }
  })
  return (
    <div
      className={`chg-row file ${active ? 'on' : ''}`}
      style={pad}
      role="button"
      tabIndex={0}
      title={`${KIND_TITLE[file.kind]} · ${file.path}（git: ${file.x}${file.y}）`}
      onClick={() => session.select(file.path)}
      onContextMenu={menu.onContextMenu}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          session.select(file.path)
        }
      }}
    >
      <span className={`chg-badge ${file.kind}`}>{BADGE[file.kind]}</span>
      <span className="chg-name">{name}</span>
      <span className="chg-actions">
        <button
          className="chg-act"
          title="整屏查看该文件的对比"
          onClick={(e) => {
            e.stopPropagation()
            session.select(file.path)
            session.setMaximized(true)
          }}
        >
          <IconExpand />
        </button>
        <button
          className="chg-act"
          title="在资源管理器中打开"
          onClick={(e) => {
            e.stopPropagation()
            session.reveal(file.path)
          }}
        >
          <IconFolder />
        </button>
      </span>
      {menu.menu}
    </div>
  )
}

/** 左侧目录树：文件行 hover 或选中时露出「最大化」「在资源管理器中打开」两个图标 */
function ChangeTree({ session }: { session: ChangesSession }): JSX.Element {
  const tree = useMemo(() => buildTree(session.files), [session.files])

  const renderNode = (node: TreeNode, depth: number): JSX.Element[] =>
    sortedChildren(node).flatMap((child) => {
      const pad = { paddingLeft: `${8 + depth * 14}px` }
      if (child.dir) {
        const folded = session.collapsed.has(child.path)
        return [
          <button
            key={`d:${child.path}`}
            className="chg-row dir"
            style={pad}
            title={child.path}
            onClick={() => session.toggleDir(child.path)}
          >
            <span className="chg-arrow">{folded ? '▸' : '▾'}</span>
            <span className="chg-name">{child.name}</span>
          </button>,
          ...(folded ? [] : renderNode(child, depth + 1))
        ]
      }
      const file = child.file
      // 文件节点一定带 file（buildTree 在最后一段上赋的），没有就说明树被改坏了
      if (!file) return []
      return [
        <ChangeFileRow
          key={`f:${child.path}`}
          session={session}
          file={file}
          name={child.name}
          pad={pad}
          active={file.path === session.selected}
        />
      ]
    })

  if (session.count === 0) {
    return (
      <nav className="output-list chg-list">
        <p className="hint" style={{ padding: 12 }}>
          工作目录暂无改动
        </p>
      </nav>
    )
  }

  return <nav className="output-list chg-list">{renderNode(tree, 0)}</nav>
}

/** 字节数按量级给人类可读值；读不到（文件已删除且 HEAD 里也没有）给 — */
function sizeText(bytes?: number): string {
  if (bytes === undefined) return '—'
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

/** 图片：内容栏直接画出来，底部一行挂绝对路径与大小 */
function ImagePreview({
  diff,
  onContextMenu
}: {
  diff: GitDiffResult
  onContextMenu: (event: ReactMouseEvent<HTMLElement>) => void
}): JSX.Element {
  const path = diff.absolutePath ?? diff.path
  return (
    <article className="output-preview chg-preview chg-image" onContextMenu={onContextMenu}>
      <img src={diff.dataUrl} alt={diff.path} />
      <div className="chg-fact-foot">
        <span className="chg-fact-val" title={path}>{path}</span>
        <span>{sizeText(diff.size)}</span>
      </div>
    </article>
  )
}

/**
 * 其它不可展示的文件（zip / tar.gz / 可执行文件…）：给绝对路径与大小；
 * 可执行的再补一行 git 记录的权限位 —— Windows 的 stat 恒为 100666，可执行标记只有 git 在记。
 */
function FileFacts({
  diff,
  onContextMenu
}: {
  diff: GitDiffResult
  onContextMenu: (event: ReactMouseEvent<HTMLElement>) => void
}): JSX.Element {
  const path = diff.absolutePath ?? diff.path
  return (
    <article className="output-preview chg-preview chg-facts" onContextMenu={onContextMenu}>
      <p className="hint">二进制文件，不显示差异</p>
      <div className="chg-fact">
        <span className="chg-fact-key">绝对路径</span>
        <span className="chg-fact-val" title={path}>{path}</span>
      </div>
      <div className="chg-fact">
        <span className="chg-fact-key">大小</span>
        <span className="chg-fact-val">{sizeText(diff.size)}</span>
      </div>
      {diff.mode === '100755' ? (
        <div className="chg-fact">
          <span className="chg-fact-key">权限</span>
          <span className="chg-fact-val">{diff.mode} · 可执行</span>
        </div>
      ) : null}
    </article>
  )
}

/** 右侧对比区：旧/新正文交给组件自己算差异；图片与非文本文件走上面两条支路 */
function DiffPane({ session, dark }: { session: ChangesSession; dark: boolean }): JSX.Element {
  const file = session.files.find((item) => item.path === session.selected)
  // 对比正文里选中一段也能直接进便签
  const menu = useNoteMenu({ workDir: session.workDir, selectionCopyLabel: '复制选中' })

  // 注意先 init + build：DiffView 拿到 diffFile 后走的是 _getFullBundle/_mergeFullBundle，
  // 没构建过的实例会报 "Invalid bundle data. Try calling the 'initRaw' function before merge / getBundle"。
  const diffFile = useMemo(() => {
    if (!session.diff) return null
    const lang = getLang(session.diff.path)
    const generated = generateDiffFile(
      file?.origPath ?? session.diff.path,
      session.diff.oldText,
      session.diff.path,
      session.diff.newText,
      lang,
      lang
    )
    generated.initTheme(dark ? 'dark' : 'light')
    generated.init()
    generated.buildSplitDiffLines()
    generated.buildUnifiedDiffLines()
    return generated
  }, [session.diff, file?.origPath, dark])

  if (session.error) return <p className="hint" style={{ padding: 24 }}>读取失败：{session.error}</p>
  if (!session.selected) return <p className="hint" style={{ padding: 24 }}>选择左侧文件查看改动</p>
  if (session.loading && !session.diff) return <p className="hint" style={{ padding: 24 }}>读取中…</p>
  if (!session.diff) return <p className="hint" style={{ padding: 24 }}>该文件没有可展示的改动</p>
  if (session.diff.dataUrl) return <ImagePreview diff={session.diff} onContextMenu={menu.onContextMenu} />
  if (session.diff.binary) return <FileFacts diff={session.diff} onContextMenu={menu.onContextMenu} />
  if (!diffFile) return <p className="hint" style={{ padding: 24 }}>该文件没有可展示的改动</p>

  return (
    <>
      <article className="output-preview chg-preview" onContextMenu={menu.onContextMenu}>
        <DiffView
          diffFile={diffFile}
          diffViewMode={session.split ? DiffModeEnum.Split : DiffModeEnum.Unified}
          diffViewTheme={dark ? 'dark' : 'light'}
          diffViewHighlight
          diffViewFontSize={12}
        />
      </article>
      {menu.menu}
    </>
  )
}

/** 表头右侧的控制组：视图切换 + 最大化/还原 */
function HeadControls({ session }: { session: ChangesSession }): JSX.Element {
  return (
    <>
      <button
        className="chg-mode"
        title={session.split ? '当前：并排，点击切换为统一视图' : '当前：统一，点击切换为并排视图'}
        onClick={() => session.setSplit(!session.split)}
      >
        {session.split ? <IconSplit /> : <IconUnified />}
      </button>
      <button
        className="chg-mode"
        title={session.maximized ? '还原到下方变更栏' : '整屏查看对比'}
        onClick={() => session.setMaximized(!session.maximized)}
      >
        {session.maximized ? <IconRestore /> : <IconExpand />}
      </button>
    </>
  )
}

/** 底部变更抽屉：左侧变更文件树，右侧 diff；结构对齐输出抽屉 */
export function ChangesDrawer({
  session,
  dark,
  savedHeight,
  onHeight
}: {
  session: ChangesSession
  dark: boolean
  /** 上次拖到的高度（px，来自配置） */
  savedHeight: number
  /** 松手时把最终高度交出去落盘 */
  onHeight: (height: number) => void
}): JSX.Element | null {
  const { height, resize } = useDrawerHeight(savedHeight, 160, 0.8, onHeight)
  if (!session.open || session.maximized) return null

  return (
    <section className="output-drawer changes-drawer" style={{ height }}>
      <div className="output-resizer" onPointerDown={resize} />
      <header className="output-head">
        <b>变更</b>
        <span className="hint">
          {session.count} 个文件
          {session.diff?.truncated ? ' · 正文过长已截断' : ''}
        </span>
        <span className="spacer" />
        <HeadControls session={session} />
        <button className="output-min" onClick={() => session.setOpen(false)} title="收起变更栏">
          —
        </button>
      </header>
      <div className="output-body">
        <ChangeTree session={session} />
        <DiffPane session={session} dark={dark} />
      </div>
    </section>
  )
}

/** 整屏对比：盖住工作区，树还在，方便连续看多个文件 */
export function ChangesMaxDrawer({ session, dark }: { session: ChangesSession; dark: boolean }): JSX.Element | null {
  if (!session.maximized) return null
  const current = session.files.find((item) => item.path === session.selected)
  return (
    <aside className="changes-max">
      <header className="output-head">
        <b>变更</b>
        <span className="hint" title={session.selected}>
          {current ? `${session.count} 个文件 · ${current.path}` : `${session.count} 个文件`}
        </span>
        <span className="spacer" />
        <HeadControls session={session} />
        <button className="output-min" onClick={() => session.setMaximized(false)} title="还原到下方变更栏">
          —
        </button>
      </header>
      <div className="output-body">
        <ChangeTree session={session} />
        <DiffPane session={session} dark={dark} />
      </div>
    </aside>
  )
}
