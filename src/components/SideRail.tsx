import { useCallback, useEffect, useRef, useState } from 'react'
import type { CliId, HistoryChild, SessionSummary, TerminalProgram } from '@shared/types'
import { latestHistoryChildren } from '@shared/children'
import { useDiscovered, useHistory, useSessions, useSettings } from '../store'
import { outputState, runTime, taskName } from '../display'
import { buildHandoffText, handoffPrompt } from '../handoff'
import { NewTabModal } from './NewTabModal'
import { TranscriptModal } from './TranscriptModal'
import type { TranscriptTab } from './TranscriptModal'
import { SessionHistoryRail } from './SessionHistoryRail'
import type { HistoryScope } from './SessionHistoryRail'
import { SshCardBadges, SshRailTodo } from '../ssh'
import { useSshScopes } from '../ssh/store'

interface Props {
  /** 点进行中任务卡片：回到那个已经在跑的会话，不新建 pty */
  onOpen: (s: SessionSummary) => void
  /** 用 CLI 原生 resume 接上一条历史会话 */
  onResume: (workDir: string, profileId: string, cli: CliId, nativeSessionId: string) => void
  /** 「用其他 CLI 继续」：带着交接 txt 起一个新会话 */
  onLaunch: (workDir: string, profileId: string, cli: CliId, initialPrompt?: string) => void
}

const dirBase = (p: string): string => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p

/** 常驻右侧栏：进行中的任务 + 历史会话，左侧任何菜单页都在 */
export function SideRail(props: Props): JSX.Element | null {
  const { cfg, clis, loadError } = useSettings()
  const sessions = useSessions()
  const history = useHistory()
  const [scope, setScope] = useState<HistoryScope>('mineMain')
  /** 正在看正文的进行中会话 */
  const [detail, setDetail] = useState<SessionSummary | null>(null)
  const [noteSelection, setNoteSelection] = useState<{ id: string } | null>(null)
  const selectedTask = useRef<HTMLButtonElement>(null)
  const locateRunning = useCallback((id: string | null): void => {
    setDetail(null)
    setNoteSelection(id ? { id } : null)
  }, [])
  useEffect(() => {
    selectedTask.current?.scrollIntoView({ block: 'nearest' })
    selectedTask.current?.focus({ preventScroll: true })
  }, [noteSelection])
  /** 「用其他 CLI 继续」：待交接的会话页签，非空时弹选择器 */
  const [handoff, setHandoff] = useState<TranscriptTab | null>(null)
  // 任务卡片上的运行时长/静默秒数需要自己走表
  const [, tick] = useState(0)
  // 整表扫一次就够，切筛选只改渲染层的过滤
  const discovered = useDiscovered({ limit: 240 })

  useEffect(() => {
    const timer = setInterval(() => tick((v) => v + 1), 1000)
    return () => clearInterval(timer)
  }, [])

  // 手动开的纯 shell 不算任务，这一栏不列它（它只活在执行页的子终端区）
  const tasks = sessions.filter((s) => s.role !== 'shell')
  const mains = tasks.filter((s) => s.role === 'main')
  /** 只合并该主会话的子终端；同目录的其它主会话不能串进计数与详情。 */
  const childrenOf = (mainId: string): HistoryChild[] => {
    const saved = latestHistoryChildren(history.find((record) => record.sessionId === mainId)?.children ?? [])
    const live = tasks.filter((s) => s.role === 'child' && s.parentTermId === mainId)
    const ended = saved.filter((child) => !live.some((s) => s.id === child.termId ||
      (!!child.nativeSessionId && s.cli === child.cli && s.nativeSessionId === child.nativeSessionId)))
    return latestHistoryChildren([
      ...ended,
      ...live.flatMap((s): HistoryChild[] => {
        if (s.cli === 'shell') return []
        const prior = saved.find((child) => child.termId === s.id)
        return [{
          ...prior,
          termId: s.id,
          cli: s.cli,
          nativeSessionId: s.nativeSessionId ?? prior?.nativeSessionId,
          profileLabel: s.profileLabel ?? prior?.profileLabel,
          index: s.index ?? prior?.index,
          done: s.done,
          startedAt: s.startedAt
        }]
      })
    ])
  }
  // 只有子终端在跑的工作目录也要露出来
  const childOnlyDirs = [...new Set(tasks.filter((s) => s.role === 'child').map((s) => s.workDir))].filter(
    (d) => !mains.some((m) => m.workDir === d)
  )
  // 认证请求与开着的终端只带项目 scopeId：把这一栏出现过的目录都解析一遍，归不到卡片的才进栏头兜底
  const railDirs = [
    ...new Set([
      ...tasks.map((s) => s.workDir),
      ...history.map((r) => r.workDir),
      ...discovered.sessions.map((s) => s.cwd)
    ])
  ]
  const { scopes } = useSshScopes(railDirs)

  if (loadError) return <aside className="side-rail"><p className="error">会话列表加载失败：{loadError}</p></aside>
  if (!cfg) return <aside className="side-rail"><div className="boot">加载中…</div></aside>

  const cliLabel = (id: TerminalProgram): string => clis.find((c) => c.id === id)?.label ?? id
  const scopeIdOf = (workDir: string): string | undefined => scopes.get(workDir)?.scopeId
  const attributed = new Set<string>()
  scopes.forEach((item) => {
    if (item) attributed.add(item.scopeId)
  })
  const workDir = cfg.launch.workDir

  /** 正文页签包含主会话及去重后的存活 / 已结束子对话，纯 shell 不参与。 */
  const detailTabs = (m: SessionSummary): TranscriptTab[] => {
    if (m.cli === 'shell') return []
    const main: TranscriptTab = {
      key: m.id,
      label: m.profileLabel ?? cliLabel(m.cli),
      cli: m.cli,
      nativeSessionId: m.nativeSessionId,
      cwd: m.workDir
    }
    const subs = childrenOf(m.id)
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .map((child) => ({
        key: child.termId,
        label: `${child.index ? `${child.index}. ` : ''}${child.profileLabel ?? cliLabel(child.cli)}`,
        cli: child.cli,
        nativeSessionId: child.nativeSessionId,
        cwd: m.workDir,
        done: child.done
      }))
    return [main, ...subs]
  }

  /**
   * 「用其他 CLI 继续」：先把被交接会话的问答整理成 txt 落盘，
   * 再用选定的目录/CLI 开一个新会话，并把「当前任务完成的历史记录：<path>，请继续完成」投进去。
   */
  const continueWith = async (dir: string, pid: string, cliId: CliId): Promise<void> => {
    const tab = handoff
    if (!tab?.nativeSessionId) throw new Error('这条会话没记录原生 session id，读不到正文')
    const page = await window.clichilds.transcriptRead({
      cli: tab.cli,
      nativeSessionId: tab.nativeSessionId,
      cwd: tab.cwd
    })
    const text = buildHandoffText(
      { label: tab.label, cli: tab.cli, cwd: tab.cwd, nativeSessionId: tab.nativeSessionId },
      page
    )
    const { path } = await window.clichilds.handoffWrite({
      name: `${tab.label}-${tab.cwd ? dirBase(tab.cwd) : 'session'}`,
      text
    })
    props.onLaunch(dir, pid, cliId, handoffPrompt(path))
    setHandoff(null)
  }

  return (
    <aside className="side-rail">
      <SshRailTodo attributedScopeIds={attributed} />
      {tasks.length > 0 && (
        <>
          <div className="tasks-head">
            <h2>进行中的任务</h2>
            <span className="hint">
              {mains.length} 个会话 · {tasks.length - mains.length} 个子终端
            </span>
          </div>
          {mains.map((m) => {
            const children = childrenOf(m.id)
            const done = children.filter((child) => child.done).length
            const noteSelected = noteSelection?.id === m.id
            const name = taskName(m.title, m.initialQuery, dirBase(m.workDir))
            return (
              <button key={m.id} ref={noteSelected ? selectedTask : undefined}
                className={`task-card ${noteSelected ? 'note-selected' : ''}`} onClick={() => props.onOpen(m)} title="点击进入该会话的终端">
                <span className="task-top">
                  <span className="dot ok" />
                  <b title={m.workDir}>{name.text}</b>
                  <span className="tag">运行中</span>
                  {children.length > 0 ? <span className="tag">子 CLI {children.length}</span> : null}
                  <SshCardBadges sessionId={m.id} scopeId={scopeIdOf(m.workDir)} />
                </span>
                <span className="task-sub">
                  {cliLabel(m.cli)} · {m.model || '默认'} · {dirBase(m.workDir)}
                </span>
                {!name.fromQuery && m.initialQuery ? (
                  <span className="task-query" title={m.initialQuery}>
                    {m.initialQuery}
                  </span>
                ) : !m.initialQuery && Date.now() - m.startedAt < 180_000 ? (
                  <span className="task-sub dim">等待首条消息…</span>
                ) : null}
                <span className="task-sub dim">
                  已运行 {runTime(m.startedAt)} · {outputState(m.lastOutputAt)}
                </span>
                {children.length > 0 && (
                  <span className="task-sub">
                    子任务 {done}/{children.length} 完成
                  </span>
                )}
                <span className="task-foot">
                  <span className="dim" title={m.workDir}>
                    {m.workDir}
                  </span>
                  <span className="task-actions">
                    <span
                      className="task-detail"
                      role="button"
                      title={m.nativeSessionId ? '查看该会话的对话正文' : '未记录 session id，读不到正文'}
                      onClick={(e) => {
                        e.stopPropagation()
                        setDetail(m)
                      }}
                    >
                      详情
                    </span>
                    <span
                      className="task-kill"
                      role="button"
                      title="结束该会话的终端进程"
                      onClick={(e) => {
                        e.stopPropagation()
                        window.clichilds.termKill(m.id)
                      }}
                    >
                      结束
                    </span>
                  </span>
                </span>
              </button>
            )
          })}
          {childOnlyDirs.map((d) => {
            const children = tasks.filter((s) => s.role === 'child' && s.workDir === d)
            const done = children.filter((child) => child.done).length
            return (
              <div key={`child-${d}`} className="task-card quiet">
                <span className="task-top">
                  <b>{dirBase(d)}</b>
                  <span className="tag">子任务</span>
                  <SshCardBadges scopeId={scopeIdOf(d)} />
                </span>
                <span className="task-sub">
                  子任务 {done}/{children.length} 完成
                </span>
                <span className="task-foot dim">{d}</span>
              </div>
            )
          })}
          <p className="hint">点卡片直接切回对应终端</p>
        </>
      )}
      <SessionHistoryRail
        cfg={cfg}
        clis={clis}
        sessions={sessions}
        history={history}
        discovered={discovered.sessions}
        loading={discovered.loading}
        scope={scope}
        workDir={workDir}
        scopeIdOf={scopeIdOf}
        onScope={setScope}
        onRefresh={discovered.refresh}
        onLocateRunning={locateRunning}
        onResume={props.onResume}
        onHandoff={setHandoff}
        onDelete={(id) => {
          void window.clichilds.historyDelete(id).then(discovered.refresh).catch(() => undefined)
        }}
      />

      {detail && (
        <TranscriptModal
          title={taskName(detail.title, detail.initialQuery, dirBase(detail.workDir)).text}
          subtitle={`${cliLabel(detail.cli)} · ${detail.model || '默认'} · 已运行 ${runTime(detail.startedAt)}`}
          tabs={detailTabs(detail)}
          resumeDisabledReason="这条会话还在运行"
          onContinueOther={(t) => {
            setDetail(null)
            setHandoff(t)
          }}
          onClose={() => setDetail(null)}
        />
      )}

      {handoff && (
        <NewTabModal
          title="用其他 CLI 继续"
          hint={`把「${handoff.label}」的提问与回复整理成 txt，再用新 CLI 接着做`}
          submitLabel="交接并启动"
          workDirs={cfg.workDirs.filter((d) => d.trim())}
          profiles={cfg.cliConfigs}
          clis={clis}
          defaultWorkDir={handoff.cwd || workDir}
          defaultProfileId={cfg.launch.mainCliId}
          onStart={continueWith}
          onClose={() => setHandoff(null)}
        />
      )}
    </aside>
  )
}
