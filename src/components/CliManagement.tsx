import { useEffect, useState } from 'react'
import type { CliId, CliStatus } from '@shared/types'
import { adoptCliStatus, refreshCliStatuses } from '../store'
import { ipcErrorText } from '../notes'
import { toast } from './ToastHost'

const pending = new Set<CliId>()
const listeners = new Set<() => void>()
const notify = (): void => { for (const listener of listeners) listener() }

export function CliManagement({ status }: { status: CliStatus }): JSX.Element {
  const [, update] = useState(0)
  const [error, setError] = useState('')
  const [checking, setChecking] = useState(false)
  useEffect(() => {
    const listener = (): void => update((value) => value + 1)
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }, [])
  const busy = pending.has(status.id)
  const manage = async (): Promise<void> => {
    if (pending.has(status.id)) return
    pending.add(status.id); notify(); setError('')
    try {
      const result = await window.clichilds.cliManage({ cli: status.id, action: status.installed ? 'upgrade' : 'install' })
      adoptCliStatus(result)
      toast(`${result.label} 当前版本：${result.version ?? '未识别'}`)
    } catch (error) {
      setError(ipcErrorText(error))
    } finally {
      pending.delete(status.id); notify()
    }
  }
  return <div className="cli-management">
    <span>{status.version ? `当前 ${status.version}` : status.installed ? '当前版本未知' : '未安装'}</span>
    {status.latestVersion && <span className="hint">最新 {status.latestVersion}</span>}
    {(!status.installed || status.updateAvailable || busy) && <button type="button" className={status.installed ? 'link cli-action' : undefined}
      disabled={busy || checking} aria-busy={busy} aria-label={busy ? '正在安装或升级' : status.installed ? '升级' : '安装'}
      onClick={() => void manage()} title="点击后安装或升级此类 CLI，现有会话不关闭">
      {busy ? <span className="cli-action-spinner" aria-hidden="true" /> : status.installed ? '升级' : '安装'}
    </button>}
    {(checking || error || status.updateError || !status.latestVersion) && <button type="button" className="link cli-action"
      disabled={busy || checking} aria-busy={checking} aria-label={checking ? '正在重新检测' : '重新检测'} onClick={() => {
        setChecking(true)
        setError('')
        void refreshCliStatuses().catch((error: unknown) => setError(ipcErrorText(error))).finally(() => setChecking(false))
      }}>
      {checking ? <span className="cli-action-spinner" aria-hidden="true" /> : '重新检测'}
    </button>}
    {(error || status.updateError) && <span className="error">{error || status.updateError}</span>}
  </div>
}
