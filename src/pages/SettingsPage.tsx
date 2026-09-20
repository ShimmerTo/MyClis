import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  CHILD_TIMEOUT_MAX_MINUTES,
  CHILD_TIMEOUT_MIN_MINUTES,
  MAX_CHILD_RETRIES
} from '@shared/types'
import type { AppConfig, BridgeInfo, BuiltinCommandKind, CommandConfig, InjectionConfig, ThemeKind } from '@shared/types'
import { buildPresentInjection, DEFAULT_PROMPTS, PLACEHOLDER_HINT } from '@shared/skillPrompts'
import { installedClis, adoptConfig, applyTheme, saveConfig, useSettings } from '../store'
import { CliConfigListEditor, CliModelsEditor, Section, WorkDirsEditor } from '../components/SettingsSections'
import { AppShell, Chips } from '../components/AppShell'
import { ConfirmDialog } from '../components/ConfirmDialog'
import type { View } from '../components/AppShell'

interface Props {
  view: Extract<View, 'run' | 'ui' | 'commands'>
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
  /** 待确认的便签迁移目标目录：选完目录先问「是否迁移」，取消就完全不切换 */
  const [migrateDir, setMigrateDir] = useState<string | null>(null)
  /** 超时输入框的草稿：输入过程中先不动配置，失焦/回车时才夹到合法区间落盘 */
  const [timeoutDraft, setTimeoutDraft] = useState<string | null>(null)
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

  /** 选便签存储目录：选完先弹确认，问是否把现有数据迁过去（取消 = 放弃切换） */
  const pickNotesDir = (): void => {
    void window.clichilds
      .dirPick({ create: true })
      .then((dir) => {
        if (dir) setMigrateDir(dir)
      })
      .catch((e: unknown) => setSaveError(saveErrorMessage(e)))
  }

  const doMigrate = (): void => {
    const dir = migrateDir
    if (!dir) return
    window.clichilds
      .notesSetStorage({ dir })
      .then((next) => {
        adoptConfig(next)
        setMigrateDir(null)
        setSaveOk(true)
        window.clearTimeout(okTimer.current)
        okTimer.current = window.setTimeout(() => setSaveOk(false), 2000)
      })
      .catch((e: unknown) => {
        setMigrateDir(null)
        setSaveError(saveErrorMessage(e))
      })
  }

  const dirCount = cfg.workDirs.filter((d) => d.trim()).length
  const enabledCommands = cfg.commands.filter((command) => command.enabled).length
  const customCommands = cfg.commands.filter((command) => !command.builtinKind).length

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
      title={view === 'run' ? '设置 · 运行' : view === 'ui' ? '设置 · 界面' : '设置 · 命令'}
      desc={
        view === 'run'
          ? 'CLI、模型、运行权限、终端与工作目录；修改后立即生效'
          : view === 'ui'
            ? '子任务 CLI 窗口的展示形式、便签与系统通知'
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
      {migrateDir ? (
        <ConfirmDialog
          title="迁移便签存储目录"
          confirmText="迁移"
          onCancel={() => setMigrateDir(null)}
          onConfirm={doMigrate}
        >
          将把现有便签数据与图片资产迁移到下面这个目录，之后的新便签也保存在那里（仍按工作目录区分归属）。
          选择「取消」则不迁移，保持当前目录不变。
          <div className="settings-path" title={migrateDir}>
            {migrateDir}
          </div>
        </ConfirmDialog>
      ) : null}
      {view === 'commands' ? (
        <CommandsTab
          commands={cfg.commands}
          onChange={patchCommands}
          injections={cfg.injections}
          onInjectionsChange={(injections) => patch({ injections })}
        />
      ) : view === 'run' ? (
        <>
          <Section
            title="本机 CLI 检测"
            hint="codex / qoder / codebuddy / pi"
            action={<button onClick={() => void redetect()}>重新检测</button>}
          >
            <div className="cli-grid">
              {clis.map((c) => (
                <div key={c.id} className={`cli-card ${c.installed ? 'ok' : 'missing'}`}>
                  <div className="cli-top">
                    <span className="dot" />
                    <span className="cli-name">{c.label}</span>
                    {c.installed && <span className="cli-ver">{c.version}</span>}
                  </div>
                  <div className="cli-status">{c.installed ? '已安装' : '未检测到'}</div>
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

          <WorkDirsEditor dirs={cfg.workDirs} onChange={(dirs) => patch({ workDirs: dirs })} />

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
                }
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
                  ? `子任务窗口在右侧栏内横向平铺，每个固定 ${cfg.ui.tileWidth}px，放不下时横向滚动。`
                  : '子任务窗口在右侧栏内横向平铺，均分右侧可用宽度。'}
            </div>
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

          <Section title="便签" hint="状态栏浮窗的行为与数据存储位置">
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
              <label className="field">存储目录</label>
              <span className="hint settings-path" title={cfg.notes.storageDir || ''}>
                {cfg.notes.storageDir || '默认：应用数据目录（userData/clichilds）'}
              </span>
              <button type="button" onClick={pickNotesDir}>
                选择目录…
              </button>
            </div>
            <div className="callout">
              便签数据（notes.json 与图片资产）都存放在这里；选择新目录后会询问是否把现有数据迁移过去，
              迁移后仍按工作目录区分归属。选择「取消」则保持当前目录不变。
            </div>
          </Section>
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
  useEffect(() => {
    void window.clichilds.bridgeInfo().then(setBridge).catch(() => undefined)
  }, [])
  const toggleInjection = (id: string, enabled: boolean): void =>
    props.onInjectionsChange(props.injections.map((item) => (item.id === id ? { ...item, enabled } : item)))
  return (
    <>
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
        关闭命令后会从 CLI 中移除；自定义命令只执行提示词，不会自动分发子 CLI。
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
