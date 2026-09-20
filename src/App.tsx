import { useEffect, useState } from 'react'
import type { CliId } from '@shared/types'
import LauncherPage from './pages/LauncherPage'
import NotesPage from './pages/NotesPage'
import SettingsPage from './pages/SettingsPage'
import WelcomePage from './pages/WelcomePage'
import WorkbenchPage from './pages/WorkbenchPage'
import { applyTheme } from './store'
import { WindowBar } from './components/AppShell'
import { ToastHost } from './components/ToastHost'
import type { View } from './components/AppShell'

interface Active {
  /** 空 = 进入时新建会话；有值 = 复用在跑的会话 */
  sessionId?: string
  workDir: string
  cli: CliId
  profileId?: string
  /** 空 = 新会话；有值 = 用该 CLI 的原生 resume 接上这条对话 */
  resumeSessionId?: string
  /** 新会话就绪后自动投递的初始提示词（「用其他 CLI 继续」） */
  initialPrompt?: string
}

export default function App(): JSX.Element {
  const [view, setView] = useState<View | null>(null)
  const [active, setActive] = useState<Active | null>(null)

  useEffect(() => {
    void window.clichilds.configGet().then((c) => {
      applyTheme(c.theme)
      // 首次使用（还没有工作目录）→ 引导页；已有配置 → 启动页
      setView(c.workDirs.some((d) => d.trim()) ? 'launch' : 'welcome')
    })
  }, [])

  // 执行页：顶部标签栏本身就是窗口标题栏，不再额外画一条通用标题栏
  if (active) {
    return (
      <div className="app-root">
        <div className="app-page">
          <WorkbenchPage
            workDir={active.workDir}
            cli={active.cli}
            profileId={active.profileId}
            sessionId={active.sessionId}
            resumeSessionId={active.resumeSessionId}
            initialPrompt={active.initialPrompt}
            onBack={() => {
              setActive(null)
              setView('launch')
            }}
          />
        </div>
        <ToastHost />
      </div>
    )
  }

  if (!view) {
    return (
      <div className="app-root">
        <WindowBar />
        <div className="app-page">
          <div className="boot">加载中…</div>
        </div>
      </div>
    )
  }

  const page =
    view === 'welcome' ? (
      <WelcomePage onDone={() => setView('launch')} onSettings={() => setView('run')} />
    ) : view === 'launch' ? (
      <LauncherPage
        onNav={setView}
        onLaunch={(workDir, profileId, cli, initialPrompt) =>
          setActive({ workDir, profileId, cli, initialPrompt })
        }
        onOpen={(s) => {
          // 纯 shell 不是主会话，不能当作工作台的「当前会话」
          if (s.cli === 'shell') return
          setActive({ sessionId: s.id, workDir: s.workDir, cli: s.cli, profileId: s.profileId })
        }}
        onResume={(workDir, profileId, cli, nativeSessionId) =>
          setActive({ workDir, profileId, cli, resumeSessionId: nativeSessionId })
        }
      />
    ) : view === 'notes' ? (
      <NotesPage onNav={setView} />
    ) : (
      <SettingsPage view={view} onNav={setView} />
    )

  return (
    <div className="app-root">
      <WindowBar />
      <div className="app-page">{page}</div>
      <ToastHost />
    </div>
  )
}
