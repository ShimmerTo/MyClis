import { useEffect, useState } from 'react'
import type { AppConfig, CliConfig, CliId, CliStatus, SessionSummary, TerminalProgram, ThemeKind } from '@shared/types'
import { profileLabels } from '@shared/profile'
import {
  applyTheme,
  installedClis,
  saveConfig,
  useDiscovered,
  useHistory,
  useNotes,
  useSessions,
  useSettings
} from '../store'
import { outputState, runTime } from '../display'
import { buildNotesPrompt, noteKindLabel, noteStamp, noteTitle, notesForDir, notesShowDone } from '../notes'
import { ShellRail } from '../components/AppShell'
import type { View } from '../components/AppShell'
import { ProfileChoiceGrid } from '../components/ProfileChoiceGrid'
import { ProfilePickerModal } from '../components/ProfilePickerModal'
import { SessionHistoryRail } from '../components/SessionHistoryRail'
import type { HistoryScope } from '../components/SessionHistoryRail'
import { NewTabModal } from '../components/NewTabModal'
import { TranscriptModal } from '../components/TranscriptModal'
import type { TranscriptTab } from '../components/TranscriptModal'
import { toast } from '../components/ToastHost'
import { buildHandoffText, handoffPrompt } from '../handoff'

interface Props {
  onNav: (v: View) => void
  /** initialPrompt：新会话就绪后自动投递的提示词（「用其他 CLI 继续」用） */
  onLaunch: (workDir: string, profileId: string, cli: CliId, initialPrompt?: string) => void
  /** 点击进入一个已在运行的会话 */
  onOpen: (s: SessionSummary) => void
  /** 用 CLI 原生 resume 接上一条历史会话 */
  onResume: (workDir: string, profileId: string, cli: CliId, nativeSessionId: string) => void
}

const TERMINAL_LABEL: Record<AppConfig['terminal'], string> = {
  powershell: 'PowerShell',
  cmd: 'CMD',
  gitbash: 'Git Bash'
}

const dirBase = (p: string): string => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p

/** 启动页：共用左侧导轨 + 直接列出工作目录与全部 CLI，选中即可启动 */
export default function LauncherPage({ onNav, onLaunch, onOpen, onResume }: Props): JSX.Element {
  const { cfg, setCfg, clis, loadError } = useSettings()
  const sessions = useSessions()
  const history = useHistory()
  const [scope, setScope] = useState<HistoryScope>('mineMain')
  const [pickDir, setPickDir] = useState('')
  const [pickProfileId, setPickProfileId] = useState('')
  /** 正在看正文的进行中会话 */
  const [detail, setDetail] = useState<SessionSummary | null>(null)
  /** 「用其他 CLI 继续」：待交接的会话页签，非空时弹选择器 */
  const [handoff, setHandoff] = useState<TranscriptTab | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  /** 要注入新会话的便签 id；换工作目录就清空 */
  const [checkedNoteIds, setCheckedNoteIds] = useState<Set<string>>(new Set())
  const [, tick] = useState(0)
  // 整表扫一次就够，切筛选只改渲染层的过滤
  const discovered = useDiscovered({ limit: 240 })
  const notes = useNotes()

  // 任务卡片上的运行时长/静默秒数需要自己走表
  useEffect(() => {
    const timer = setInterval(() => tick((v) => v + 1), 1000)
    return () => clearInterval(timer)
  }, [])

  // 换目录就清空勾选：上一个目录的便签不该跟着注入到新目录的会话里
  useEffect(() => setCheckedNoteIds(new Set()), [pickDir, cfg?.launch.workDir])

  if (loadError) return <div className="launch"><div className="boot"><p className="error">加载失败：{loadError}</p></div></div>
  if (!cfg) return <div className="launch"><div className="boot">加载中…</div></div>

  // 手动开的纯 shell 不算任务，启动页不列它（它只活在执行页的子终端区）
  const tasks = sessions.filter((s) => s.role !== 'shell')
  const mains = tasks.filter((s) => s.role === 'main')
  const childrenOf = (workDir: string): SessionSummary[] =>
    tasks.filter((s) => s.role === 'child' && s.workDir === workDir)
  // 只有子终端在跑的工作目录也要露出来
  const childOnlyDirs = [...new Set(tasks.filter((s) => s.role === 'child').map((s) => s.workDir))].filter(
    (d) => !mains.some((m) => m.workDir === d)
  )
  // 只有历史会话时右侧栏也要在：不然「继续」没地方点
  const hasTasks = tasks.length > 0 || history.length > 0 || discovered.sessions.length > 0

  const installed = installedClis(clis)
  const dirs = cfg.workDirs.filter((d) => d.trim())
  // 上次选中的目录可能已经在设置页被删掉：不在列表里就回落到第一个
  const savedDir = dirs.includes(cfg.launch.workDir) ? cfg.launch.workDir : ''
  const workDir = pickDir || savedDir || dirs[0] || ''
  const cliLabel = (id: TerminalProgram): string => clis.find((c) => c.id === id)?.label ?? id
  const availableProfiles = cfg.cliConfigs.filter((profile) =>
    installed.some((status) => status.id === profile.cli)
  )
  const savedMainAvailable = availableProfiles.some((profile) => profile.id === cfg.launch.mainCliId)
  const profileId =
    pickProfileId || (savedMainAvailable ? cfg.launch.mainCliId : '') || availableProfiles[0]?.id || ''
  const mainProfile = cfg.cliConfigs.find((profile) => profile.id === profileId)
  const mainLabels = mainProfile ? profileLabels(mainProfile, clis) : undefined
  const cliOk = !!mainProfile && availableProfiles.some((profile) => profile.id === mainProfile.id)
  // 注入列表默认过滤已完成，与浮窗/管理页共用同一个「显示已完成」开关
  const dirNotes = notesForDir(notes, workDir)
  const availableNotes = notesShowDone() ? dirNotes : dirNotes.filter((note) => note.status !== 'done')

  const savePatch = (p: Partial<AppConfig>): void => {
    const next = { ...cfg, ...p }
    setCfg(next)
    void saveConfig(next).catch(() => undefined)
  }
  const patchLaunch = (p: Partial<AppConfig['launch']>): void =>
    savePatch({ launch: { ...cfg.launch, ...p } })

  const changeTheme = (t: ThemeKind): void => {
    applyTheme(t)
    savePatch({ theme: t })
  }

  /** 进行中会话的正文页签：主会话一条，还在跑的每个子终端一条（纯 shell 没有正文，跳过） */
  const detailTabs = (m: SessionSummary): TranscriptTab[] => {
    if (m.cli === 'shell') return []
    const main: TranscriptTab = {
      key: m.id,
      label: m.profileLabel ?? cliLabel(m.cli),
      cli: m.cli,
      nativeSessionId: m.nativeSessionId,
      cwd: m.workDir
    }
    const subs = sessions
      .filter((s) => s.role === 'child' && s.parentTermId === m.id)
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .flatMap((s) =>
        s.cli === 'shell'
          ? []
          : [
              {
                key: s.id,
                label: `${s.index ? `${s.index}. ` : ''}${s.profileLabel ?? cliLabel(s.cli)}`,
                cli: s.cli,
                nativeSessionId: s.nativeSessionId,
                cwd: s.workDir,
                done: s.done
              }
            ]
      )
    return [main, ...subs]
  }

  const launch = async (): Promise<void> => {    setErr('')
    setBusy(true)
    try {
      if (!mainProfile) throw new Error('请选择主 CLI')
      // 目录与主 CLI 一起记住，下次进来直接是这次的组合
      const launchConfig = { ...cfg.launch, mainCliId: mainProfile.id, workDir }
      await saveConfig({ ...cfg, launch: launchConfig })
      // 勾选的便签随首条消息投递；不勾就按原来的空启动
      const picked = availableNotes.filter((note) => checkedNoteIds.has(note.id))
      const { text, omitted } = buildNotesPrompt(picked)
      if (omitted > 0) toast(`便签内容过长，已省略 ${omitted} 条`)
      onLaunch(workDir, mainProfile.id, mainProfile.cli, text || undefined)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
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
    onLaunch(dir, pid, cliId, handoffPrompt(path))
    setHandoff(null)
  }

  return (
    <div className={`launch ${hasTasks ? 'with-tasks' : ''}`}>
      <ShellRail view="launch" onNav={onNav} theme={cfg.theme} onTheme={changeTheme} />
      <div className="launch-split">
      <div className="launch-body">
        <div className="launch-hero">
          <h1>启动工作台</h1>
          <p className="sub">选择工作目录与主 CLI，点击下方「启动」进入嵌入式终端</p>
        </div>

        <section className="section">
          <div className="section-head">
            <h2>工作目录</h2>
            <span className="hint">启动后主终端在该目录运行</span>
            <span className="spacer" />
            <button onClick={() => onNav('run')}>管理</button>
          </div>
          {dirs.length === 0 && <div className="empty">还没有工作目录 —— 到左侧「运行」页添加至少 1 个。</div>}
          <div className="pick-grid">
            {dirs.map((d) => (
              <button
                key={d}
                className={`pick-card ${workDir === d ? 'on' : ''}`}
                onClick={() => {
                  setPickDir(d)
                  patchLaunch({ workDir: d })
                }}
                title={d}
              >
                <span className="pick-title">{d}</span>
                <span className="pick-sub">{workDir === d ? '已选中' : '点击选择'}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="section">
          <div className="section-head">
            <h2>主 CLI</h2>
            <span className="hint">从设置页配置的 CLI 中选择一个</span>
            <span className="spacer" />
            <button onClick={() => onNav('run')}>编辑配置</button>
          </div>
          <ProfileChoiceGrid
            profiles={cfg.cliConfigs}
            clis={clis}
            selectedIds={profileId ? [profileId] : []}
            onChange={(ids) => {
              const id = ids[0] ?? ''
              setPickProfileId(id)
              patchLaunch({ mainCliId: id })
            }}
          />
        </section>

        <TaskSelectionSection
          title="方案校验"
          command="myclis-design"
          hint="可多选"
          profiles={cfg.cliConfigs}
          clis={clis}
          selectedIds={cfg.launch.designCliIds}
          multiple
          onChange={(designCliIds) => patchLaunch({ designCliIds })}
        />

        <TaskSelectionSection
          title="代码编写"
          command="myclis-code"
          hint="可多选；按模块拆分，一个 CLI 一份开发文档"
          profiles={cfg.cliConfigs}
          clis={clis}
          selectedIds={cfg.launch.codeWriterCliIds}
          multiple
          onChange={(codeWriterCliIds) => patchLaunch({ codeWriterCliIds })}
        />

        <TaskSelectionSection
          title="代码检查"
          command="myclis-review"
          hint="可多选"
          profiles={cfg.cliConfigs}
          clis={clis}
          selectedIds={cfg.launch.codeReviewCliIds}
          multiple
          onChange={(codeReviewCliIds) => patchLaunch({ codeReviewCliIds })}
        />

        <section className="section">
          <div className="section-head">
            <h2>注入便签</h2>
            <span className="hint">勾选的便签会在会话就绪后作为第一条消息发出</span>
            <span className="spacer" />
            <button onClick={() => onNav('notes')}>管理</button>
          </div>
          {availableNotes.length === 0 ? (
            <div className="empty">
              {dirNotes.length > 0
                ? '该工作目录的便签都已完成了 —— 到「便签」页把状态改回未处理即可再注入。'
                : '该工作目录还没有便签 —— 到左侧「便签」页查看，或在终端里右键加入。'}
            </div>
          ) : (
            <div className="notes-pick">
              {availableNotes.map((note) => {
                const on = checkedNoteIds.has(note.id)
                return (
                  <label key={note.id} className={`notes-pick-row ${on ? 'on' : ''}`} title={note.content}>
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() =>
                        setCheckedNoteIds((old) => {
                          const next = new Set(old)
                          if (next.has(note.id)) next.delete(note.id)
                          else next.add(note.id)
                          return next
                        })
                      }
                    />
                    <span className="notes-pick-title">{noteTitle(note)}</span>
                    <span className={`note-kind ${note.kind}`}>{noteKindLabel(note.kind)}</span>
                    <span className="notes-pick-time">{noteStamp(note.createdAt)}</span>
                  </label>
                )
              })}
            </div>
          )}
        </section>

        <div className="launch-actions">
          <div className="launch-sum">
            {workDir && cliOk ? (
              <>
                <b>{mainLabels?.label ?? ''}</b>
                <span className="dim"> · {workDir}</span>
                <span className="dim">
                  {' · '}
                  {mainProfile?.model || 'CLI 默认模型'} · {mainLabels?.permissionLabel ?? ''} ·{' '}
                  {TERMINAL_LABEL[cfg.terminal]}
                </span>
              </>
            ) : (
              <span className="hint">请选择工作目录与可用的 CLI</span>
            )}
            {err && <span className="error">　{err}</span>}
          </div>
          <button
            className="primary lg"
            disabled={!workDir || !cliOk || busy}
            onClick={() => void launch()}
          >
            {busy ? '启动中…' : '启动 →'}
          </button>
        </div>
      </div>

        {hasTasks && (
          <aside className="launch-tasks">
            {tasks.length > 0 && (
              <>
                <div className="tasks-head">
                  <h2>进行中的任务</h2>
                  <span className="hint">
                    {mains.length} 个会话 · {tasks.length - mains.length} 个子终端
                  </span>
                </div>
                {mains.map((m) => {
                  const children = childrenOf(m.workDir)
                  const done = children.filter((child) => child.done).length
                  return (
                    <button key={m.id} className="task-card" onClick={() => onOpen(m)} title="点击进入该会话的终端">
                      <span className="task-top">
                        <span className="dot ok" />
                        <b>{dirBase(m.workDir)}</b>
                        <span className="tag">运行中</span>
                      </span>
                      <span className="task-sub">
                        {m.profileLabel ?? `${cliLabel(m.cli)}${m.model ? ` · ${m.model}` : ''}`} ·{' '}
                        {TERMINAL_LABEL[m.shell]}
                      </span>
                      {m.initialQuery ? (
                        <span className="task-query" title={m.initialQuery}>
                          {m.initialQuery}
                        </span>
                      ) : Date.now() - m.startedAt < 180_000 ? (
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
                  const children = childrenOf(d)
                  const done = children.filter((child) => child.done).length
                  return (
                    <div key={`child-${d}`} className="task-card quiet">
                      <span className="task-top">
                        <b>{dirBase(d)}</b>
                        <span className="tag">子任务</span>
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
              onScope={setScope}
              onRefresh={discovered.refresh}
              onResume={onResume}
              onHandoff={setHandoff}
              onDelete={(id) => {
                void window.clichilds.historyDelete(id).then(discovered.refresh).catch(() => undefined)
              }}
            />
          </aside>
        )}
      </div>

      {detail && (
        <TranscriptModal
          title={dirBase(detail.workDir)}
          subtitle={`${detail.profileLabel ?? cliLabel(detail.cli)} · 已运行 ${runTime(detail.startedAt)}`}
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
          workDirs={dirs}
          profiles={cfg.cliConfigs}
          clis={clis}
          defaultWorkDir={handoff.cwd || workDir}
          defaultProfileId={profileId}
          onStart={continueWith}
          onClose={() => setHandoff(null)}
        />
      )}
    </div>
  )
}

function TaskSelectionSection(props: {
  title: string
  command: string
  hint: string
  profiles: CliConfig[]
  clis: CliStatus[]
  selectedIds: string[]
  multiple?: boolean
  onChange: (ids: string[]) => void
}): JSX.Element {
  const [picking, setPicking] = useState(false)
  const remove = (id: string): void => props.onChange(props.selectedIds.filter((x) => x !== id))
  return (
    <section className="section">
      <div className="section-head">
        <h2>{props.title}</h2>
        <span className="hint">{props.hint}</span>
        <span className="spacer" />
        <button className="add" onClick={() => setPicking(true)}>
          + 添加 CLI
        </button>
      </div>
      {props.selectedIds.length === 0 ? (
        <div className="hint">点「+ 添加 CLI」添加</div>
      ) : (
        <div className="selected-list">
          {props.selectedIds.map((id, i) => {
            const profile = props.profiles.find((item) => item.id === id)
            if (!profile) return null
            const { permissionLabel, label } = profileLabels(profile, props.clis)
            return (
              <div key={id} className="selected-row">
                <span className="seq">{i + 1}</span>
                <b>{label}</b>
                <small>
                  {profile.model || '默认模型'} · {permissionLabel}
                </small>
                <span className="spacer" />
                <button className="danger" title="移除" onClick={() => remove(id)}>
                  ✕
                </button>
              </div>
            )
          })}
        </div>
      )}
      {picking && (
        <ProfilePickerModal
          title={props.title}
          command={props.command}
          profiles={props.profiles}
          clis={props.clis}
          selectedIds={props.selectedIds}
          multiple={!!props.multiple}
          onCommit={(ids) => {
            props.onChange(ids)
            setPicking(false)
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </section>
  )
}
