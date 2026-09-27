import { ipcErrorText } from '../notes'
import { toast } from './ToastHost'

export function UrlPreview({ url, title }: { url: string; title: string }): JSX.Element {
  let valid = false
  try {
    valid = ['http:', 'https:'].includes(new URL(url).protocol)
  } catch {
    valid = false
  }
  if (!valid) return <div className="hint">无法预览这个网址，仅支持 HTTP 和 HTTPS。</div>
  return (
    <div className="url-preview">
      <iframe src={url} title={title || '网页预览'} sandbox="allow-scripts allow-forms" referrerPolicy="no-referrer" />
      <div className="url-preview-tools">
        <span className="hint">若网站禁止内嵌，请用浏览器打开。</span>
        <button type="button" onClick={() => {
          void window.clichilds.externalOpen(url).catch((error: unknown) => toast(ipcErrorText(error)))
        }}>用浏览器打开</button>
      </div>
    </div>
  )
}
