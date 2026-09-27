import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  CHILD_TIMEOUT_MAX_MINUTES,
  CHILD_TIMEOUT_MIN_MINUTES,
  MAX_CHILD_RETRIES,
  POLL_INTERVAL_MIN_MINUTES,
  POLL_INTERVAL_MAX_MINUTES
} from '@shared/types'
import type { AppConfig, BridgeInfo, BuiltinCommandKind, CommandConfig, InjectionConfig, ThemeKind } from '@shared/types'
import { buildPresentInjection, DEFAULT_PROMPTS, PLACEHOLDER_HINT } from '@shared/skillPrompts'
import { installedClis, applyTheme, saveConfig, useSettings, waitForConfigSaves } from '../store'
import { CliManagement } from '../components/CliManagement'
import { DataDirectorySettings } from '../components/DataDirectorySettings'
import { toast } from '../components/ToastHost'
import { UpdateCard } from '../components/UpdateCard'
import { CliConfigListEditor, CliModelsEditor, Section, WorkDirsEditor } from '../components/SettingsSections'
import { AppShell, Chips } from '../components/AppShell'
import type { View } from '../components/AppShell'
import { SshSkillSettings } from '../ssh'

interface Props {
  view: Extract<View, 'dirs' | 'run' | 'ui' | 'commands'>
  onNav: (v: View) => void
}

const COMMAND_LABEL: Record<BuiltinCommandKind, string> = {
  design: '方案设计与校验',
  write: '代码编写',
  review: '代码检查'
}

function saveErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/i, '')
}

export default function SettingsPage({ view, onNav }: Props): JSX.Element {
  const { cfg, setCfg, clis, redetect, loadError } = useSettings()
  const [saveError, setSaveError] = useState('')
  const [saveOk, setSaveOk] = useState(false)
  const [cliChecking, setCliChecking] = useState(false)
  /** 超时输入框的草稿：输入过程中先不动配置，失焦/回车时才夹到合法区间落盘 */
  const [timeoutDraft, setTimeoutDraft] = useState<string | null>(null)
  const [pollDraft, setPollDraft] = useState<string | null>(null)
  const saveRevision = useRef(0)
  const okTimer = useRef<number | undefined>(undefined)
  const pendingSave = useRef<number | undefined>(undefined)
  const latestCfg = useRef<AppConfig | null>(null)

  // 离开设置页时把还在 debounce 里的最后一次输入立刻落盘，不能丢
  useEffect(() => () => {
    if (pendingSave.current === undefined) return
    window.clearTimeout(pendingSave.current)
    pendingSave.current = undefined
    if (latestCfg.current) void saveConfig(latestCfg.current).catch(() => undefined)
  }, [])

  if (loadError) return <div className="shell"><p className="error">加载失败：{loadError}</p></div>
  if (!cfg) return <div className="shell"><p className="hint">加载中…</p></div>

  const installed = installedClis(clis)
  /** debounceMs>0 时只推迟写盘：UI 立即反映输入，避免连打触发整轮注入 */
  const patch = (p: Partial<AppConfig>, debounceMs = 0): void => {
    const next = { ...cfg, ...p }
    latestCfg.current = next
    const revision = ++saveRevision.current
    setCfg(next)
    setSaveError('')
    window.clearTimeout(pendingSave.current)
    const commit = (): void => {
      pendingSave.current = undefined
      void saveConfig(next)
        .then(() => {
          if (revision !== saveRevision.current) return
          setSaveError('')
          setSaveOk(true)
          window.clearTimeout(okTimer.current)
          okTimer.current = window.setTimeout(() => setSaveOk(false), 2000)
        })
        .catch((e) => {
          if (revision !== saveRevision.current) return
          window.clearTimeout(okTimer.current)
          setSaveOk(false)
          setSaveError(saveErrorMessage(e))
          // 回滚到磁盘上最后一次成功保存的配置：本地闭包可能已落后于用户输入
          void window.clichilds.configGet().then((disk) => {
            latestCfg.current = disk
            setCfg(disk)
          }).catch(() => undefined)
        })
    }
    if (debounceMs > 0) pendingSave.current = window.setTimeout(commit, debounceMs)
    else commit()
  }
  const patchUi = (p: Partial<AppConfig['ui']>): void => patch({ ui: { ...cfg.ui, ...p } })
  const patchCommands = (commands: CommandConfig[], debounceMs = 0): void => patch({ commands }, debounceMs)

  const dirCount = cfg.workDirs.filter((d) => d.trim()).length
  const enabledCommands = cfg.commands.filter((command) => command.enabled).length
  const customCommands = cfg.commands.filter((command) => !command.builtinKind).length

  /** 数据目录迁移会重启应用：先冲刷还在 debounce 里的输入，不能让最后一轮输入丢掉 */
  const flushPendingSaves = async (): Promise<void> => {
    if (pendingSave.current !== undefined) {
      window.clearTimeout(pendingSave.current)
      pendingSave.current = undefined
      if (latestCfg.current) await saveConfig(latestCfg.current)
    }
    await waitForConfigSaves()
  }

  return (
    <AppShell
      view={view}
      onNav={onNav}
      theme={cfg.theme}
      onTheme={(t: ThemeKind) => {
        applyTheme(t)
        const next = { ...cfg, theme: t }
        setCfg(next)
        void saveConfig(next).catch(() => undefined)
      }}
      title={
        view === 'dirs' ? '设置 · 目录'
          : view === 'run' ? '设置 · Cli'
            : view === 'ui' ? '设置 · 界面' : '设置 · 命令'
      }
      desc={
        view === 'dirs'
          ? '主终端与子任务使用的工作目录清单；启动页从这里取目录'
          : view === 'run'
            ? '本机 CLI 检测、终端与 CLI 档案；修改立即生效'
            : view === 'ui'
              ? '子任务 CLI 窗口的展示形式、便签与系统通知；全局数据目录迁移需重启'
              : '管理内置命令、自定义命令及其注入开关'
      }
      chips={
        <Chips
          items={[
            { text: `CLI ${installed.length}/${clis.length}`, ok: installed.length > 0 },
            { text: `目录 ${dirCount}`, ok: dirCount > 0 },
            view === 'commands'
              ? { text: `已启用 ${enabledCommands}/${cfg.commands.length}`, ok: enabledCommands > 0 }
              : { text: `已配置 ${cfg.cliConfigs.length}`, ok: cfg.cliConfigs.length > 0 },
            ...(view === 'commands' ? [{ text: `自定义 ${customCommands}`, ok: customCommands > 0 }] : [])
          ]}
        />
      }
    >
      {saveOk &&
        createPortal(
          <div className="settings-toast ok" role="status">
            <span>已保存</span>
          </div>,
          document.body
        )}
      {saveError &&
        createPortal(
          <div className="settings-toast error" role="alert">
            <span>即时保存失败：{saveError}</span>
            <button type="button" onClick={() => setSaveError('')} aria-label="关闭提示">
              ✕
            </button>
          </div>,
          document.body
        )}
      {view === 'commands' ? (
        <>
          <SshSkillSettings />
          <CommandsTab
            commands={cfg.commands}
            onChange={patchCommands}
            injections={cfg.injections}
            onInjectionsChange={(injections) => patch({ injections })}
          />
        </>
      ) : view === 'dirs' ? (
        <WorkDirsEditor dirs={cfg.workDirs} onChange={(dirs) => patch({ workDirs: dirs })} />
      ) : view === 'run' ? (
        <>
          <Section
            title="本机 CLI 检测"
            hint="codex / qoder / codebuddy / pi"
            action={<button type="button" className="link cli-action" disabled={cliChecking} aria-busy={cliChecking}
              aria-label={cliChecking ? '正在重新检测' : '重新检测'} onClick={() => {
                setCliChecking(true)
                void redetect().catch((error: unknown) => toast(saveErrorMessage(error))).finally(() => setCliChecking(false))
              }}>
              {cliChecking ? <span className="cli-action-spinner" aria-hidden="true" /> : '重新检测'}
            </button>}
          >
            <div className="cli-grid">
              {clis.map((c) => (
                <div key={c.id} className={`cli-card ${c.installed ? 'ok' : 'missing'}`}>
                  <div className="cli-top">
                    <span className="dot" />
                    <span className="cli-name">{c.label}</span>
                    {c.installed && <span className="cli-ver">{c.version}</span>}
                  </div>
                  <CliManagement status={c} />
                  {c.installed && <div className="cli-path" title={c.path}>{c.path}</div>}
                  {c.diagnostics?.map((line) => <div key={line} className="cli-path" title={line}>{line}</div>)}
                </div>
              ))}
            </div>
          </Section>

          <Section title="终端" hint="主界面嵌入的伪终端类型">
            <div className="row">
              <label className="field">Shell</label>
              <select
                value={cfg.terminal}
                onChange={(e) => patch({ terminal: e.target.value as AppConfig['terminal'] })}
              >
                <option value="powershell">PowerShell</option>
                <option value="cmd">CMD</option>
                <option value="gitbash">Git Bash</option>
              </select>
            </div>
          </Section>

          <CliModelsEditor clis={clis} models={cfg.cliModels} onChange={(cliModels) => patch({ cliModels })} />

          <CliConfigListEditor
            items={cfg.cliConfigs}
            clis={clis}
            cliModels={cfg.cliModels}
            onChange={(items) => {
              const ids = new Set(items.map((item) => item.id))
              patch({
                cliConfigs: items,
                launch: {
                  mainCliId: ids.has(cfg.launch.mainCliId)
                    ? cfg.launch.mainCliId
                    : (items[0]?.id ?? ''),
                  workDir: cfg.launch.workDir,
                  designCliIds: cfg.launch.designCliIds.filter((id) => ids.has(id)),
                  codeWriterCliIds: cfg.launch.codeWriterCliIds.filter((id) => ids.has(id)),
                  codeReviewCliIds: cfg.launch.codeReviewCliIds.filter((id) => ids.has(id))
                },
                commands: cfg.commands.map((command) => command.builtinKind ? command : {
                  ...command,
                  childCliIds: (command.childCliIds ?? []).filter((id) => ids.has(id))
                })
              })
            }}
          />
        </>
      ) : (
        <>
          <Section title="终端打开模式" hint="执行页里在多个主 CLI 之间切换的交互">
            <div className="row">
              <label className="field">模式</label>
              <div className="seg">
                <button
                  className={cfg.ui.workbenchMode === 'hover' ? '' : 'on'}
                  onClick={() => patchUi({ workbenchMode: 'tabs' })}
                >
                  页卡模式
                </button>
                <button
                  className={cfg.ui.workbenchMode === 'hover' ? 'on' : ''}
                  onClick={() => patchUi({ workbenchMode: 'hover' })}
                >
                  隐藏式卡片
                </button>
              </div>
              <span className="hint">保存后立即生效</span>
            </div>
            <div className="callout">
              {cfg.ui.workbenchMode === 'hover'
                ? '顶部不占地方：鼠标移到窗口顶部时弹出悬浮卡片，列出运行中的主 CLI（含状态与问题），点一下切过去。'
                : '顶部常驻一条页卡栏 + 信息栏：每个运行中的主 CLI 一个页卡，点击切换，✕ 结束并关闭该会话。'}
            </div>
          </Section>

          <Section title="状态栏" hint="终端下方状态栏（运行状态 / 工作目录 / CLI 类型 / Token）的显示方案">
            <div className="row">
              <label className="field">显示方案</label>
              <select
                value={cfg.ui.statusBarMode}
                onChange={(e) => patchUi({ statusBarMode: e.target.value as AppConfig['ui']['statusBarMode'] })}
              >
                <option value="hidden">不显示</option>
                <option value="always">常驻显示（默认）</option>
                <option value="hover">鼠标移上时浮窗显示，移除隐藏</option>
              </select>
              <span className="hint">保存后立即生效</span>
            </div>
          </Section>

          <Section title="子任务窗口布局" hint="主界面右侧 CLI 窗口的展示形式">
            <div className="row">
              <label className="field">展示形式</label>
              <select
                value={cfg.ui.reviewerLayout}
                onChange={(e) => patchUi({ reviewerLayout: e.target.value as AppConfig['ui']['reviewerLayout'] })}
              >
                <option value="vertical">竖排（上下堆叠）</option>
                <option value="tile">平铺（左右并排）</option>
              </select>
            </div>

            {cfg.ui.reviewerLayout === 'tile' && (
              <>
                <div className="row">
                  <label className="field">宽度</label>
                  <div className="seg">
                    <button
                      className={cfg.ui.tileWidthMode === 'fixed' ? 'on' : ''}
                      onClick={() => patchUi({ tileWidthMode: 'fixed' })}
                    >
                      固定宽度
                    </button>
                    <button
                      className={cfg.ui.tileWidthMode === 'equal' ? 'on' : ''}
                      onClick={() => patchUi({ tileWidthMode: 'equal' })}
                    >
                      所有窗口均分
                    </button>
                  </div>
                </div>
                {cfg.ui.tileWidthMode === 'fixed' && (
                  <div className="row">
                    <label className="field">每格宽度</label>
                    <input
                      className="num"
                      type="number"
                      min={240}
                      max={1600}
                      step={20}
                      value={cfg.ui.tileWidth}
                      onChange={(e) => patchUi({ tileWidth: Number(e.target.value) || cfg.ui.tileWidth })}
                    />
                    <span className="hint">px（240 – 1600）</span>
                  </div>
                )}
              </>
            )}

            <div className="callout">
              {cfg.ui.reviewerLayout === 'vertical'
                ? '子任务窗口在右侧自上而下堆叠，各占一份高度。'
                : cfg.ui.tileWidthMode === 'fixed'
                  ? `子任务窗口在右侧栏内横向平铺，每格不超过 ${cfg.ui.tileWidth}px；放不下时向左挤压主终端，各格最低 150px，不出现横向滚动。`
                  : '子任务窗口在右侧栏内横向平铺，均分右侧可用宽度；放不下时向左挤压主终端，每格最低 150px，不出现横向滚动。'}
            </div>
          </Section>

          <Section title="主 CLI 轮询" hint="等待子 CLI 结果时，无状态变化的查询间隔">
            <div className="row">
              <label className="field" htmlFor="poll-interval">等待间隔</label>
              <input id="poll-interval" className="num" type="number" min={POLL_INTERVAL_MIN_MINUTES}
                max={POLL_INTERVAL_MAX_MINUTES} step={1}
                value={pollDraft ?? String(cfg.review.pollIntervalMinutes)}
                onChange={(event) => setPollDraft(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
                onBlur={() => {
                  const draft = pollDraft
                  setPollDraft(null)
                  if (draft === null || !draft.trim()) return
                  const parsed = Number(draft)
                  if (!Number.isFinite(parsed)) return
                  const minutes = Math.round(Math.min(POLL_INTERVAL_MAX_MINUTES, Math.max(POLL_INTERVAL_MIN_MINUTES, parsed)))
                  if (minutes !== cfg.review.pollIntervalMinutes) patch({ review: { ...cfg.review, pollIntervalMinutes: minutes } })
                }} />
              <span className="hint">分钟（默认 1，{POLL_INTERVAL_MIN_MINUTES} – {POLL_INTERVAL_MAX_MINUTES}）</span>
            </div>
            <div className="callout">保存后下一次等待生效；子任务完成、失败或需要审批时立即返回，不必等满间隔。此设置不改变子任务结果超时。</div>
          </Section>

          <Section title="子任务超时" hint="子任务多久没写出结果文件就判为失败">
            <div className="row">
              <label className="field">结果超时</label>
              <input
                className="num"
                type="number"
                min={CHILD_TIMEOUT_MIN_MINUTES}
                max={CHILD_TIMEOUT_MAX_MINUTES}
                step={5}
                value={timeoutDraft ?? String(cfg.review.childTimeoutMinutes)}
                onChange={(e) => setTimeoutDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur()
                }}
                onBlur={() => {
                  const draft = timeoutDraft
                  setTimeoutDraft(null)
                  if (draft === null || !draft.trim()) return
                  const parsed = Number(draft)
                  if (!Number.isFinite(parsed)) return
                  const minutes = Math.round(
                    Math.min(CHILD_TIMEOUT_MAX_MINUTES, Math.max(CHILD_TIMEOUT_MIN_MINUTES, parsed))
                  )
                  if (minutes !== cfg.review.childTimeoutMinutes) {
                    patch({ review: { ...cfg.review, childTimeoutMinutes: minutes } })
                  }
                }}
              />
              <span className="hint">分钟（{CHILD_TIMEOUT_MIN_MINUTES} – {CHILD_TIMEOUT_MAX_MINUTES}）</span>
            </div>
            <div className="callout">
              子任务被拉起后超过这个时间还没写出结果文件，即判为失败并唤醒主 CLI；主 CLI 会按同一任务参数
              重开它，每个子任务最多重试 {MAX_CHILD_RETRIES} 次。超时不会关掉窗口，你仍可以在右侧终端里查看它。
            </div>
          </Section>

          <Section title="系统通知" hint="某个 CLI 停止输出时提醒你回来查看">
            <div className="row">
              <label className="switch-field">
                <input
                  type="checkbox"
                  checked={cfg.notifications.cliIdle}
                  onChange={(e) => patch({ notifications: { ...cfg.notifications, cliIdle: e.target.checked } })}
                />
                {cfg.notifications.cliIdle ? '已开启' : '已关闭'}
              </label>
              <span className="hint">CLI 持续一段时间没有输出（默认 30 秒）时发一条系统通知，点击可切回本应用</span>
            </div>
          </Section>
          <Section title="窗口" hint="点右上角关闭按钮时的行为">
            <div className="row">
              <label className="field">关闭窗口时</label>
              <div className="seg">
                <button className={cfg.closeToTray ? 'on' : ''} onClick={() => patch({ closeToTray: true })}>
                  最小化到托盘
                </button>
                <button className={cfg.closeToTray ? '' : 'on'} onClick={() => patch({ closeToTray: false })}>
                  直接关闭
                </button>
              </div>
            </div>
            <div className="callout">
              {cfg.closeToTray
                ? '点关闭只隐藏窗口：终端、bridge 与后台会话继续跑；点托盘图标恢复，托盘菜单可显式退出。'
                : '点关闭直接退出应用：所有终端会话会跟着进程一起结束。'}
            </div>
          </Section>

          <Section title="便签" hint="浮窗行为与全局文字收集">
            <div className="row">
              <label className="field">浮窗行为</label>
              <div className="seg">
                <button
                  className={cfg.notes.panelMode === 'pinned' ? 'on' : ''}
                  onClick={() => patch({ notes: { ...cfg.notes, panelMode: 'pinned' } })}
                >
                  展开后常驻
                </button>
                <button
                  className={cfg.notes.panelMode === 'blur' ? 'on' : ''}
                  onClick={() => patch({ notes: { ...cfg.notes, panelMode: 'blur' } })}
                >
                  失去焦点后隐藏
                </button>
              </div>
            </div>
            <div className="callout">
              {cfg.notes.panelMode === 'blur'
                ? '点浮窗外面的地方就收起浮窗；把便签点在「新建会话」这类弹窗上时不会被误关。'
                : '浮窗一直留在屏幕上，点右上角「—」或按 Esc 才隐藏。'}
            </div>
            <div className="row">
              <label className="switch-field">
                <input type="checkbox" checked={cfg.notes.selectionCaptureEnabled}
                  onChange={(event) => patch({ notes: { ...cfg.notes, selectionCaptureEnabled: event.target.checked } })} />
                全局划词保存到便签（默认关闭）
              </label>
            </div>
            <div className="callout">
              开启后，在 MyClis 内或支持选区读取的外部应用中，用鼠标划选或双击选中文字，附近会出现「存到便签」，点击才保存到默认便签。浮动按钮不抢焦点，不占快捷键，不读取或修改剪贴板；未保存的选区只短暂保留在内存。密码框不会收集，Xshell 等未提供标准选区接口的自绘终端、部分页面或管理员窗口不支持时不显示按钮。MyClis 须保持运行（可隐藏到托盘）。
            </div>
          </Section>

          <DataDirectorySettings beforeMigrate={flushPendingSaves} />
          <UpdateCard
            config={cfg.update}
            onChange={(next) => patch({ update: { ...cfg.update, ...next } })}
          />
        </>
      )}
    </AppShell>
  )
}

function CommandsTab(props: {
  commands: CommandConfig[]
  onChange: (commands: CommandConfig[], debounceMs?: number) => void
  injections: InjectionConfig[]
  onInjectionsChange: (injections: InjectionConfig[]) => void
}): JSX.Element {
  const change = (id: string, patch: Partial<CommandConfig>, debounceMs = 0): void =>
    props.onChange(
      props.commands.map((command) => command.id === id ? { ...command, ...patch } : command),
      debounceMs
    )
  const [bridge, setBridge] = useState<BridgeInfo | null>(null)
  const [syncing, setSyncing] = useState(false)
  useEffect(() => {
    void window.clichilds.bridgeInfo().then(setBridge).catch((error: unknown) => toast(saveErrorMessage(error)))
  }, [])
  const syncCommands = async (): Promise<void> => {
    setSyncing(true)
    try {
      await window.clichilds.skillsSync()
      setBridge(await window.clichilds.bridgeInfo())
      toast('命令已同步；已启动 CLI 的缓存与系统提示需重新加载或恢复会话后生效')
    } catch (error) {
      toast(saveErrorMessage(error))
    } finally {
      setSyncing(false)
    }
  }
  const toggleInjection = (id: string, enabled: boolean): void =>
    props.onInjectionsChange(props.injections.map((item) => (item.id === id ? { ...item, enabled } : item)))
  return (
    <>
    <Section title="命令同步" hint="启动应用时自动同步，也可手动重新写入当前版本的命令"
      action={<button type="button" disabled={syncing} aria-busy={syncing} onClick={() => void syncCommands()}>{syncing ? '同步中…' : '重新同步命令'}</button>}>
      {bridge && <div className="hint">当前运行 MyClis {bridge.appVersion} · {bridge.packaged ? '打包版' : '开发版'}<div className="settings-path">{bridge.appPath}</div></div>}
      <div className="callout">同步使用当前运行应用的代码，不会加载磁盘上的新构建，也不会结束会话。升级应用请先保存工作，再退出旧实例并启动新版本；已运行 CLI 缓存的命令和启动注入不会自动替换。</div>
    </Section>
    <Section
      title="命令"
      hint="修改后立即重新注入已配置的 CLI"
      action={
        <button
          className="add"
          onClick={() => props.onChange([...props.commands, {
            id: crypto.randomUUID(),
            name: `my-command-${props.commands.filter((item) => !item.builtinKind).length + 1}`,
            enabled: true,
            allowChildClis: false,
            childCliIds: [],
            prompt: '请处理以下需求：\n{query}'
          }])}
        >
          + 新增命令
        </button>
      }
    >
      <div className="callout">
        命令正文只支持 {PLACEHOLDER_HINT}。三个内置命令会按当前会话配置附加子 CLI 调度协议；输出展示协议已移到下方「默认注入」，不写进命令文件。
        <br />
        关闭命令后会从 CLI 中移除；自定义命令默认只执行正文，勾选「允许自主调用子 CLI」才附加调度协议，请到启动页配置 CLI，下次主会话生效。
      </div>

      {props.commands.map((command) => {
        const kind = command.builtinKind
        /** 内置命令的空正文代表「内置默认」：直接铺到输入框里，方便在其上追加 */
        const fallback = kind ? DEFAULT_PROMPTS[kind] : ''
        const shown = kind && !command.prompt.trim() ? fallback : command.prompt
        const custom = !kind || (command.prompt.trim() !== '' && command.prompt !== fallback)
        return (
          <div className={`prompt-box ${command.enabled ? '' : 'disabled'}`} key={command.id}>
            <div className="row">
              <label className="switch-field">
                <input
                  type="checkbox"
                  checked={command.enabled}
                  onChange={(e) => change(command.id, { enabled: e.target.checked })}
                />
                {command.enabled ? '已启用' : '已关闭'}
              </label>
              <b>/{command.name}</b>
              <span className="hint">
                {kind ? `内置 · ${COMMAND_LABEL[kind]}` : '自定义'} · {custom ? '自定义正文' : '内置默认'} · {shown.length} 字符
              </span>
              <span className="spacer" />
              {kind ? <button onClick={() => change(command.id, { prompt: '' })}>恢复默认</button> : null}
              {!kind ? <button className="danger" onClick={() => props.onChange(props.commands.filter((item) => item.id !== command.id))}>删除</button> : null}
            </div>
            <div className="row">
              <label className="field">命令名</label>
              <span>/</span>
              <input value={command.name} maxLength={48} onChange={(e) => change(command.id, { name: e.target.value.replace(/^\//, '') })} />
            </div>
            {!kind && (
              <div className="row">
                <label className="switch-field">
                  <input
                    type="checkbox"
                    checked={command.allowChildClis === true}
                    onChange={(e) => change(command.id, { allowChildClis: e.target.checked })}
                  />
                  允许自主调用子 CLI
                </label>
                <span className="hint">到启动页配置 CLI；未开启时仅执行正文，开启后附加调度协议，不改动命令正文，下次主会话生效。</span>
              </div>
            )}
            <textarea
              className="prompt-area"
              spellCheck={false}
              value={shown}
              placeholder={kind ? DEFAULT_PROMPTS[kind] : '请输入命令提示词，使用 {query} 引用用户参数'}
              onChange={(e) => {
                const next = e.target.value
                // 清空或改回默认文案都归位到空串，重新走「内置默认」
                const isDefault = kind && (next.trim() === '' || next === fallback)
                change(command.id, { prompt: isDefault ? '' : next }, 400)
              }}
            />
          </div>
        )
      })}
    </Section>

    <Section title="默认注入" hint="启动主 CLI 时追加到它的系统提示，不写进命令文件；下次启动会话生效">
      <div className="callout">
        已支持启动注入的 CLI：qoder / codebuddy / pi / codex（codex 无追加参数，用 developer_instructions 承载）。只注入主终端，恢复历史会话同样生效，子 CLI 不注入。
      </div>
      {props.injections.map((item) => (
        <div className={`prompt-box ${item.enabled ? '' : 'disabled'}`} key={item.id}>
          <div className="row">
            <label className="switch-field">
              <input
                type="checkbox"
                checked={item.enabled}
                onChange={(e) => toggleInjection(item.id, e.target.checked)}
              />
              {item.enabled ? '已启用' : '已关闭'}
            </label>
            <b>{item.name}</b>
            <span className="hint">{item.description}</span>
          </div>
          {item.builtinKind === 'present' ? (
            <details className="injection-preview">
              <summary>查看注入正文（只读）</summary>
              <pre>
                {buildPresentInjection(
                  bridge ? `http://127.0.0.1:${bridge.port}` : 'http://127.0.0.1:<bridge 端口>',
                  '<本会话 id>'
                )}
              </pre>
            </details>
          ) : null}
        </div>
      ))}
    </Section>
    </>
  )
}
