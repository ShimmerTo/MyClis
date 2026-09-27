import { useEffect, useRef, useState } from 'react'
import { ConfirmDialog } from './ConfirmDialog'
import { Section } from './SettingsSections'

function normalizeDirectory(dir: string): string {
  return dir.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

export function DataDirectorySettings({ beforeMigrate }: { beforeMigrate: () => Promise<void> }): JSX.Element {
  const [currentDir, setCurrentDir] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [targetDir, setTargetDir] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [picking, setPicking] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const pickingRef = useRef(false)
  const submittingRef = useRef(false)

  useEffect(() => {
    let active = true
    setLoading(true)
    setLoadError('')
    setCurrentDir(null)
    const load = async (): Promise<void> => {
      try {
        const dir = await window.clichilds.dataDirectoryGet()
        if (!dir.trim()) throw new Error('未返回实际数据目录')
        if (active) setCurrentDir(dir)
      } catch (error) {
        console.error('读取全局数据目录失败', error)
        if (active) setLoadError('无法读取当前数据目录，请重试。')
      } finally {
        if (active) setLoading(false)
      }
    }
    void load()
    return () => { active = false }
  }, [loadAttempt])

  const pickDirectory = async (): Promise<void> => {
    if (!currentDir || loading || targetDir || pickingRef.current || submittingRef.current) return
    pickingRef.current = true
    setPicking(true)
    setError('')
    try {
      const dir = await window.clichilds.dirPick({ create: true })
      if (dir && normalizeDirectory(dir) !== normalizeDirectory(currentDir)) setTargetDir(dir)
    } catch (error) {
      console.error('选择全局数据目录失败', error)
      setError('无法选择数据目录，请重试。')
    } finally {
      pickingRef.current = false
      setPicking(false)
    }
  }

  const migrate = async (): Promise<void> => {
    if (!currentDir || !targetDir || submittingRef.current) return
    if (normalizeDirectory(targetDir) === normalizeDirectory(currentDir)) {
      setTargetDir(null)
      return
    }
    submittingRef.current = true
    setSubmitting(true)
    setError('')
    try {
      await beforeMigrate().catch(() => { throw new Error('设置尚未保存，未开始迁移；请取消并检查设置保存状态。') })
      await window.clichilds.dataDirectoryMigrate({ dir: targetDir })
      setTargetDir(null)
      submittingRef.current = false
      setSubmitting(false)
    } catch (error) {
      console.error('提交全局数据目录迁移失败', error)
      setError(error instanceof Error
        ? error.message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/i, '')
        : '无法启动数据迁移，请检查目录权限与磁盘空间。')
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  const cancel = (): void => {
    if (submittingRef.current) return
    setTargetDir(null)
    setError('')
  }

  return (
    <Section title="全局数据目录" hint="数据目录存储位置">
      <div className="row">
        <span className="field">当前目录</span>
        <span className="hint settings-path" title={currentDir ?? undefined}>
          {loading ? '读取中…' : currentDir ?? '未能读取当前目录'}
        </span>
        <button
          type="button"
          disabled={loading || !currentDir || picking || submitting || !!targetDir}
          aria-busy={picking || submitting}
          onClick={() => void pickDirectory()}
        >
          {submitting ? '正在重启…' : picking ? '选择中…' : '选择目录…'}
        </button>
      </div>
      {loadError && (
        <div className="row">
          <span className="error" role="alert">{loadError}</span>
          <button type="button" disabled={loading} onClick={() => {
            setLoading(true)
            setLoadAttempt((attempt) => attempt + 1)
          }}>
            重试
          </button>
        </div>
      )}
      {error && !targetDir && <div className="error" role="alert">{error}</div>}
      <div className="callout">
        应用全局数据保存在此目录；切换目录需重启并迁移。项目 .clichilds 产物与 CLI 原生数据不会移动。
      </div>
      {targetDir && currentDir && (
        <ConfirmDialog
          title="迁移全局数据目录"
          confirmText={submitting ? '正在重启…' : '立即重启并迁移'}
          onConfirm={() => void migrate()}
          onCancel={cancel}
        >
          <div aria-busy={submitting}>
            <div>原目录</div>
            <div className="settings-path" title={currentDir}>{currentDir}</div>
            <div>目标目录</div>
            <div className="settings-path" title={targetDir}>{targetDir}</div>
            <p>确认后将结束所有当前会话及 SSH / Database 连接，并立即重启应用。请先保存工作；断开连接不会撤回已发送的远端操作。</p>
            <p>重启时复制并校验数据，保留原目录数据作为备份。目标必须为空目录，不覆盖非空目录。</p>
            <p>不会移动项目 .clichilds 产物与 CLI 原生数据。取消则保持当前目录不变。</p>
            {submitting && <div role="status">正在重启…</div>}
            {error && <div className="error" role="alert">{error}</div>}
          </div>
        </ConfirmDialog>
      )}
    </Section>
  )
}
