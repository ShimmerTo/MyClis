import { useEffect, useState } from 'react'
import type { AppConfig, CliConfig, CliId, CliStatus, ThemeKind } from '@shared/types'
import { profileLabels } from '@shared/profile'
import {
  applyTheme,
  installedClis,
  saveConfig,
  useNotes,
  useSettings
} from '../store'
import { buildNotesPrompt, noteKindLabel, noteStamp, noteTitle, notesForDir, notesShowDone } from '../notes'
import { ShellRail } from '../components/AppShell'
import type { View } from '../components/AppShell'
import { ProfileChoiceGrid } from '../components/ProfileChoiceGrid'
import { ProfilePickerModal } from '../components/ProfilePickerModal'
import { toast } from '../components/ToastHost'

interface Props {
  onNav: (v: View) => void
  /** initialPrompt：新会话就绪后自动投递的提示词（「用其他 CLI 继续」用） */
  onLaunch: (workDir: string, profileId: string, cli: CliId, initialPrompt?: string, noteIds?: string[]) => void
}

const TERMINAL_LABEL: Record<AppConfig['terminal'], string> = {
  powershell: 'PowerShell',
  cmd: 'CMD',
  gitbash: 'Git Bash'
}

/** 启动页：共用左侧导轨 + 直接列出工作目录与全部 CLI，选中即可启动；会话栏由应用层常驻在右侧 */
export default function LauncherPage({ onNav, onLaunch }: Props): JSX.Element {
  const { cfg, setCfg, clis, loadError } = useSettings()
  const [pickDir, setPickDir] = useState('')
  const [pickProfileId, setPickProfileId] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  /** 要注入新会话的便签 id；换工作目录就清空 */
  const [checkedNoteIds, setCheckedNoteIds] = useState<Set<string>>(new Set())
  const notes = useNotes()

  // 换目录就清空勾选：上一个目录的便签不该跟着注入到新目录的会话里
  useEffect(() => setCheckedNoteIds(new Set()), [pickDir, cfg?.launch.workDir])

  if (loadError) return <div className="launch"><div className="boot"><p className="error">加载失败：{loadError}</p></div></div>
  if (!cfg) return <div className="launch"><div className="boot">加载中…</div></div>

  const installed = installedClis(clis)
  const dirs = cfg.workDirs.filter((d) => d.trim())
  // 上次选中的目录可能已经在设置页被删掉：不在列表里就回落到第一个
  const savedDir = dirs.includes(cfg.launch.workDir) ? cfg.launch.workDir : ''
  const workDir = pickDir || savedDir || dirs[0] || ''
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
    setErr('')
    void saveConfig(next).catch((e: unknown) => {
      setErr(`保存失败：${e instanceof Error ? e.message : String(e)}`)
    })
  }
  const patchLaunch = (p: Partial<AppConfig['launch']>): void =>
    savePatch({ launch: { ...cfg.launch, ...p } })

  const changeTheme = (t: ThemeKind): void => {
    applyTheme(t)
    savePatch({ theme: t })
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
      onLaunch(workDir, mainProfile.id, mainProfile.cli, text || undefined, picked.slice(0, picked.length - omitted).map((note) => note.id))
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <div className="launch">
      <ShellRail view="launch" onNav={onNav} theme={cfg.theme} onTheme={changeTheme} />
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
          {dirs.length === 0 && <div className="empty">还没有工作目录 —— 到左侧「目录」页添加至少 1 个。</div>}
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

        {cfg.commands.filter((command) => command.enabled && !command.builtinKind).map((command) => (
          <TaskSelectionSection
            key={command.id}
            title={command.name}
            command={command.name}
            hint={command.allowChildClis === true
              ? '可多选；已允许自主调用子 CLI，选择在下次主会话生效'
              : '可先多选 CLI；未开启「允许自主调用子 CLI」时不会调度，开启后下次主会话生效'}
            profiles={cfg.cliConfigs}
            clis={clis}
            selectedIds={command.childCliIds ?? []}
            multiple
            onChange={(childCliIds) => savePatch({
              commands: cfg.commands.map((item) => item.id === command.id ? { ...item, childCliIds } : item)
            })}
          />
        ))}

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
