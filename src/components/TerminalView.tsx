import { useEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import type { SessionSummary, TokenUsage } from '@shared/types'
import {
  attachTerminal,
  detachTerminal,
  scrollTerminalToBottom,
  scrollTerminalToTop
} from '../terminalPool'
import { PHASE_LABEL } from '../display'
import { useSettings } from '../store'

/** 滚动条两端的热区：鼠标贴住终端右边缘、且落在上下这么高的一段里才浮出图标。
 *  热区比图标宽 —— 图标故意浮在滚动条左侧，不挡住拖滚动条。 */
const HINT_ZONE_WIDTH = 30
const HINT_ZONE_HEIGHT = 36

interface TerminalViewProps {
  termId: string
}

interface TerminalStatusProps {
  info?: SessionSummary
  /** 状态栏最右侧的附加控件（如「输出」入口） */
  statusExtra?: ReactNode
  /** 当前 Git 分支名（主进程查的），点击复制 */
  gitBranch?: string | null
}

function short(n?: number): string {
  if (n === undefined) return '—'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(Math.round(n))
}

function usageTitle(usage: TokenUsage): string {
  const parts: string[] = []
  if (usage.exact) {
    parts.push(
      `输入 ${usage.input}`,
      `输出 ${usage.output}`,
      `缓存 ${usage.cachedInput ?? 0}`,
      `推理 ${usage.reasoning ?? 0}`,
      `总计 ${usage.total}`
    )
  } else {
    parts.push('该模型不返回 token 明细')
  }
  if (usage.credit !== undefined) parts.push(`积分 ${usage.credit.toFixed(2)}`)
  if (usage.cost !== undefined) parts.push(`费用 ${usage.cost.toFixed(4)}`)
  return parts.join(' · ')
}

/** token 拿不到时给积分，否则什么都不给（不输出「Token 不可用」这类占位文案） */
function usageLine(usage: TokenUsage): string {
  if (usage.exact) return `Token ${short(usage.total)}`
  if (usage.credit !== undefined) return `积分 ${usage.credit.toFixed(2)}`
  return ''
}

/** 终端视图：xterm 实例由 terminalPool 常驻持有，这里只负责挂载/卸载 */
export default function TerminalView({ termId }: TerminalViewProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const shellRef = useRef<HTMLDivElement>(null)
  /** 当前该浮出哪个图标；鼠标不在滚动条两端时为 null */
  const [hint, setHint] = useState<'top' | 'bottom' | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host || !termId) return
    attachTerminal(termId, host)
    return () => detachTerminal(termId)
  }, [termId])

  // 图标只在贴住滚动条两端时显形：热区跟着鼠标走，平时不占位也不挡终端的点击
  const onMove = (e: ReactMouseEvent<HTMLDivElement>): void => {
    const box = shellRef.current?.getBoundingClientRect()
    if (!box || e.clientX < box.right - HINT_ZONE_WIDTH) {
      setHint(null)
      return
    }
    if (e.clientY <= box.top + HINT_ZONE_HEIGHT) setHint('top')
    else if (e.clientY >= box.bottom - HINT_ZONE_HEIGHT) setHint('bottom')
    else setHint(null)
  }

  return (
    <div
      ref={shellRef}
      className="terminal-shell"
      onMouseMove={onMove}
      onMouseLeave={() => setHint(null)}
    >
      <div ref={hostRef} className="terminal-view" />
      <button
        className={`term-scroll-hint top ${hint === 'top' ? 'on' : ''}`}
        tabIndex={-1}
        title="滚动到最顶部"
        onClick={() => scrollTerminalToTop(termId)}
      >
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
          <path
            d="M4.4 8.2 8 4.6l3.6 3.6"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path d="M4.4 11.6h7.2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </button>
      <button
        className={`term-scroll-hint bottom ${hint === 'bottom' ? 'on' : ''}`}
        tabIndex={-1}
        title="滚动到最底部"
        onClick={() => scrollTerminalToBottom(termId)}
      >
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
          <path
            d="M4.4 7.8 8 11.4l3.6-3.6"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path d="M4.4 4.4h7.2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  )
}

/**
 * 状态栏。主会话那条由工作台挂在整窗最底部（输出栏/变更栏下方），
 * 子终端那条留在各自卡片里 —— 所以它不跟 TerminalView 绑在一起。
 */
export function TerminalStatus({ info, statusExtra, gitBranch }: TerminalStatusProps): JSX.Element | null {
  const { cfg } = useSettings()
  const statusBarMode = cfg?.ui?.statusBarMode ?? 'always'
  const [hovering, setHovering] = useState(false)
  const [copied, setCopied] = useState(false)
  const [dirCopied, setDirCopied] = useState(false)
  const copyTimer = useRef<number | undefined>(undefined)
  const dirTimer = useRef<number | undefined>(undefined)

  useEffect(() => () => {
    window.clearTimeout(copyTimer.current)
    window.clearTimeout(dirTimer.current)
  }, [])

  const copyBranch = (): void => {
    if (!gitBranch) return
    void navigator.clipboard
      .writeText(gitBranch)
      .then(() => {
        setCopied(true)
        window.clearTimeout(copyTimer.current)
        copyTimer.current = window.setTimeout(() => setCopied(false), 1600)
      })
      .catch(() => undefined)
  }

  const workDir = info?.workDir
  const copyWorkDir = (): void => {
    if (!workDir) return
    void navigator.clipboard
      .writeText(workDir)
      .then(() => {
        setDirCopied(true)
        window.clearTimeout(dirTimer.current)
        dirTimer.current = window.setTimeout(() => setDirCopied(false), 1600)
      })
      .catch(() => undefined)
  }

  const usage = info?.usage
  const tokenLine = usage ? usageLine(usage) : null
  const showToken = !!tokenLine
  const phase = info?.runtime.phase
  const phaseLabel = phase ? PHASE_LABEL[phase] : '连接中'
  // 已就绪 = 空闲常态，异常只在顶部主会话卡片与加载层里给（状态栏这格留着是噪音），两者都不占位
  const showPhase = !info || (phase !== 'ready' && phase !== 'error')
  const bar = (floating: boolean): JSX.Element => (
    <div className={`terminal-status${floating ? ' terminal-status-float' : ''}`}>
      {showPhase ? (
        <>
          <span className={`status-dot ${phase ?? 'booting'}`} />
          <span title={info?.runtime.message}>
            {info?.runtime.submissionUncertain ? '提交待确认' : phaseLabel}
          </span>
        </>
      ) : null}
      {info?.runtime.deliveryAttempt ? <span>· 第 {info.runtime.deliveryAttempt} 次投递</span> : null}
      {/* CLI 类型从顶部页卡挪到这里：页卡窄、放不下档案名 + 类型两串字 */}
      {info ? <span className="status-cli" title={`CLI 类型：${info.cli}`}>{info.cli}</span> : null}
      {workDir ? (
        <span className="workdir-copy" title={`点击复制工作目录：${workDir}`} onClick={copyWorkDir}>
          <span className="workdir-name">{workDir}</span>
          {dirCopied ? <em className="copy-hint">已复制</em> : null}
        </span>
      ) : null}
      {gitBranch ? (
        <span className="branch-name" title="点击复制分支名" onClick={copyBranch}>
          · @{gitBranch}
          {copied ? <em className="copy-hint">已复制</em> : null}
        </span>
      ) : null}
      <span className="spacer" />
      {info?.model ? <span title="模型">{info.model}</span> : null}
      {/* 纯 shell 没有 token 这回事，别给它挂个「等待数据」 */}
      {info?.cli === 'shell' ? null : showToken ? (
        <span title={usageTitle(usage!)}>· {tokenLine}</span>
      ) : !usage ? (
        <span>· Token 等待数据</span>
      ) : null}
      {statusExtra ? <span className="terminal-status-extra">{statusExtra}</span> : null}
    </div>
  )
  if (statusBarMode === 'hidden') return null
  if (statusBarMode === 'hover') {
    // 热区常驻占一条窄边；浮出的整条状态栏 fixed 定位盖在终端上，
    // 它仍是热区的 DOM 后代 —— 指针移到栏上不会触发热区的 mouseleave
    return (
      <div
        className="terminal-status-hot"
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
      >
        {hovering ? bar(true) : null}
      </div>
    )
  }
  return bar(false)
}
