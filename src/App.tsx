import { useEffect, useState } from 'react'
import type { CliId, SessionSummary } from '@shared/types'
import LauncherPage from './pages/LauncherPage'
import NotesPage from './pages/NotesPage'
import SettingsPage from './pages/SettingsPage'
import SshPage from './pages/SshPage'
import DatabasePage from './database/DatabasePage'
import { DatabaseHost } from './database/DatabaseHost'
import WelcomePage from './pages/WelcomePage'
import WorkbenchPage from './pages/WorkbenchPage'
import { applyTheme } from './store'
import { ErrorBoundary } from './components/ErrorBoundary'
import { WindowBar } from './components/AppShell'
import { SideRail } from './components/SideRail'
import { ToastHost } from './components/ToastHost'
import type { View } from './components/AppShell'
import { SshGlobalHost } from './ssh'
import { NOTE_SESSION_EVENT } from './noteSessionNavigation'
import { useLocalNoteSelection } from './noteSelection'
import './theme/side-rail.css'

interface Active {
  /** 空 = 进入时新建会话；有值 = 复用在跑的会话 */
  sessionId?: string
  workDir: string
  cli: CliId
  profileId?: string
  /** 要恢复的 CLI 原生 session id（省略 = 新会话） */
  resumeSessionId?: string
  initialPrompt?: string
  noteIds?: string[]
}

export default function App(): JSX.Element {
  useLocalNoteSelection()
  const [view, setView] = useState<View | null>(null)
  const [active, setActive] = useState<Active | null>(null)
  const [approvalTarget, setApprovalTarget] = useState<{ sessionId: string; container: HTMLDivElement } | null>(null)
  const [railCollapsed, setRailCollapsed] = useState(false)

  useEffect(() => {
    void window.clichilds.configGet().then((c) => {
      applyTheme(c.theme)
      setView(c.workDirs.some((d) => d.trim()) ? 'launch' : 'welcome')
    })
  }, [])

  useEffect(() => {
    const show = (): void => {
      setActive(null)
      setView('notes')
      setRailCollapsed(false)
    }
    window.addEventListener(NOTE_SESSION_EVENT, show)
    return () => window.removeEventListener(NOTE_SESSION_EVENT, show)
  }, [])

  const openSession = (s: SessionSummary): void => {
    // 手动开的纯 shell 没有 CLI 会话可回，任务卡也不列它
    if (s.cli === 'shell') return
    setActive({ sessionId: s.id, workDir: s.workDir, cli: s.cli, profileId: s.profileId })
  }
  const launchSession = (
    workDir: string,
    profileId: string,
    cli: CliId,
    initialPrompt?: string,
    noteIds?: string[]
  ): void => setActive({ workDir, profileId, cli, initialPrompt, noteIds })
  const resumeSession = (workDir: string, profileId: string, cli: CliId, nativeSessionId: string): void =>
    setActive({ workDir, profileId, cli, resumeSessionId: nativeSessionId })

  const page = active ? (
    <WorkbenchPage
      workDir={active.workDir}
      cli={active.cli}
      profileId={active.profileId}
      sessionId={active.sessionId}
      resumeSessionId={active.resumeSessionId}
      initialPrompt={active.initialPrompt}
      noteIds={active.noteIds}
      onApprovalTargetChange={setApprovalTarget}
      onBack={() => {
        // 只退出工作台：view 还停在进入前点的那页（启动/便签/SSH/…），返回就回到那页，不固定回启动页
        setActive(null)
      }}
    />
  ) : !view ? (
    <div className="boot">加载中…</div>
  ) : view === 'welcome' ? (
    <WelcomePage onDone={() => setView('launch')} onSettings={() => setView('run')} />
  ) : view === 'launch' ? (
    <LauncherPage onNav={setView} onLaunch={launchSession} />
  ) : view === 'notes' ? (
    <NotesPage onNav={setView} />
  ) : view === 'ssh' ? (
    <SshPage onNav={setView} />
  ) : view === 'database' ? (
    <DatabasePage onNav={setView} />
  ) : (
    <SettingsPage view={view} onNav={setView} />
  )
  // 工作台是全幅终端；收起侧栏不卸载列表，保留筛选与滚动位置。
  const rail = !active && view && view !== 'welcome' ? (
    <div className={`side-rail-container${railCollapsed ? ' is-collapsed' : ''}`}>
      <button
        type="button"
        className="side-rail-toggle"
        aria-label={railCollapsed ? '展开历史会话' : '收起历史会话'}
        title={railCollapsed ? '展开历史会话' : '收起历史会话'}
        aria-expanded={!railCollapsed}
        aria-controls="session-side-rail"
        onClick={() => setRailCollapsed((collapsed) => !collapsed)}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d={railCollapsed ? 'm14 6-6 6 6 6' : 'm10 6 6 6-6 6'} />
        </svg>
      </button>
      <div id="session-side-rail" className="side-rail-content" hidden={railCollapsed}>
        <SideRail onOpen={openSession} onResume={resumeSession} onLaunch={launchSession} />
      </div>
    </div>
  ) : null

  return (
    <div className="app-root">
      {!active && <WindowBar />}
      <div className="app-page">
        <ErrorBoundary label="当前页面">{page}</ErrorBoundary>
        {rail}
      </div>
      <ToastHost />
      <ErrorBoundary label="Database 待处理面板">
        <DatabaseHost activeSessionId={active ? approvalTarget?.sessionId : undefined} inlineContainer={active ? approvalTarget?.container : null} />
      </ErrorBoundary>
      <ErrorBoundary label="SSH 待处理面板">
        <SshGlobalHost
          activeSessionId={active ? approvalTarget?.sessionId : undefined}
          inlineContainer={active ? approvalTarget?.container : null}
        />
      </ErrorBoundary>
    </div>
  )
}
