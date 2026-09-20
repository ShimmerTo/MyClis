import { useEffect, useState } from 'react'
// eslint-disable-next-line import/default
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Note, NoteAssetResult } from '@shared/types'
import { bytesText } from '../notes'
import { toast } from './ToastHost'

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(
    /^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/i,
    ''
  )
}

/**
 * 便签内容的预览。只按主进程给的 media 分支，渲染层不自己判断扩展名 ——
 * 判断口径只放在一处，才不会出现「同一个文件在一个面板能看、另一个说打不开」。
 */
export function NoteMedia({ note }: { note: Note }): JSX.Element {
  const [asset, setAsset] = useState<NoteAssetResult | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    setAsset(null)
    setError('')
    window.clichilds
      .notesAsset({ noteId: note.id })
      .then((value) => {
        if (alive) setAsset(value)
      })
      .catch((e: unknown) => {
        if (alive) setError(errorText(e))
      })
    return () => {
      alive = false
    }
  }, [note.id, note.content])

  if (error) return <div className="note-media-hint">{error}</div>
  if (!asset) return <div className="note-media-hint">读取中…</div>

  const open = (reveal: boolean): void => {
    void window.clichilds
      .notesOpenFile({ noteId: note.id, reveal })
      .catch((e: unknown) => toast(errorText(e)))
  }

  if (asset.reason === 'missing') {
    return (
      <div className="note-media">
        <p className="note-media-hint">文件已不存在（可能被移动、改名或删除）</p>
        <div className="note-media-path" title={asset.path}>
          {asset.path}
        </div>
      </div>
    )
  }

  const facts = (
    <div className="note-media-facts">
      <span className="note-media-path" title={asset.path}>
        {asset.path}
      </span>
      {asset.size !== undefined ? <span>{bytesText(asset.size)}</span> : null}
      <span className="spacer" />
      <button type="button" onClick={() => open(false)}>
        用系统默认程序打开
      </button>
      <button type="button" onClick={() => open(true)}>
        在资源管理器中定位
      </button>
    </div>
  )

  if (asset.reason === 'too-large') {
    return (
      <div className="note-media">
        <p className="note-media-hint">文件 {bytesText(asset.size)}，超过内联预览上限，未加载内容</p>
        {facts}
      </div>
    )
  }
  if (asset.reason === 'unreadable') {
    return (
      <div className="note-media">
        <p className="note-media-hint">文件读取失败</p>
        {facts}
      </div>
    )
  }

  if (asset.media === 'image' && asset.dataUrl) {
    return (
      <div className="note-media">
        <img src={asset.dataUrl} alt={note.title} />
      </div>
    )
  }

  if (asset.media === 'markdown') {
    return (
      <div className="note-media note-media-md">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          skipHtml
          components={{
            a: ({ href, children }) => (
              <a
                href={href}
                onClick={(e) => {
                  e.preventDefault()
                  if (href && /^https?:\/\//i.test(href)) void window.clichilds.externalOpen(href)
                }}
              >
                {children}
              </a>
            )
          }}
        >
          {asset.text ?? ''}
        </ReactMarkdown>
        {asset.truncated ? <p className="note-media-hint">只展示了文件的前一段</p> : null}
      </div>
    )
  }

  if (asset.media === 'text') {
    return (
      <div className="note-media">
        <pre className="note-media-text">{asset.text ?? ''}</pre>
        {asset.truncated ? <p className="note-media-hint">只展示了文件的前一段</p> : null}
      </div>
    )
  }

  // pdf 与 docx 都走自定义协议：pdf 交给 Chromium 内置查看器，docx 是主进程转好的 HTML。
  // 渲染不出来时留一个「用系统默认程序打开」的出口，功能不会因为协议受限而缺失。
  if ((asset.media === 'pdf' || asset.media === 'docx') && asset.url) {
    return (
      <div className="note-media">
        <iframe className="note-media-frame" src={asset.url} title={note.title} />
        <div className="note-media-facts">
          <span className="note-media-path" title={asset.path}>
            {asset.path}
          </span>
          <span>{bytesText(asset.size)}</span>
          <span className="spacer" />
          <button type="button" onClick={() => open(false)}>
            用系统默认程序打开
          </button>
        </div>
      </div>
    )
  }

  if (asset.media === 'url') {
    return (
      <div className="note-media">
        <div className="note-media-path" title={asset.url}>
          {asset.url}
        </div>
        <div className="note-media-facts">
          <span className="spacer" />
          <button
            type="button"
            onClick={() =>
              void window.clichilds
                .externalOpen(asset.url ?? '')
                .catch((e: unknown) => toast(errorText(e)))
            }
          >
            用浏览器打开
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="note-media">
      <p className="note-media-hint">这类文件不内联预览</p>
      {facts}
    </div>
  )
}
