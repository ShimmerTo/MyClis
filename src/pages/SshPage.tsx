import { useState } from 'react'
import { AppShell } from '../components/AppShell'
import type { View } from '../components/AppShell'
import { ErrorBoundary } from '../components/ErrorBoundary'
import { applyTheme, saveConfig, useSettings } from '../store'
import { SshPageContent } from '../ssh'

export default function SshPage({ onNav }: { onNav: (view: View) => void }): JSX.Element {
  const { cfg, setCfg, loadError } = useSettings()
  const [error, setError] = useState('')
  return (
    <AppShell
      view="ssh"
      onNav={onNav}
      theme={cfg?.theme ?? 'paper'}
      onTheme={(theme) => {
        if (!cfg) return
        const next = { ...cfg, theme }
        applyTheme(theme)
        setCfg(next)
        void saveConfig(next).catch(() => setError('皮肤设置保存失败，请重试'))
      }}
      title="SSH"
      desc="添加服务器、测试连接、打开终端；并决定哪个项目的 AI 可以用哪台服务器"
    >
      {(error || loadError) && <p className="error" role="alert">{error || loadError}</p>}
      <ErrorBoundary label="SSH 页面">
        <SshPageContent />
      </ErrorBoundary>
    </AppShell>
  )
}
