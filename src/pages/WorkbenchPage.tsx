import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import type { CliId, SessionSummary, TerminalKind, UiConfig } from '@shared/types'
import { TERMINALS } from '@shared/types'
import TerminalView, { TerminalStatus } from '../components/TerminalView'
import ReviewerPanel from '../components/ReviewerPanel'
import BootOverlay from '../components/BootOverlay'
import { WindowBar } from '../components/AppShell'
import { OutputDrawer, OutputMaxDrawer, OutputTrigger, useOutputSession } from '../components/OutputDrawer'
import { ChangesDrawer, ChangesMaxDrawer, ChangesTrigger, useChanges } from '../components/ChangesDrawer'
import { NewTabModal } from '../components/NewTabModal'
import { NotesTrigger } from '../components/NotesPanel'
import { sameDir } from '../notes'
import { focusTerminal } from '../terminalPool'
import { saveConfig, startMainSession, useNotes, useSessions, useSettings } from '../store'
import { PHASE_LABEL, outputState, runTime, shellLabel } from '../display'

interface Props {
  workDir: string
  cli: CliId
  profileId?: string
  /** 复用在跑的会话（从启动页任务面板点进来时有值） */
  sessionId?: string
  /** 恢复某条历史会话（有值 = 新建 pty，但让 CLI resume 那个原生会话） */
  resumeSessionId?: string
  /** 启动就绪后自动投递的初始提示词（「用其他 CLI 继续」时带入） */
  initialPrompt?: string
  onBack: () => void
}

const DEFAULT_UI: UiConfig = {
  reviewerLayout: 'vertical',
  tileWidthMode: 'fixed',
  tileWidth: 480,
  workbenchMode: 'tabs',
  // 与主进程 schema 的默认值保持一致
  outputDrawerHeight: 324,
  changesDrawerHeight: 378,
  diffMode: 'unified',
  statusBarMode: 'always'
}

const dirBase = (p: string): string => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p
const hiddenBySession = new Map<string, Set<string>>()
/** 拖动后的宽度只属于当前主会话的 UI 状态：切页回来保留，不写进配置 */
const layoutBySession = new Map<string, { sideWidth: number; childWidths: Record<string, number> }>()

/** 标签最小描述：会话刚启动、还没出现在会话列表时也要能画出标签本身 */
interface TabDesc {
  id: string
  workDir: string
  cli: CliId
  profileId?: string
  /** 已在会话列表里见过一次：只有“确认过的”标签才会因为会话消失而被摘掉 */
  confirmed?: boolean
}
/** 标签顺序与描述跨页面返回保留；终端本身由 terminalPool 常驻，不受标签增删影响 */
const tabOrder: string[] = []
const tabDesc = new Map<string, TabDesc>()
function rememberTab(d: TabDesc): void {
  tabDesc.set(d.id, d)
  if (!tabOrder.includes(d.id)) tabOrder.push(d.id)
}
function forgetTab(id: string): void {
  const i = tabOrder.indexOf(id)
  if (i >= 0) tabOrder.splice(i, 1)
  tabDesc.delete(id)
  hiddenBySession.delete(id)
  layoutBySession.delete(id)
}

/**
 * 执行页：浏览器式多标签。每个在跑的主 CLI 会话是一个标签，
 * 标签栏常驻顶部；「+」弹选择器新建，标签的 × 结束并关闭该会话。
 */
export default function WorkbenchPage({
  workDir,
  cli,
  profileId,
  sessionId,
  resumeSessionId,
  initialPrompt,
  onBack
}: Props): JSX.Element {
  const [mainId, setMainId] = useState<string | null>(sessionId ?? null)
  const [error, setError] = useState('')
  const [sideWidth, setSideWidth] = useState(() => (sessionId ? layoutBySession.get(sessionId)?.sideWidth : undefined) ?? 480)
  const [childWidths, setChildWidths] = useState<Record<string, number>>(
    () => (sessionId ? layoutBySession.get(sessionId)?.childWidths : undefined) ?? {}
  )
  const [hidden, setHidden] = useState<Set<string>>(() => new Set(sessionId ? hiddenBySession.get(sessionId) : []))
  const [tabTick, setTabTick] = useState(0)
  /** 「静默」判定的当前时间：输出停了之后主进程不再推会话，靠本地定时器驱动重算 */
  const [now, setNow] = useState(() => Date.now())
  const [pickOpen, setPickOpen] = useState(false)
  /** 「发送到 CLI」预选：打开新建会话弹窗时定位到该目录并预勾选这条便签 */
  const [pickNote, setPickNote] = useState<{ id: string; workDir: string } | null>(null)
  const [closingId, setClosingId] = useState<string | null>(null)
  const [gitBranch, setGitBranch] = useState<string | null>(null)
  const [stripErr, setStripErr] = useState('')
  /** 用户主动选择看原始输出的终端（error 阶段不再盖加载层） */
  const [revealed, setRevealed] = useState<string[]>([])
  /** 是否已经拉起过/接过第一个会话；没拉起前不能因为「列表为空」就回启动页 */
  const startedRef = useRef(false)

  const { cfg, setCfg, clis } = useSettings()
  const sessions = useSessions()
  const notes = useNotes()
  const output = useOutputSession(mainId)
  const ui = cfg?.ui ?? DEFAULT_UI
  /** 终端打开模式：页卡（常驻）/ 隐藏式卡片（鼠标移到顶部弹悬浮卡片） */
  const tabsMode = (ui.workbenchMode ?? 'tabs') !== 'hover'
  /** UI 偏好（抽屉高度、对比模式）改一次就落盘：下次启动会话时按上次的来 */
  const patchUi = (patch: Partial<UiConfig>): void => {
    if (!cfg) return
    const next = { ...cfg, ui: { ...cfg.ui, ...patch } }
    setCfg(next)
    void saveConfig(next).catch(() => undefined)
  }

  useEffect(() => {
    if (mainId) layoutBySession.set(mainId, { sideWidth, childWidths })
  }, [mainId, sideWidth, childWidths])

  const main = sessions.find((s) => s.id === mainId)
  const mains = sessions.filter((s) => s.role === 'main')
  const activeWorkDir = main?.workDir ?? workDir
  // 变更清单跟着当前标签的工作目录走（主进程已按会话拉起时的目录开始监听）
  const changes = useChanges(activeWorkDir, ui.diffMode === 'split', (v) =>
    patchUi({ diffMode: v ? 'split' : 'unified' })
  )

  // 当工作目录变化时异步查 Git 分支（不必阻塞）
  useEffect(() => {
    setGitBranch(null)
    window.clichilds.gitBranch(activeWorkDir).then(setGitBranch).catch(() => null)
  }, [activeWorkDir])

  // 页卡「静默加粗」需要自己走时钟：终端不输出时没有任何会话推送，只有定时器能推动重算
  useEffect(() => {
    if (!tabsMode) return
    const timer = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(timer)
  }, [tabsMode])

  // 子任务终端挂在主会话下；手动开的纯 shell 只认工作目录（它不属于任何任务）
  const children = sessions
    .filter((s) =>
      s.role === 'shell'
        ? s.workDir === activeWorkDir
        : s.role === 'child' && (mainId ? s.parentTermId === mainId : s.workDir === activeWorkDir)
    )
    .sort((a, b) => a.startedAt - b.startedAt || (a.index ?? 0) - (b.index ?? 0))
  const visibleChildren = children.filter((child) => !hidden.has(child.id))
  /** 全局还在跑的子终端与手动终端数：主会话都结束后，靠它判断要不要留在执行页 */
  const runningChildren = sessions.filter((s) => s.role === 'child' || s.role === 'shell').length

  const setHiddenIds = (next: Set<string>): void => {
    setHidden(next)
    if (mainId) hiddenBySession.set(mainId, new Set(next))
  }

  /**
   * 返回启动页。主会话与子任务留在后台继续跑，但手动开的纯 shell 一并关掉 ——
   * 它们只属于工作台的子终端区，回到启动页就没有入口能再点回来。
   */
  const backToLauncher = (): void => {
    for (const s of sessions) {
      if (s.role === 'shell') window.clichilds.termKill(s.id)
    }
    onBack()
  }

  /** 切换标签：布局与隐藏集合按各自会话恢复，终端本身常驻不重建；
   *  from = 刚被关掉的标签，不再把它的布局写回去 */
  const activate = (id: string, from?: string): void => {
    if (id === mainId) return
    const prev = from ?? mainId
    if (prev && prev !== id && tabOrder.includes(prev)) {
      layoutBySession.set(prev, { sideWidth, childWidths })
      hiddenBySession.set(prev, new Set(hidden))
    }
    setMainId(id)
    const layout = layoutBySession.get(id)
    setSideWidth(layout?.sideWidth ?? 480)
    setChildWidths(layout?.childWidths ?? {})
    setHidden(new Set(hiddenBySession.get(id) ?? []))
  }

  // 启动入口：从启动页进来（新建 / 复用 / 恢复）只负责第一个标签
  useEffect(() => {
    if (sessionId) {
      startedRef.current = true
      rememberTab({ id: sessionId, workDir, cli, profileId })
      setMainId(sessionId)
      setTabTick((v) => v + 1)
      return
    }
    if (!profileId) {
      setError('缺少主 CLI 设置')
      return
    }
    let alive = true
    startMainSession({ workDir, profileId, resumeSessionId, initialPrompt })
      .then((id) => {
        if (!alive) return
        startedRef.current = true
        rememberTab({ id, workDir, cli, profileId })
        setMainId(id)
        setTabTick((v) => v + 1)
      })
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)))
    // 离开本页不再杀终端：会话留在后台，启动页任务面板可继续进入
    return () => {
      alive = false
    }
  }, [workDir, profileId, sessionId, resumeSessionId, initialPrompt, cli])

  // 后台还在跑的主会话也补成标签，并对齐目录/档案；已退出的摘掉
  useEffect(() => {
    let changed = false
    const alive = new Set<string>()
    for (const s of sessions) {
      // 纯 shell 不是主会话，不参与页卡
      if (s.role !== 'main' || s.cli === 'shell') continue
      alive.add(s.id)
      const cur = tabDesc.get(s.id)
      if (!cur) {
        rememberTab({ id: s.id, workDir: s.workDir, cli: s.cli, profileId: s.profileId, confirmed: true })
        changed = true
      } else if (!cur.confirmed || cur.workDir !== s.workDir || cur.cli !== s.cli) {
        tabDesc.set(s.id, {
          id: s.id,
          workDir: s.workDir,
          cli: s.cli,
          profileId: s.profileId ?? cur.profileId,
          confirmed: true
        })
        changed = true
      }
    }
    for (const id of [...tabOrder]) {
      if (alive.has(id)) continue
      const cur = tabDesc.get(id)
      // 还没被会话列表确认过的标签先留着：工作台刚挂载时列表可能是空的（或缓存未命中），
      // 此时摘标签会把刚点进来的会话直接弹回启动页
      if (!cur || !cur.confirmed) continue
      forgetTab(id)
      changed = true
    }
    if (changed) setTabTick((v) => v + 1)
  }, [sessions])

  // 当前标签的会话自己退出了（异常退出 / 别处结束）：切到相邻标签；一个主会话都不剩时交给下面的兜底
  useEffect(() => {
    if (!mainId || tabOrder.includes(mainId)) return
    const next = tabOrder[0] ?? null
    if (next) activate(next)
    else setMainId(null)
  }, [tabTick, mainId])

  // 只有确认没有任何会话（主 CLI 或子终端）在跑时才回启动页，
  // 否则关掉一个标签就被弹回启动页，或后台还有子终端在跑时会误判成「全结束」
  useEffect(() => {
    if (!startedRef.current || mainId || tabOrder.length > 0 || sessions.length > 0) return
    onBack()
  }, [sessions, mainId, tabTick])

  /** 结束一个标签：杀掉它的主终端与其名下子终端，再关闭标签 */
  const closeTab = (id: string): void => {
    window.clichilds.termKill(id)
    const idx = tabOrder.indexOf(id)
    forgetTab(id)
    setClosingId(null)
    if (id === mainId) {
      const next = tabOrder[idx] ?? tabOrder[idx - 1] ?? tabOrder[0] ?? null
      if (next) activate(next, id)
      else setMainId(null)
    }
    setTabTick((v) => v + 1)
  }

  /** 「+」新建标签：拉起新主会话并切过去；勾选的便签作为首条消息投递 */
  const startNewTab = async (
    dir: string,
    pid: string,
    cliId: CliId,
    initialPrompt?: string
  ): Promise<void> => {
    const id = await startMainSession({ workDir: dir, profileId: pid, fresh: true, initialPrompt })
    rememberTab({ id, workDir: dir, cli: cliId, profileId: pid })
    activate(id)
    setTabTick((v) => v + 1)
    setPickOpen(false)
    setPickNote(null)
  }

  const beginDrag = (
    event: ReactPointerEvent<HTMLElement>,
    update: (deltaX: number) => void
  ): void => {
    event.preventDefault()
    const startX = event.clientX
    const move = (e: PointerEvent): void => update(e.clientX - startX)
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.classList.remove('pane-dragging')
    }
    document.body.classList.add('pane-dragging')
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up, { once: true })
  }

  const closeChild = (id: string): void => {
    window.clichilds.termKill(id)
  }

  /** 重开一个子终端：主进程先杀掉旧进程再按同一任务拉起新终端；失败（台账已不在）在顶部条上报出 */
  const restartChild = (id: string): void => {
    setStripErr('')
    window.clichilds
      .termRestart(id)
      .catch((e: unknown) => setStripErr(e instanceof Error ? e.message : String(e)))
  }

  /** 状态栏弹层里点一个子终端：取消隐藏并聚焦；本来可见的就滚到可视区 */
  const openChild = (id: string): void => {
    if (hidden.has(id)) {
      const next = new Set(hidden)
      next.delete(id)
      setHiddenIds(next)
    }
    // 取消隐藏要等新面板挂载、xterm 重新 attach 完，聚焦才有落点
    window.setTimeout(() => {
      focusTerminal(id)
      document.querySelector(`[data-child-id="${id}"]`)?.scrollIntoView({ block: 'nearest' })
    }, 0)
  }

  /** 用系统原生终端窗口打开一份同样的：失败（终端已结束、Shell 缺失）在顶部条上报出来 */
  const openExternal = (id: string): void => {
    setStripErr('')
    window.clichilds
      .termOpenExternal(id)
      .catch((e: unknown) => setStripErr(e instanceof Error ? e.message : String(e)))
  }

  const openShell = (kind?: TerminalKind): void => {
    setStripErr('')
    window.clichilds
      .termOpenShell(activeWorkDir, kind)
      .catch((e: unknown) => setStripErr(e instanceof Error ? e.message : String(e)))
  }

  const doneCount = children.filter((child) => child.done).length
  const mainLabel = main?.profileLabel ?? cli
  // 主终端在 CLI 就绪前先显示加载层：此时不挂载 xterm，启动命令行不会出现在界面里
  const mainConcealed =
    !!main && (main.runtime.phase === 'booting' || (main.runtime.phase === 'error' && !revealed.includes(main.id)))
  const tile = ui.reviewerLayout === 'tile'
  const sideStyle: CSSProperties = tile
    ? ui.tileWidthMode === 'fixed'
      ? { width: `${sideWidth}px`, minWidth: `${Math.min(ui.tileWidth, 320)}px` }
      : { width: `${sideWidth}px`, minWidth: '320px' }
    : { width: `${sideWidth}px` }
  // 平铺模式：每个终端都能拖右边缘改宽度；equal 模式默认平分，拖过的那一格固定成拖出来的宽度
  const panelStyle = (id: string): CSSProperties | undefined => {
    if (!tile) return undefined
    const pinned = childWidths[id]
    if (ui.tileWidthMode === 'fixed') return { flex: '0 0 auto', width: `${pinned ?? ui.tileWidth}px` }
    return pinned ? { flex: '0 0 auto', width: `${pinned}px` } : { flex: '1 1 0', minWidth: '260px' }
  }

  const tabs = tabOrder
    .map((id) => ({ id, desc: tabDesc.get(id), info: sessions.find((s) => s.id === id) }))
    .filter((t): t is { id: string; desc: TabDesc; info: SessionSummary | undefined } => !!t.desc)
  const closingDesc = closingId ? tabDesc.get(closingId) : undefined
  const closingChildren = closingId
    ? sessions.filter((s) => s.role === 'child' && s.parentTermId === closingId)
    : []
  // 「发送到 CLI」的便签目录可能已不在配置里（孤儿目录）：补进选择列表，否则预选目录选不中
  const pickDirs = ((): string[] => {
    const list = cfg?.workDirs.filter((d) => d.trim()) ?? []
    if (!pickNote) return list
    return list.some((d) => sameDir(d, pickNote.workDir)) ? list : [pickNote.workDir, ...list]
  })()

  return (
    <div className={`workbench ${tabsMode ? 'tabs-mode' : 'hover-mode'}`}>
      {tabsMode && (
      <div className="wb-tabstrip">
        <button className="wb-back" onClick={backToLauncher} title="返回启动页（主会话与子任务继续在后台运行；手动开的终端会关闭）">
          ←
        </button>
        <div className="wb-tabs">
          {tabs.map((t) => {
            const label = t.info?.profileLabel ?? t.desc.cli
            const phase = t.info?.runtime.phase ?? 'booting'
            const busy = phase === 'delivering' || phase === 'running'
            // 干活中（投递/运行）却 30 秒没输出：页卡文字加粗；启动中与已完成不算
            const quiet = !!t.info && busy && now - t.info.lastOutputAt >= 30_000
            // 转圈只表示「还在吐输出」：静默即 CLI 已停下等输入，与静态的 phase 无关
            const spinning = busy && !quiet
            const detail = t.info
              ? `${PHASE_LABEL[phase]} · 已运行 ${runTime(t.info.startedAt)} · ${outputState(t.info.lastOutputAt)}`
              : '正在启动…'
            return (
              <div
                key={t.id}
                className={`wb-tab ${t.id === mainId ? 'on' : ''} ${phase === 'error' ? 'bad' : ''} ${quiet ? 'quiet' : ''}`}
                role="button"
                tabIndex={0}
                title={`${label} · ${t.desc.workDir}\n${detail}\n点 × 结束该会话并关闭标签`}
                onClick={() => activate(t.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    activate(t.id)
                  }
                }}
                onAuxClick={(e) => {
                  if (e.button === 1) setClosingId(t.id)
                }}
              >
                {spinning ? (
                  <svg className="wb-tab-snake" viewBox="0 0 14 14" width="12" height="12" aria-hidden="true">
                    <rect className="wb-tab-snake-base" x="1" y="1" width="12" height="12" rx="2" pathLength={100} />
                    <rect className="wb-tab-snake-run" x="1" y="1" width="12" height="12" rx="2" pathLength={100} />
                  </svg>
                ) : null}
                <span className="wb-tab-text">
                  <b>{dirBase(t.desc.workDir)}</b>
                </span>
                <button
                  className="wb-tab-close"
                  title="结束该会话并关闭标签"
                  onClick={(e) => {
                    e.stopPropagation()
                    setClosingId(t.id)
                  }}
                >
                  ✕
                </button>
              </div>
            )
          })}
          {/* 标签右侧的空白：整条标题栏的可拖动区（标签自身是 no-drag） */}
          <span className="wb-tabs-fill" />
        </div>
        {stripErr ? (
          <span className="wb-strip-err" title={stripErr}>
            {stripErr}
          </span>
        ) : null}
        <button
          className="wb-newtab"
          onClick={() => {
            setPickNote(null)
            setPickOpen(true)
          }}
          title="新建标签：选工作目录与主 CLI"
        >
          ＋
        </button>
        <TerminalMenu
          title={`在下方子终端区新开一个终端并定位到 ${activeWorkDir}，移入可选择 Shell`}
          defaultKind={cfg?.terminal ?? 'powershell'}
          buttonClass="wb-term"
          onOpen={openShell}
        >
          <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">
            <path
              d="M2.2 3.8 6.4 8l-4.2 4.2"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path d="M8.4 12.2h5.4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </TerminalMenu>
      </div>
      )}

      {/* 非页卡模式下面没有页卡栏充当标题栏，补一条通用标题栏：
          否则悬浮工具栏会顶到窗口按钮区，和最小化/最大化/关闭叠在一起 */}
      {!tabsMode && <WindowBar />}

      {!tabsMode && (
        <div className="wb-topzone">
          <div className="wb-toolbar">
            <div className="wb-row">
              <button onClick={backToLauncher} title="返回启动页（主会话与子任务继续在后台运行；手动开的终端会关闭）">
                ← 启动
              </button>
              <span className="wb-info">
                {mainLabel} · {activeWorkDir}
              </span>
              <span className="spacer" />
              {children.length > 0 && (
                <span className="hint">
                  {doneCount}/{children.length} 子任务完成
                </span>
              )}
              <span className="hint" title="CLI 界面接管鼠标时，按住 Shift 拖拽才走终端选择（松手即复制）；右键唤出菜单">
                Shift+拖拽 选择（选中即复制） · 右键 菜单 · Ctrl+C / Ctrl+V
              </span>
              {stripErr ? (
                <span className="wb-strip-err" title={stripErr}>
                  {stripErr}
                </span>
              ) : null}
              <TerminalMenu
                title={`在下方子终端区新开一个终端并定位到 ${activeWorkDir}，移入可选择 Shell`}
                defaultKind={cfg?.terminal ?? 'powershell'}
                onOpen={openShell}
              >
                终端
              </TerminalMenu>
              <button onClick={() => mainId && setClosingId(mainId)} title="结束当前标签的会话并关闭标签">
                结束会话
              </button>
              <button
                onClick={() => {
                  setPickNote(null)
                  setPickOpen(true)
                }}
                title="新建一个主 CLI 会话"
              >
                ＋ 新会话
              </button>
            </div>
            <MainsCards mains={mains} mainId={mainId} onSwitch={activate} />
          </div>
        </div>
      )}

      {error ? (
        <div className="workbench-placeholder">
          <p className="error">{error}</p>
          <button onClick={onBack}>← 返回设置</button>
        </div>
      ) : (
        <>
        <div className="wb-body">
          <div className="wb-main">
            {mainId && main ? (
              mainConcealed ? (
                <BootOverlay
                  info={main}
                  label={mainLabel}
                  onShowTerminal={() => setRevealed((old) => [...old, mainId])}
                  onRetryPrompt={() => window.clichilds.termRetryPrompt(mainId)}
                />
              ) : (
                <TerminalView termId={mainId} />
              )
            ) : tabOrder.length === 0 && runningChildren > 0 ? (
              <div className="workbench-placeholder">
                <p>没有运行中的主 CLI</p>
                <p className="hint">还有 {runningChildren} 个子终端或手动终端在执行，全部结束后会自动返回启动页。</p>
                <button onClick={backToLauncher}>← 返回启动页</button>
              </div>
            ) : (
              <p className="hint">终端启动中…</p>
            )}
          </div>
          {visibleChildren.length > 0 && (
            <div
              className="pane-resizer main"
              onPointerDown={(event) => {
                const start = sideWidth
                beginDrag(event, (delta) => setSideWidth(Math.max(300, Math.min(window.innerWidth * 0.78, start - delta))))
              }}
            />
          )}
          {visibleChildren.length > 0 && (
            <div className={`wb-side${tile ? ' tile' : ''}`} style={sideStyle}>
              {visibleChildren.map((child) => (
                <ReviewerPanel
                  key={child.id}
                  info={child}
                  done={!!child.done}
                  resultFile={child.resultFile}
                  style={panelStyle(child.id)}
                  onClose={closeChild}
                  onRestart={restartChild}
                  onOpenExternal={openExternal}
                  onMinimize={(id) => {
                    const next = new Set(hidden)
                    next.add(id)
                    setHiddenIds(next)
                  }}
                  onResizeStart={tile ? (event, id) => {
                    // equal 模式下没有存过宽度，就以面板当前实际宽度为起点，拖完这一格改成固定宽度
                    const box = event.currentTarget.parentElement?.getBoundingClientRect()
                    const start = childWidths[id] ?? box?.width ?? ui.tileWidth
                    beginDrag(event, (delta) => setChildWidths((old) => ({
                      ...old,
                      [id]: Math.max(260, Math.min(1600, start + delta))
                    })))
                  } : undefined}
                />
              ))}
            </div>
          )}
        </div>
        {mainId ? (
          <ChangesDrawer
            session={changes}
            dark={cfg?.theme === 'dark'}
            savedHeight={ui.changesDrawerHeight}
            onHeight={(h) => patchUi({ changesDrawerHeight: h })}
          />
        ) : null}
        {mainId ? <ChangesMaxDrawer session={changes} dark={cfg?.theme === 'dark'} /> : null}
        {mainId ? (
          <OutputDrawer
            session={output}
            savedHeight={ui.outputDrawerHeight}
            onHeight={(h) => patchUi({ outputDrawerHeight: h })}
          />
        ) : null}
        {mainId ? <OutputMaxDrawer session={output} /> : null}
        {/* 状态栏压在整个窗口最底部：输出栏/变更栏打开时也从它下面顶出来，不再被挤到抽屉上方 */}
        {mainId ? (
          <TerminalStatus
            info={main}
            statusExtra={
              <>
                <ChildClisTrigger children={children} hidden={hidden} onOpen={openChild} />
                <NotesTrigger
                  workDir={activeWorkDir}
                  termId={mainId ?? undefined}
                  onExecuteNote={(note) => {
                    setPickNote({ id: note.id, workDir: note.workDir })
                    setPickOpen(true)
                  }}
                />
                <ChangesTrigger session={changes} />
                <OutputTrigger session={output} />
              </>
            }
            gitBranch={gitBranch}
          />
        ) : null}
        </>
      )}

      {pickOpen && cfg && (
        <NewTabModal
          workDirs={pickDirs}
          profiles={cfg.cliConfigs}
          clis={clis}
          allowNotes
          notes={notes}
          initialNoteId={pickNote?.id}
          defaultWorkDir={pickNote?.workDir ?? activeWorkDir}
          defaultProfileId={main?.profileId ?? profileId ?? cfg.launch.mainCliId ?? ''}
          onStart={startNewTab}
          onClose={() => {
            setPickOpen(false)
            setPickNote(null)
          }}
        />
      )}

      {closingId && (
        <div
          className="picker-overlay"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setClosingId(null)
          }}
        >
          <div className="picker-panel confirm" role="dialog" aria-modal="true" aria-label="关闭标签">
            <div className="picker-head">
              <h2>结束并关闭标签</h2>
              <span className="spacer" />
              <span className="hint">{closingDesc ? dirBase(closingDesc.workDir) : ''}</span>
            </div>
            <p className="hint">
              将结束该标签的主终端
              {closingChildren.length > 0 ? `与 ${closingChildren.length} 个子终端` : ''}
              进程，正在运行的任务会立即中断。
            </p>
            <div className="picker-foot">
              <span className="spacer" />
              <button onClick={() => setClosingId(null)}>取消</button>
              <button className="primary" onClick={() => closingId && closeTab(closingId)}>
                结束并关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * 顶部「终端」按钮：鼠标移入向下弹出三种 Shell（PowerShell / CMD / Git Bash），
 * 点哪项就用哪种 Shell 新开一个系统终端窗口；点按钮本体则用配置里的默认 Shell。
 * 弹出层靠 CSS :hover / :focus-within 控制，移出即收起。
 */
function TerminalMenu(props: {
  title: string
  /** 点按钮本体时用的 Shell（配置里的默认值） */
  defaultKind: TerminalKind
  /** 图标版（页卡栏）要带 .wb-term；文字版不用 */
  buttonClass?: string
  children: ReactNode
  onOpen: (kind: TerminalKind) => void
}): JSX.Element {
  return (
    <div className="term-menu">
      <button className={props.buttonClass} onClick={() => props.onOpen(props.defaultKind)} title={props.title}>
        {props.children}
      </button>
      <div className="term-menu-pop">
        {TERMINALS.map((t) => (
          <button key={t.id} onClick={() => props.onOpen(t.id)} title={`用 ${t.label} 打开`}>
            {t.label}
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * 隐藏式卡片模式：鼠标移到窗口顶部才弹出的悬浮卡片。
 * 每张卡片一行目录+档案名、一行运行状态、最多两行问题。
 */
function MainsCards(props: {
  mains: SessionSummary[]
  mainId: string | null
  onSwitch: (id: string) => void
}): JSX.Element {
  const [, tick] = useState(0)
  // 状态行含「已运行 / 输出中」这类随时间变化的内容，自己走表
  useEffect(() => {
    const timer = setInterval(() => tick((v) => v + 1), 1000)
    return () => clearInterval(timer)
  }, [])
  return (
    <div className="wb-row wb-mains">
      <span className="hint">运行中的主 CLI</span>
      {props.mains.map((m) => {
        const problem = m.initialQuery?.trim()
        return (
          <button
            key={m.id}
            className={`wb-mcard ${m.id === props.mainId ? 'on' : ''} ${m.runtime.phase === 'error' ? 'bad' : ''}`}
            onClick={() => props.onSwitch(m.id)}
            title={`${m.profileLabel ?? m.cli} · ${m.workDir}`}
          >
            <span className="wb-mcard-head">
              <span className={`status-dot ${m.runtime.phase}`} />
              <span className="wb-mcard-name">
                <b>{dirBase(m.workDir)}</b>
                <span className="wb-mcard-label"> · {m.profileLabel ?? m.cli}</span>
              </span>
            </span>
            <span className="wb-mcard-state" title={m.runtime.message}>
              {PHASE_LABEL[m.runtime.phase]} · 已运行 {runTime(m.startedAt)} · {outputState(m.lastOutputAt)}
            </span>
            {problem || m.runtime.message ? (
              <span className="wb-mcard-query" title={problem ?? m.runtime.message}>
                {problem ?? m.runtime.message}
              </span>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}

const CHILD_TASK_LABEL = { design: '方案校验', write: '代码编写', review: '代码检查' } as const

/**
 * 状态栏上的子 CLI 入口：图标 + 已最小化的数量，点击向上弹出本会话的全部子终端。
 * 顶部不再单开一栏放隐藏的终端 —— 状态栏在所有进入工作台的路径上都有
 * （点卡片进入、历史「继续」、用其他 CLI 继续），入口自然跟着在。
 * 浮层 portal 到 body：状态栏是 overflow:hidden，留在里面会被裁掉。
 */
function ChildClisTrigger(props: {
  children: SessionSummary[]
  hidden: Set<string>
  onOpen: (id: string) => void
}): JSX.Element | null {
  const [pop, setPop] = useState<{ right: number; bottom: number } | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const hiddenCount = props.children.filter((child) => props.hidden.has(child.id)).length
  const close = (): void => setPop(null)

  useEffect(() => {
    if (!pop) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    const onDown = (event: MouseEvent): void => {
      const target = event.target
      if (!(target instanceof HTMLElement)) return
      if (trigger.current?.contains(target) || target.closest('.child-clis-pop')) return
      close()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onDown)
    }
  }, [pop])

  if (props.children.length === 0) return null

  return (
    <>
      <button
        type="button"
        ref={trigger}
        className={`child-clis-trigger ${hiddenCount > 0 ? 'has' : ''}`}
        title={`子 CLI：本会话 ${props.children.length} 个${hiddenCount > 0 ? `，其中 ${hiddenCount} 个已最小化` : ''}；点开查看全部`}
        onClick={() => {
          if (pop) {
            close()
            return
          }
          const box = trigger.current?.getBoundingClientRect()
          if (!box) return
          setPop({ right: window.innerWidth - box.right, bottom: window.innerHeight - box.top + 6 })
        }}
      >
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
          <rect
            x="1.7"
            y="2.8"
            width="12.6"
            height="10.4"
            rx="1.6"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.2"
          />
          <path
            d="M4.4 6.5 6.6 8.4 4.4 10.3"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path d="M8.4 10.4h3.2" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
        {hiddenCount > 0 ? <span className="child-clis-count">{hiddenCount}</span> : null}
      </button>
      {pop
        ? createPortal(
            <div className="child-clis-pop" style={{ right: pop.right, bottom: pop.bottom }}>
              <span className="hint">子 CLI · 点一项打开</span>
              {props.children.map((child) => (
                <button
                  key={child.id}
                  type="button"
                  className={`child-clis-item ${child.runtime.phase}`}
                  title={child.runtime.message}
                  onClick={() => {
                    props.onOpen(child.id)
                    close()
                  }}
                >
                  <span className={`status-dot ${child.runtime.phase}`} />
                  <span className="child-clis-name">
                    {child.role === 'shell' ? shellLabel(child.shell) : child.profileLabel ?? child.cli}
                  </span>
                  <span className="child-clis-kind">
                    {child.role === 'shell' || !child.taskKind
                      ? ''
                      : `${CHILD_TASK_LABEL[child.taskKind]} #${child.index ?? 1}`}
                  </span>
                  <span className="spacer" />
                  <span className="child-clis-phase">{PHASE_LABEL[child.runtime.phase]}</span>
                  {props.hidden.has(child.id) ? <span className="child-clis-tag">已隐藏</span> : null}
                </button>
              ))}
            </div>,
            document.body
          )
        : null}
    </>
  )
}
