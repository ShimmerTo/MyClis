import { useEffect, useMemo, useState } from 'react'
// eslint-disable-next-line import/default
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { OutputArtifact, OutputBundle } from '@shared/types'
import { ipcErrorText } from '../notes'
import { useDrawerHeight } from './useDrawerHeight'
import { useNoteMenu } from './NoteContextMenu'
import { toast } from './ToastHost'
import { UrlPreview } from './UrlPreview'

interface PreviewContent {
  media: 'markdown' | 'image' | 'url'
  text?: string
  dataUrl?: string
}

export interface OutputItem {
  bundle: OutputBundle
  artifact: OutputArtifact
}

export interface OutputSession {
  sessionId: string | null
  bundles: OutputBundle[]
  items: OutputItem[]
  active?: OutputItem
  content: PreviewContent | null
  open: boolean
  /** 只更新入口计数，不再自动弹底部抽屉 */
  setOpen: (open: boolean) => void
  maximized: boolean
  setMaximized: (maximized: boolean) => void
  select: (artifactId: string) => void
  docCount: number
  urlCount: number
  hasOutputs: boolean
}

/** 输出文件的状态挂在工作台里：三处 UI 共用一份 */
export function useOutputSession(sessionId: string | null): OutputSession {
  const [bundles, setBundles] = useState<OutputBundle[]>([])
  const [open, setOpen] = useState(false)
  const [maximized, setMaximized] = useState(false)
  const [selected, setSelected] = useState('')
  const [content, setContent] = useState<PreviewContent | null>(null)
  const items = useMemo(
    () => bundles.flatMap((bundle) => bundle.artifacts.map((artifact) => ({ bundle, artifact }))),
    [bundles]
  )
  const active = items.find((item) => item.artifact.id === selected) ?? items[0]
  const docCount = useMemo(() => items.filter((item) => item.artifact.media !== 'url').length, [items])
  const urlCount = useMemo(() => items.filter((item) => item.artifact.media === 'url').length, [items])

  useEffect(() => {
    setBundles([])
    setOpen(false)
    setMaximized(false)
    setSelected('')
    if (!sessionId) return
    let alive = true
    window.clichilds
      .outputList(sessionId)
      .then((list) => {
        if (!alive) return
        setBundles(list)
        if (list.length > 0) setSelected(list.at(-1)?.artifacts[0]?.id ?? '')
      })
      .catch(() => undefined)
    const off = window.clichilds.onOutputsChanged((payload) => {
      if (!alive || payload.sessionId !== sessionId) return
      setBundles(payload.bundles)
      // 不再 setOpen(true)：只更新入口计数
      setSelected((current) => current || payload.bundles.at(-1)?.artifacts[0]?.id || '')
    })
    return () => {
      alive = false
      off()
    }
  }, [sessionId])

  useEffect(() => {
    let alive = true
    if (!sessionId || !active) {
      setContent(null)
      return () => { alive = false }
    }
    window.clichilds
      .outputRead({ sessionId, artifactId: active.artifact.id })
      .then((value) => alive && setContent(value))
      .catch(() => alive && setContent({ media: 'markdown', text: '输出文件已被移动、删除或无法读取。' }))
    return () => { alive = false }
  }, [sessionId, active?.artifact.id])

  return {
    sessionId,
    bundles,
    items,
    active,
    content,
    open,
    setOpen,
    maximized,
    setMaximized,
    select: setSelected,
    docCount,
    urlCount,
    hasOutputs: items.length > 0
  }
}

/** 状态栏最右侧的输出入口；没有输出文件时不占位。计数用「图标 + 数字」，与变更入口同口径 */
export function OutputTrigger({ session }: { session: OutputSession }): JSX.Element | null {
  if (!session.hasOutputs) return null
  const parts: string[] = []
  if (session.docCount > 0) parts.push(`${session.docCount} 个文档`)
  if (session.urlCount > 0) parts.push(`${session.urlCount} 个网址`)
  return (
    <button
      className="output-trigger status-pill"
      title={`查看 CLI 产出的${parts.join(' · ')}`}
      onClick={() => session.setOpen(!session.open)}
    >
      {session.docCount > 0 ? (
        <>
          <IconDoc />
          <span className="status-count">{session.docCount}</span>
        </>
      ) : null}
      {session.urlCount > 0 ? (
        <>
          {session.docCount > 0 ? <span className="status-sep">·</span> : null}
          <IconLink />
          <span className="status-count">{session.urlCount}</span>
        </>
      ) : null}
    </button>
  )
}

function IconDoc(): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.1"
      strokeLinejoin="round"
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M3.5 2.5h6.6l2.4 2.4v8.6H3.5z" />
      <path d="M10 2.6v2.6h2.5" />
      <path d="M5.8 7.6h4.4M5.8 10h3" />
    </svg>
  )
}

function IconLink(): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.1"
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="8" cy="8" r="6.1" strokeWidth="1.1" />
      <path d="M1.9 8h12.2M8 1.9c1.9 1.9 1.9 10.3 0 12.2M8 1.9c-1.9 1.9-1.9 10.3 0 12.2" strokeWidth="0.9" />
    </svg>
  )
}

function IconFolder(): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.1"
      strokeLinejoin="round"
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M2.3 4h3.6l1.3 1.7h6.5v6.4H2.3z" />
    </svg>
  )
}

function Empty({ art }: { art: OutputItem }): JSX.Element {
  return (
    <div className="output-preview">
      <p className="hint" style={{ padding: 48, textAlign: 'center' }}>
        不可预览：{art.artifact.media === 'url' ? '不支持内联预览的网址' : '不支持的格式'}
      </p>
    </div>
  )
}

/** 列表第二行：产生该产物的 CLI 名与模型；模型没配就显示「默认」 */
function producerLine(bundle: OutputBundle): string {
  return `${bundle.producer.cliLabel} - ${bundle.producer.model ?? '默认'}`
}

const TIME_OPTS: Intl.DateTimeFormatOptions = {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false
}

/** 该产物发布时间：列表第二行尾部展示，悬停看完整时间 */
function publishedAt(bundle: OutputBundle): string {
  return new Date(bundle.createdAt).toLocaleString('zh-CN', TIME_OPTS)
}

/**
 * 产出列表的一行。单独抽成组件是为了让每行都能用自己的右键菜单
 * （hooks 不能写在 map 里）：产物路径已是绝对路径，直接存，不再过 pathResolve。
 */
function OutputRow({
  session,
  bundle,
  artifact
}: {
  session: OutputSession
  bundle: OutputBundle
  artifact: OutputArtifact
}): JSX.Element {
  const menu = useNoteMenu({
    workDir: bundle.workDir,
    target: {
      label: artifact.label,
      kind: artifact.media === 'url' ? 'url' : 'file',
      content: artifact.path
    }
  })
  return (
    <div
      className={`output-item ${artifact.id === session.active?.artifact.id ? 'active' : ''}`}
      onContextMenu={menu.onContextMenu}
    >
      <button
        className="output-pick"
        onClick={() => session.select(artifact.id)}
        title={artifact.path}
      >
        <span>
          {bundle.source === 'reviewer' && <em className="output-src" title="子 CLI 输出">子</em>}
          {artifact.media === 'url' ? '🌐' : artifact.media === 'image' ? '▧' : '≡'} {artifact.label}
        </span>
        <small title={new Date(bundle.createdAt).toLocaleString()}>{producerLine(bundle)} · {publishedAt(bundle)}</small>
      </button>
      {artifact.media === 'url' ? (
        <button
          className="output-row-act"
          title="在浏览器中打开"
          onClick={(e) => {
            e.stopPropagation()
            void window.clichilds.externalOpen(artifact.path)
          }}
        >
          ↗
        </button>
      ) : (
        <button
          className="output-row-act"
          title="打开所属文件夹"
          onClick={(e) => {
            e.stopPropagation()
            void window.clichilds
              .outputReveal({ sessionId: session.sessionId ?? '', artifactId: artifact.id })
              .catch((error: unknown) => toast(ipcErrorText(error)))
          }}
        >
          <IconFolder />
        </button>
      )}
      {menu.menu}
    </div>
  )
}

/** 底部输出抽屉：左侧文件列表，右侧预览，最小化图标在标题栏最右侧 */
export function OutputDrawer({
  session,
  savedHeight,
  onHeight
}: {
  session: OutputSession
  /** 上次拖到的高度（px，来自配置） */
  savedHeight: number
  /** 松手时把最终高度交出去落盘 */
  onHeight: (height: number) => void
}): JSX.Element | null {
  const { height, resize } = useDrawerHeight(savedHeight, 180, 0.7, onHeight)
  const [query, setQuery] = useState('')
  const previewMenu = useNoteMenu({
    workDir: session.active?.bundle.workDir,
    selectionCopyLabel: '复制选中'
  })
  if (!session.open || !session.active) return null

  const keyword = query.trim().toLowerCase()
  const visible = keyword
    ? session.items.filter(({ bundle, artifact }) => {
        const haystack = `${artifact.label}\n${artifact.path}\n${producerLine(bundle)}`.toLowerCase()
        return haystack.includes(keyword)
      })
    : session.items

  return (
    <section className="output-drawer" style={{ height }}>
      <div className="output-resizer" onPointerDown={resize} />
      <header className="output-head">
        <b>输出</b>
        <span className="hint">{session.bundles.length} 组 · {session.docCount} 文档{session.urlCount > 0 ? ` · ${session.urlCount} 网址` : ''}</span>
        <span className="spacer" />
        <button className="output-min" onClick={() => session.setOpen(false)} title="收起输出栏">
          —
        </button>
      </header>
      <div className="output-body">
        <nav className="output-list">
          <div className="output-search">
            <input
              type="search"
              placeholder="搜索输出…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          {visible.map(({ bundle, artifact }) => (
            <OutputRow key={artifact.id} session={session} bundle={bundle} artifact={artifact} />
          ))}
          {visible.length === 0 && <p className="hint output-search-empty">没有匹配的输出</p>}
        </nav>
        <article className="output-preview" onContextMenu={previewMenu.onContextMenu}>
          <PreviewContentArea session={session} />
        </article>
        {previewMenu.menu}
      </div>
    </section>
  )
}

/** 右侧最大化抽屉：占满高度展示当前文档，最小化图标同样在最右侧 */
export function OutputMaxDrawer({ session }: { session: OutputSession }): JSX.Element | null {
  const previewMenu = useNoteMenu({
    workDir: session.active?.bundle.workDir,
    selectionCopyLabel: '复制选中'
  })
  if (!session.maximized || !session.active) return null
  return (
    <aside className="output-max">
      <header className="output-head">
        <b>{session.active.artifact.label}</b>
        <span className="hint" title={session.active.artifact.path}>
          {producerLine(session.active.bundle)}
        </span>
        <span className="spacer" />
        <button className="output-min" onClick={() => session.setMaximized(false)} title="收起">
          —
        </button>
      </header>
      <article className="output-preview" onContextMenu={previewMenu.onContextMenu}>
        <PreviewContentArea session={session} />
      </article>
      {previewMenu.menu}
    </aside>
  )
}

function PreviewContentArea({ session }: { session: OutputSession }): JSX.Element {
  const content = session.content
  const active = session.active
  const [zoom, setZoom] = useState<{ src: string; alt: string } | null>(null)
  if (!content || !active) return <div className="hint" style={{ padding: 24 }}>读取中…</div>
  const lightbox = zoom ? <ImageZoom src={zoom.src} alt={zoom.alt} onClose={() => setZoom(null)} /> : null

  if (content.media === 'url') {
    const url = content.text ?? active.artifact.path
    if (!url) return <Empty art={active} />
    return <UrlPreview url={url} title={active.artifact.label} />
  }

  if (content.media === 'image' && content.dataUrl) {
    const src = content.dataUrl
    return (
      <>
        <img
          className="output-zoomable"
          src={src}
          alt={active.artifact.label}
          title="点击放大"
          onClick={() => setZoom({ src, alt: active.artifact.label })}
        />
        {lightbox}
      </>
    )
  }

  return (
    <>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ href, children }) => (
            <a href={href} onClick={(e) => {
              e.preventDefault()
              if (href && /^https?:\/\//i.test(href)) void window.clichilds.externalOpen(href)
            }}>{children}</a>
          ),
          img: ({ src, alt }) => (
            <MdImage
              sessionId={session.sessionId ?? ''}
              artifactId={active.artifact.id}
              src={src}
              alt={alt}
              onZoom={(url) => setZoom({ src: url, alt: alt ?? active.artifact.label })}
            />
          )
        }}
      >
        {content.text ?? '读取中…'}
      </ReactMarkdown>
      {lightbox}
    </>
  )
}

/** 点开的图片：覆盖整窗，点任意处或按 Esc 关闭 */
function ImageZoom({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="image-zoom" title="点击任意处关闭" onClick={onClose}>
      <img src={src} alt={alt} />
    </div>
  )
}

/** Markdown 内的图片经主进程做工作目录边界校验后返回 data URL，renderer 不碰 file:// */
function MdImage(props: {
  sessionId: string
  artifactId: string
  src?: string
  alt?: string
  onZoom: (url: string) => void
}): JSX.Element {
  const [state, setState] = useState<{ url?: string; error?: string }>({})
  useEffect(() => {
    let alive = true
    if (!props.artifactId || !props.src) {
      setState({ error: '缺少图片路径' })
      return () => { alive = false }
    }
    setState({})
    window.clichilds.outputAsset({ sessionId: props.sessionId, artifactId: props.artifactId, src: props.src })
      .then((value) => alive && setState({ url: value.dataUrl }))
      .catch((e: unknown) => {
        if (!alive) return
        const message = (e instanceof Error ? e.message : String(e))
          .replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/i, '')
        setState({ error: message })
      })
    return () => { alive = false }
  }, [props.sessionId, props.artifactId, props.src])
  if (state.url) {
    const url = state.url
    return (
      <img
        className="output-zoomable"
        src={url}
        alt={props.alt ?? ''}
        title="点击放大"
        onClick={() => props.onZoom(url)}
      />
    )
  }
  return (
    <span className="md-image-hint">
      [图片：{props.alt || props.src || '未知'}{state.error ? ` · ${state.error}` : ' 解析中…'}]
    </span>
  )
}