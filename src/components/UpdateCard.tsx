import { useEffect, useState } from 'react'
import type { UpdateConfig } from '@shared/types'
import { Section } from './SettingsSections'
import { toast } from './ToastHost'
import { useUpdateState } from '../store'

interface Props {
  config: UpdateConfig
  onChange: (next: UpdateConfig) => void
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/i, '')
}

function publishDate(value?: string): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/**
 * 版本卡片：显示当前版本、GitHub 上的新版与其更新日志。
 * 日志正文只按原样换行展示，不渲染 Markdown —— 它是第三方 Release 的正文，当作不可信文本。
 */
export function UpdateCard({ config, onChange }: Props): JSX.Element {
  const state = useUpdateState()
  const [busy, setBusy] = useState<'check' | 'download' | 'install' | null>(null)
  const [expanded, setExpanded] = useState(false)
  const latest = state?.latest

  // 进到这一页就算看过：把版本号记下来，侧栏红点随之消失
  useEffect(() => {
    if (!latest || !state?.packaged) return
    if (latest.version === config.lastDismissedVersion) return
    window.clichilds.updateDismiss(latest.version).catch(() => undefined)
  }, [latest?.version, config.lastDismissedVersion, state?.packaged])

  const run = async (kind: 'check' | 'download' | 'install'): Promise<void> => {
    setBusy(kind)
    try {
      if (kind === 'check') {
        const next = await window.clichilds.updateCheck()
        toast(next.latest ? `发现新版本 ${next.latest.version}` : '已是最新版本')
      } else if (kind === 'download') await window.clichilds.updateDownload()
      else await window.clichilds.updateInstall()
    } catch (error) {
      toast(errorText(error))
    } finally {
      setBusy(null)
    }
  }

  const phase = state?.phase ?? 'idle'
  const notes = (latest?.notes ?? '').trim()
  const lines = notes ? notes.split('\n') : []
  const shownNotes = expanded || lines.length <= 8 ? lines.join('\n') : lines.slice(0, 8).join('\n')

  let status = '当前已是最新版本'
  if (!state?.packaged) status = '开发版不检测更新'
  else if (phase === 'downloading') status = '正在下载安装包…'
  else if (phase === 'failed') status = state?.error ?? '更新出错'
  else if (phase === 'ready' && state?.downloadedVersion) status = `${state.downloadedVersion} 已下载，启动应用时自动安装`
  else if (latest) status = `发现新版本 ${latest.version}`

  return (
    <Section
      title="版本与更新"
      hint="检测 GitHub 上的新版，可选择下载后下次启动自动安装"
      action={
        <button type="button" disabled={busy !== null || !state?.packaged} aria-busy={busy === 'check'} onClick={() => void run('check')}>
          {busy === 'check' ? '检查中…' : '检查更新'}
        </button>
      }
    >
      <div className="row">
        <label className="field">当前版本</label>
        <b>{state?.currentVersion ?? '—'}</b>
        <span className="hint">{state?.packaged ? '打包版' : '开发版'}</span>
      </div>
      <div className="row">
        <label className="field">更新状态</label>
        <span className={phase === 'failed' ? 'error' : 'hint'}>{status}</span>
      </div>
      {phase === 'downloading' && (
        <div className="row">
          <label className="field">下载进度</label>
          <progress className="update-progress" value={state?.progress ?? 0} max={1} />
          <span className="hint">{Math.round((state?.progress ?? 0) * 100)}%</span>
        </div>
      )}
      <div className="row">
        <label className="switch-field">
          <input
            type="checkbox"
            checked={config.autoDownload}
            onChange={(event) => onChange({ ...config, autoDownload: event.target.checked })}
          />
          自动下载新版本，下次启动时自动安装
        </label>
      </div>
      <div className="callout">
        检测到新版本后自动把安装包下载到数据目录；下次启动会直接拉起安装程序（静默安装）并关闭应用，不再弹确认。关闭时只在设置入口显示红点，需要手动点「下载更新」。升级不会改动会话历史、便签和已配置的 CLI。
      </div>
      {latest && (
        <div className="update-latest">
          <div className="row">
            <b>{latest.version}</b>
            <span className="hint">
              {publishDate(latest.publishedAt)}{latest.publishedAt ? ' 发布' : ''}
            </span>
            <span className="spacer" />
            {state?.downloadedVersion === latest.version ? (
              <button
                type="button"
                disabled={busy !== null}
                aria-busy={busy === 'install'}
                onClick={() => void run('install')}
              >
                {busy === 'install' ? '安装中…' : '立即安装'}
              </button>
            ) : (
              <button
                type="button"
                disabled={busy !== null}
                aria-busy={busy === 'download'}
                onClick={() => void run('download')}
              >
                {busy === 'download' ? '下载中…' : '下载更新'}
              </button>
            )}
            <button
              type="button"
              onClick={() => void window.clichilds.externalOpen(latest.releaseUrl).catch((error: unknown) => toast(errorText(error)))}
            >
              打开 Release
            </button>
          </div>
          {notes ? (
            <>
              <pre className="update-notes">{shownNotes}</pre>
              {lines.length > 8 && (
                <button className="link" onClick={() => setExpanded(!expanded)}>
                  {expanded ? '收起' : `展开全部 ${lines.length} 行`}
                </button>
              )}
            </>
          ) : (
            <div className="hint">该版本没有提供更新日志。</div>
          )}
        </div>
      )}
    </Section>
  )
}
