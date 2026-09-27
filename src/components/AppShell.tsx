import type { ReactNode } from 'react'
import { THEMES } from '@shared/types'
import type { ThemeKind } from '@shared/types'
import { hasUnseenUpdate, useUpdateState } from '../store'
import '../theme/ssh-host.css'

const brandIcon = new URL('../../build/icon.png', import.meta.url).href

/** 有新版本且用户还没看过时，在「设置」导航项上点一个红点 */
const UPDATE_VIEW: View = 'ui'

/** 路由：welcome 只在首次使用（无任何配置）时出现，不进侧栏 */
export type View = 'welcome' | 'launch' | 'dirs' | 'run' | 'notes' | 'ui' | 'commands' | 'ssh' | 'database'

const NAV: { view: View; label: string; badge?: string }[] = [
  { view: 'launch', label: '启动' },
  { view: 'dirs', label: '目录' },
  { view: 'run', label: 'Cli' },
  { view: 'notes', label: '便签' },
  { view: 'ssh', label: 'SSH' },
  { view: 'database', label: 'Database' },
  { view: 'ui', label: '设置' },
  { view: 'commands', label: '命令' }
]

interface Props {
  view: View
  onNav: (v: View) => void
  theme: ThemeKind
  onTheme: (t: ThemeKind) => void
  title: string
  desc: string
  chips?: ReactNode
  children: ReactNode
}

/** 左侧导轨：品牌 + 视图导航 + 皮肤；启动页与设置页共用 */
export function ShellRail(props: {
  view: View
  onNav: (v: View) => void
  theme: ThemeKind
  onTheme: (t: ThemeKind) => void
}): JSX.Element {
  const update = useUpdateState()
  const dot = hasUnseenUpdate(update) ? UPDATE_VIEW : undefined
  return (
    <aside className="shell-rail">
      <nav className="shell-nav">
        {NAV.map((n) => (
          <button
            key={n.view}
            className={`${props.view === n.view ? 'active' : ''}${n.badge ? ' has-badge' : ''}${dot === n.view ? ' has-dot' : ''}`}
            onClick={() => props.onNav(n.view)}
            aria-current={props.view === n.view ? 'page' : undefined}
            aria-label={dot === n.view ? `${n.label}（有新版本）` : undefined}
          >
            {n.label}
            {n.badge && <span className="shell-nav-badge">{n.badge}</span>}
            {dot === n.view && <span className="shell-nav-dot" aria-hidden="true" />}
          </button>
        ))}
      </nav>
      <div className="rail-foot">
        <label className="theme-toggle">
          皮肤
          <select value={props.theme} onChange={(e) => props.onTheme(e.target.value as ThemeKind)}>
            {THEMES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
      </div>
    </aside>
  )
}

/** 左侧导航栏 + 头部 + 内容（设置页共用外壳） */
export function AppShell(props: Props): JSX.Element {
  return (
    <div className="shell">
      <ShellRail view={props.view} onNav={props.onNav} theme={props.theme} onTheme={props.onTheme} />

      <div className="shell-main">
        <header className="shell-header">
          <div>
            <h1>{props.title}</h1>
            <p className="sub">{props.desc}</p>
          </div>
          <div className="spacer" />
          {props.chips}
        </header>
        <div className="shell-pane">{props.children}</div>
      </div>
    </div>
  )
}

export function Chips(props: { items: { text: string; ok?: boolean }[] }): JSX.Element {
  return (
    <div className="chips">
      {props.items.map((c) => (
        <span key={c.text} className={`chip ${c.ok ? 'ok' : ''}`}>
          {c.text}
        </span>
      ))}
    </div>
  )
}

/**
 * 非执行页的自绘标题栏：代替被隐藏的系统标题栏，整条可拖动；
 * 右侧由 CSS 预留出原生窗口按钮的位置。执行页则由标签栏充当标题栏。
 */
export function WindowBar(): JSX.Element {
  return (
    <div className="window-bar">
      <img className="brand-mark" src={brandIcon} alt="Mclis" />
      <span className="window-bar-name">MyClis</span>
    </div>
  )
}
