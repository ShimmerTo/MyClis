import { useState } from 'react'
import type {
  AppConfig,
  CliConfig,
  CliId,
  CliStatus,
  DiscoveredSession,
  HistoryRecord,
  HistoryChild,
  SessionSummary
} from '@shared/types'
import { profileLabels } from '@shared/profile'
import type { TranscriptTab } from './TranscriptModal'
import { TranscriptModal } from './TranscriptModal'

export type HistoryScope = 'mineMain' | 'mine' | 'all' | 'cwd'

interface Props {
  cfg: AppConfig
  clis: CliStatus[]
  /** 存活的 pty 会话：同一个原生会话不允许活着两处 */
  sessions: SessionSummary[]
  history: HistoryRecord[]
  discovered: DiscoveredSession[]
  loading: boolean
  scope: HistoryScope
  workDir: string
  onScope: (s: HistoryScope) => void
  onRefresh: () => void
  /** 用 CLI 原生 resume 接上这条对话 */
  onResume: (workDir: string, profileId: string, cli: CliId, nativeSessionId: string) => void
  /** 详情弹窗里「用其他 CLI 继续」：交给启动页统一弹选择器 + 落盘交接记录 */
  onHandoff: (tab: TranscriptTab) => void
  onDelete: (sessionId: string) => void
}

interface Card {
  key: string
  cli: CliId
  cwd: string
  nativeSessionId?: string
  startedAt: number
  endedAt?: number
  title?: string
  initialQuery?: string
  mine: boolean
  record?: HistoryRecord
  child?: HistoryChild
  role?: 'main' | 'child'
  live: boolean
  dirMissing: boolean
}

const dirBase = (p: string): string => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p
const sameDir = (a: string, b: string): boolean =>
  a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase()

const TIME_OPTS: Intl.DateTimeFormatOptions = {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false
}

const stampTime = (ts?: number): string => (ts ? new Date(ts).toLocaleString('zh-CN', TIME_OPTS) : '')

const span = (from: number, to?: number): string => `${stampTime(from)} – ${to ? stampTime(to) : '…'}`

/** 右侧栏的历史会话：本应用启动的 + 从各 CLI 会话目录回填的 */
export function SessionHistoryRail(props: Props): JSX.Element {
  const [query, setQuery] = useState('')
  const [detail, setDetail] = useState<Card | null>(null)

  const liveNative = new Set(props.sessions.map((s) => s.nativeSessionId).filter((x): x is string => !!x))
  const cards: Card[] = []
  const seenNative = new Set<string>()
  const discoveredByNative = new Map(props.discovered.map((item) => [`${item.cli}|${item.nativeSessionId}`, item]))
  for (const record of props.history) {
    if (record.nativeSessionId) seenNative.add(`${record.cli}|${record.nativeSessionId}`)
    const found = record.nativeSessionId ? discoveredByNative.get(`${record.cli}|${record.nativeSessionId}`) : undefined
    cards.push({
      key: `h-${record.sessionId}`,
      cli: record.cli,
      cwd: record.workDir,
      nativeSessionId: record.nativeSessionId,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      title: found?.title,
      initialQuery: record.initialQuery ?? found?.initialQuery,
      mine: true,
      record,
      role: 'main',
      live: liveNative.has(record.nativeSessionId ?? ''),
      dirMissing: record.dirMissing ?? false
    })
    for (const child of record.children) {
      if (child.nativeSessionId) seenNative.add(`${child.cli}|${child.nativeSessionId}`)
      const childFound = child.nativeSessionId ? discoveredByNative.get(`${child.cli}|${child.nativeSessionId}`) : undefined
      cards.push({
        key: `hc-${child.termId}`,
        cli: child.cli,
        cwd: record.workDir,
        nativeSessionId: child.nativeSessionId,
        startedAt: child.startedAt,
        endedAt: child.endedAt,
        title: childFound?.title,
        initialQuery: child.initialQuery ?? childFound?.initialQuery,
        mine: true,
        record,
        child,
        role: 'child',
        live: liveNative.has(child.nativeSessionId ?? ''),
        dirMissing: record.dirMissing ?? false
      })
    }
  }
  for (const found of props.discovered) {
    if (seenNative.has(`${found.cli}|${found.nativeSessionId}`)) continue
    cards.push({
      key: `d-${found.cli}-${found.nativeSessionId}`,
      cli: found.cli,
      cwd: found.cwd,
      nativeSessionId: found.nativeSessionId,
      startedAt: found.startedAt,
      title: found.title,
      initialQuery: found.initialQuery,
      mine: found.mine,
      live: liveNative.has(found.nativeSessionId),
      dirMissing: found.dirMissing
    })
  }
  const needle = query.trim().toLowerCase()
  const shown = cards
    .filter((card) => {
      // 只看本应用启动的主 CLI：排除子任务与各 CLI 自己的会话
      if (props.scope === 'mineMain' && !(card.mine && card.role !== 'child')) return false
      if (props.scope === 'mine' && !card.mine) return false
      if (props.scope === 'cwd' && !sameDir(card.cwd, props.workDir)) return false
      if (!needle) return true
      return `${dirBase(card.cwd)} ${card.cwd} ${card.title ?? ''} ${card.initialQuery ?? ''} ${labelOf(card, props.clis)}`
        .toLowerCase()
        .includes(needle)
    })
    .sort((a, b) => (a.live === b.live ? b.startedAt - a.startedAt : a.live ? -1 : 1))

  return (
    <div className="history-rail">
      <div className="tasks-head">
        <h2>历史会话</h2>
        <span className="hint">
          {props.scope === 'mineMain'
            ? '只看本应用启动的主 CLI'
            : props.scope === 'mine'
              ? '本应用启动的主 / 子会话'
              : props.scope === 'cwd'
                ? '只看当前目录'
                : '含各 CLI 自己的会话'}
          {props.loading ? ' · 读取中…' : ''}
        </span>
      </div>
      <div className="session-filter">
        <select value={props.scope} onChange={(e) => props.onScope(e.target.value as HistoryScope)}>
          <option value="mineMain">本应用启动主 CLI</option>
          <option value="mine">本应用启动（主+子）</option>
          <option value="all">全部</option>
          <option value="cwd">仅当前目录</option>
        </select>
        <input placeholder="目录 / CLI / 标题" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button type="button" onClick={props.onRefresh} title="重新扫描各 CLI 的会话目录">
          刷新
        </button>
      </div>
      {shown.length === 0 && (
        <div className="hint">
          {props.scope === 'mineMain' && cards.some((c) => !(c.mine && c.role !== 'child'))
            ? '本应用还没启动过主 CLI 会话 —— 切「全部」可以看各 CLI 自己的历史'
            : props.scope === 'mine' && cards.some((c) => !c.mine)
              ? '本应用还没记录过会话 —— 切「全部」可以看各 CLI 自己的历史'
              : '没有符合条件的历史会话'}
        </div>
      )}
      {shown.map((card) => {
        const profile = targetOf(card, props.cfg, props.clis)
        const reason = reasonOf(card, profile, props.clis)
        const children = card.role === 'main' ? card.record?.children ?? [] : []
        const doneCount = children.filter((c) => c.done).length
        const resume = (): void => {
          if (!reason && profile && card.nativeSessionId) {
            props.onResume(card.cwd, profile.id, profile.cli, card.nativeSessionId)
          }
        }
        const foot = reason || (profile ? `恢复为 ${profileLabels(profile, props.clis).label}` : '')
        return (
          <div
            key={card.key}
            className={`task-card history ${reason ? 'quiet' : ''}`}
            tabIndex={0}
            title={card.cwd}
            onKeyDown={(e) => {
              if (e.key === 'Enter') resume()
            }}
          >
            <span className="task-top">
              <span className={`dot ${card.live ? 'ok' : 'idle'}`} />
              <b>{dirBase(card.cwd)}</b>
              {card.mine ? <span className="tag">本应用</span> : null}
              {card.role ? <span className="tag">{card.role === 'main' ? '主' : '次'}</span> : null}
              {card.live ? <span className="tag">运行中</span> : null}
            </span>
            <span className="task-sub">
              {labelOf(card, props.clis)}
              {card.title ? ` · ${card.title}` : ''}
            </span>
            {card.initialQuery ? <span className="task-query" title={card.initialQuery}>{card.initialQuery}</span> : null}
            <span className="task-sub dim">
              {card.record ? span(card.startedAt, card.endedAt) : stampTime(card.startedAt)}
              {children.length > 0 ? ` · 子任务 ${doneCount}/${children.length}` : ''}
            </span>
            <span className="task-sub dim task-path" title={card.cwd}>{card.cwd}</span>
            <span className="task-foot">
              <span className="dim">{foot}</span>
              <span className="task-actions">
                <button
                  type="button"
                  className="task-open"
                  disabled={!!reason}
                  title={reason || '用该 CLI 的原生 resume 接上这条对话'}
                  onClick={resume}
                >
                  继续
                </button>
                <button
                  type="button"
                  className="task-detail"
                  disabled={!card.nativeSessionId}
                  title={card.nativeSessionId ? '查看对话正文' : '未记录 session id，读不到正文'}
                  onClick={() => setDetail(card)}
                >
                  详情
                </button>
                {card.record ? (
                  <button
                    type="button"
                    className="task-kill"
                    title="从历史列表里移除这条记录（不会删 CLI 自己的会话文件）"
                    onClick={() => props.onDelete(card.record?.sessionId ?? '')}
                  >
                    移除
                  </button>
                ) : null}
              </span>
            </span>
          </div>
        )
      })}
      {detail ? (
        <TranscriptModal
          title={dirBase(detail.cwd)}
          subtitle={`${cliLabel(detail.cli, props.clis)} · ${span(detail.startedAt, detail.endedAt)}`}
          tabs={tabsOf(detail, props.clis)}
          onResume={detail.role === 'main' ? (() => {
            const profile = targetOf(detail, props.cfg, props.clis)
            const reason = reasonOf(detail, profile, props.clis)
            if (!reason && profile && detail.nativeSessionId) {
              setDetail(null)
              props.onResume(detail.cwd, profile.id, profile.cli, detail.nativeSessionId)
            }
          }) : undefined}
          resumeDisabledReason={detail.role === 'child' ? '子任务会话不支持继续' : reasonOf(detail, targetOf(detail, props.cfg, props.clis), props.clis)}
          onContinueOther={(t) => {
            setDetail(null)
            props.onHandoff(t)
          }}
          onClose={() => setDetail(null)}
        />
      ) : null}
    </div>
  )
}

function cliLabel(cli: CliId, clis: CliStatus[]): string {
  return clis.find((c) => c.id === cli)?.label ?? cli
}

function labelOf(card: Card, clis: CliStatus[]): string {
  return card.child?.profileLabel ?? card.record?.profileLabel ?? cliLabel(card.cli, clis)
}

/** 恢复用哪个档案：本应用的记档案，回填的只能挑同 CLI 且已安装的第一个 */
function targetOf(card: Card, cfg: AppConfig, clis: CliStatus[]): CliConfig | undefined {
  const own = card.child?.profileId ?? card.record?.profileId
  if (own !== undefined) return cfg.cliConfigs.find((p) => p.id === own)
  if (card.record) return undefined
  return cfg.cliConfigs.find((p) => p.cli === card.cli && clis.some((c) => c.id === p.cli && c.installed))
}

/** 能不能继续、不能的话为什么 */
function reasonOf(card: Card, target: CliConfig | undefined, clis: CliStatus[]): string {
  if (card.role === 'child') return '子任务会话不支持继续'
  if (card.live) return '这条会话还在运行'
  if (!card.nativeSessionId) return '未记录原生 session id'
  if (card.dirMissing) return '工作目录已不存在'
  if (!target && card.record) return '记录里的 CLI 档案已被删除'
  if (!target) return `没有 ${cliLabel(card.cli, clis)} 的 CLI 档案`
  return ''
}

function tabsOf(card: Card, clis: CliStatus[]): TranscriptTab[] {
  if (card.child) {
    return [{
      key: card.child.termId,
      label: card.child.profileLabel ?? cliLabel(card.child.cli, clis),
      cli: card.child.cli,
      nativeSessionId: card.child.nativeSessionId,
      cwd: card.cwd,
      done: card.child.done
    }]
  }
  const tabs: TranscriptTab[] = [
    {
      key: 'main',
      label: labelOf(card, clis),
      cli: card.cli,
      nativeSessionId: card.nativeSessionId,
      cwd: card.cwd
    }
  ]
  for (const child of card.record?.children ?? []) {
    const label = child.profileLabel ?? cliLabel(child.cli, clis)
    tabs.push({
      key: child.termId,
      label: `${child.index ? `${child.index}. ` : ''}${label}`,
      cli: child.cli,
      nativeSessionId: child.nativeSessionId,
      cwd: card.cwd,
      done: child.done
    })
  }
  return tabs
}
