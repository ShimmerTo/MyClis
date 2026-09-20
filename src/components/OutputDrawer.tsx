import { useEffect, useMemo, useState } from 'react'
// eslint-disable-next-line import/default
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { OutputArtifact, OutputBundle } from '@shared/types'
import { useDrawerHeight } from './useDrawerHeight'
import { useNoteMenu } from './NoteContextMenu'

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

/** 状态栏最右侧的输出入口；没有输出文件时不占位 */
export function OutputTrigger({ session }: { session: OutputSession }): JSX.Element | null {
  if (!session.hasOutputs) return null
  const parts: string[] = []
  if (session.docCount > 0) parts.push(`${session.docCount} 个文档`)
  if (session.urlCount > 0) parts.push(`${session.urlCount} 个网址`)
  return (
    <button
      className="output-trigger"
      title="查看 CLI 产出的文档与网址"
      onClick={() => session.setOpen(!session.open)}
    >
      {parts.join(' · ')}
    </button>
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
        <span>{artifact.media === 'url' ? '🌐' : artifact.media === 'image' ? '▧' : '≡'} {artifact.label}</span>
        <small>{bundle.title}</small>
      </button>
      {artifact.media === 'url' && (
        <button
          className="output-url-open"
          title="在浏览器中打开"
          onClick={(e) => {
            e.stopPropagation()
            void window.clichilds.externalOpen(artifact.path)
          }}
        >
          ↗
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
  const previewMenu = useNoteMenu({
    workDir: session.active?.bundle.workDir,
    selectionCopyLabel: '复制选中'
  })
  if (!session.open || !session.active) return null

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
          {session.items.map(({ bundle, artifact }) => (
            <OutputRow key={artifact.id} session={session} bundle={bundle} artifact={artifact} />
          ))}
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
          {session.active.bundle.title}
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
  if (!content || !active) return <div className="hint" style={{ padding: 24 }}>读取中…</div>

  if (content.media === 'url') {
    const url = content.text ?? active.artifact.path
    if (!url) return <Empty art={active} />
    if (/^(https?:\/\/)/.test(url)) {
      return (
        <div className="output-url-frame">
          <iframe
            src={url}
            title={active.artifact.label}
            sandbox="allow-scripts allow-forms allow-popups"
            referrerPolicy="no-referrer"
            onError={() => null}
          />
          <div className="output-url-bar">
            <span className="hint" title={url}>{url}</span>
          </div>
        </div>
      )
    }
    return <Empty art={active} />
  }

  if (content.media === 'image' && content.dataUrl) {
    return <img src={content.dataUrl} alt={active.artifact.label} />
  }

  return (
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
          <MdImage sessionId={session.sessionId ?? ''} artifactId={active.artifact.id} src={src} alt={alt} />
        )
      }}
    >
      {content.text ?? '读取中…'}
    </ReactMarkdown>
  )
}

/** Markdown 内的图片经主进程做工作目录边界校验后返回 data URL，renderer 不碰 file:// */
function MdImage(props: {
  sessionId: string
  artifactId: string
  src?: string
  alt?: string
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
  if (state.url) return <img src={state.url} alt={props.alt ?? ''} />
  return (
    <span className="md-image-hint">
      [图片：{props.alt || props.src || '未知'}{state.error ? ` · ${state.error}` : ' 解析中…'}]
    </span>
  )
}