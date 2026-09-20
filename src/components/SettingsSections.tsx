import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ReactNode } from 'react'
import type { CliConfig, CliId, CliModelLists, CliStatus } from '@shared/types'
import { autoAlias, permissionLabelOf } from '@shared/profile'

export function Section(props: {
  title: string
  hint?: string
  action?: ReactNode
  children: ReactNode
}): JSX.Element {
  return (
    <section className="section">
      <div className="section-head">
        <h2>{props.title}</h2>
        {props.hint && <span className="hint">{props.hint}</span>}
        <span className="spacer" />
        {props.action}
      </div>
      {props.children}
    </section>
  )
}

let seq = 0
function newId(): string {
  seq += 1
  return `cli-${Date.now().toString(36)}-${seq}`
}

/** 单行模型测试的状态；undefined = 还没测过 */
interface TestState {
  running: boolean
  ok?: boolean
}

/** 右上角测试结论提示，5 秒后自动消失 */
interface TestToast {
  ok: boolean
  text: string
}

const TEST_ICON = { idle: '▶', ok: '✓' } as const
const TEST_TOAST_MS = 5000

/** 模型清单的文本草稿 -> 清单：去空、去重，顺序保持用户输入的先后 */
function parseModels(text: string): string[] {
  return [...new Set(text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))]
}

/** 统一 CLI 档案编辑器：每项 = CLI + 模型 + CLI 专属运行权限。 */
export function CliConfigListEditor(props: {
  items: CliConfig[]
  clis: CliStatus[]
  /** 各 CLI 类型的可用模型清单（「可用模型」卡片维护），只作为模型输入的下拉候选 */
  cliModels: CliModelLists
  onChange: (items: CliConfig[]) => void
}): JSX.Element {
  const { items, clis, cliModels } = props
  const installed = clis.filter((cli) => cli.installed)
  const firstCli = installed[0]
  const [tests, setTests] = useState<Record<string, TestState>>({})
  const [toast, setToast] = useState<TestToast | null>(null)
  const toastTimer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(toastTimer.current), [])

  /** 模型换了或 CLI 换了，上一次的测试结论就不作数了 */
  const clearTest = (rowId: string): void =>
    setTests((current) => (current[rowId] ? { ...current, [rowId]: { running: false } } : current))

  /** 结论只弹右上角，5 秒后自动收起 */
  const showToast = (next: TestToast): void => {
    setToast(next)
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), TEST_TOAST_MS)
  }

  const runTest = async (item: CliConfig): Promise<void> => {
    setTests((current) => ({ ...current, [item.id]: { running: true } }))
    const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`
    const label = clis.find((cli) => cli.id === item.cli)?.label ?? item.cli
    const finish = (ok: boolean): void =>
      setTests((current) => ({ ...current, [item.id]: ok ? { running: false, ok: true } : { running: false } }))
    try {
      const res = await window.clichilds.cliModelTest({ cli: item.cli, model: item.model ?? '' })
      finish(res.ok)
      showToast(
        res.ok
          ? {
              ok: true,
              text: `${label} 测试通过 · 耗时 ${seconds(res.elapsedMs)}${res.reply ? ` · 模型回显：${res.reply}` : ''}`
            }
          : { ok: false, text: `${label} 测试失败：${res.error ?? '未知原因'}` }
      )
    } catch (e) {
      finish(false)
      showToast({
        ok: false,
        text: `${label} 测试失败：${e instanceof Error ? e.message : String(e)}`
      })
    }
  }

  // 只给当前用到的 CLI 渲染候选表，避免同名 datalist 重复
  const listIds = [...new Set(items.map((item) => item.cli))].filter(
    (id) => (cliModels[id] ?? []).length > 0
  )

  return (
    <Section
      title="CLI 设置"
      hint="可添加多个 CLI、模型与权限组合；别名留空 = CLI名-模型名-权限名；▶ = 用该行的模型实跑一次测试"
      action={
        <button
          className="add"
          disabled={!firstCli}
          title={firstCli ? undefined : '未检测到已安装的 CLI'}
          onClick={() =>
            firstCli &&
            props.onChange([
              ...items,
              { id: newId(), cli: firstCli.id, alias: '', model: '', permissionMode: 'default' }
            ])
          }
        >
          + 添加 CLI
        </button>
      }
    >
      {toast &&
        createPortal(
          <div className={`settings-toast cli-test-toast ${toast.ok ? 'ok' : 'error'}`} role="status">
            <span className="toast-text">{toast.text}</span>
            <button type="button" onClick={() => setToast(null)} aria-label="关闭提示">
              ✕
            </button>
          </div>,
          document.body
        )}
      {items.length === 0 && (
        <div className="empty">
          {firstCli
            ? '尚未配置 CLI。添加后可在启动页分配主 CLI 和三类子任务。'
            : '未检测到已安装的 CLI，先安装并重新检测后再添加。'}
        </div>
      )}
      {items.map((item, i) => {
        const status = clis.find((cli) => cli.id === item.cli)
        // 下拉只列已检测到的 CLI；已保存档案若其 CLI 当前未检测到，保留自身一项以便改选
        const cliOptions = status && !status.installed ? [...installed, status] : installed
        const permissionOptions = status?.permissionOptions ?? []
        const permission =
          permissionOptions.find((option) => option.id === item.permissionMode) ?? permissionOptions[0]
        const auto = autoAlias(
          status?.label ?? item.cli,
          item.model ?? '',
          permissionLabelOf(permissionOptions, item.permissionMode)
        )
        const update = (patch: Partial<CliConfig>): void => {
          const next = [...items]
          next[i] = { ...item, ...patch }
          props.onChange(next)
        }
        const candidates = cliModels[item.cli] ?? []
        const listId = candidates.length > 0 ? `cli-model-${item.cli}` : undefined
        const modelTitle = candidates.length > 0
          ? `${candidates.length} 条候选来自「可用模型」卡片；也可直接手输；留空 = CLI 默认模型`
          : '「可用模型」卡片里还没有这个 CLI 的候选，直接手输；留空 = CLI 默认模型'
        const test = tests[item.id]
        const testDisabled = !status?.installed || !status?.canTestModel || Boolean(test?.running)
        const testTitle = !status?.installed
          ? '未检测到该 CLI'
          : !status?.canTestModel
            ? `${status?.label ?? item.cli} 不支持非交互测试`
            : `用${item.model ? `模型 ${item.model}` : ' CLI 默认模型'}实跑一次最小测试（真实调用模型，可能耗时较久）`
        return (
          <div className="cli-config-row" key={item.id}>
            <span className="idx">{i + 1}</span>
            <input
              className="alias"
              placeholder={auto}
              maxLength={40}
              title={`档案显示名；留空 = ${auto}`}
              value={item.alias ?? ''}
              onChange={(e) => update({ alias: e.target.value })}
            />
            <select
              value={item.cli}
              onChange={(e) => {
                clearTest(item.id)
                update({ cli: e.target.value as CliId, permissionMode: 'default' })
              }}
            >
              {cliOptions.map((cli) => (
                <option key={cli.id} value={cli.id}>
                  {cli.label}{cli.installed ? '' : '（未检测到）'}
                </option>
              ))}
            </select>
            <input
              placeholder="模型（留空 = CLI 默认）"
              list={listId}
              title={modelTitle}
              value={item.model ?? ''}
              onChange={(e) => {
                clearTest(item.id)
                update({ model: e.target.value })
              }}
            />
            <select
              className={permission?.dangerous ? 'danger-select' : ''}
              value={permission?.id ?? 'default'}
              title={permission?.description}
              onChange={(e) => update({ permissionMode: e.target.value })}
            >
              {permissionOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
            <span className="permission-hint" title={permission?.description}>
              {permission?.description}
            </span>
            <span className="cli-row-actions">
              <button
                className={`cli-test ${test?.running ? 'running' : test?.ok ? 'ok' : ''}`}
                disabled={testDisabled}
                title={testTitle}
                aria-label="测试该模型"
                onClick={() => void runTest(item)}
              >
                {test?.running ? <span className="cli-test-spin" /> : test?.ok ? TEST_ICON.ok : TEST_ICON.idle}
              </button>
              <button
                className="danger"
                onClick={() => props.onChange(items.filter((entry) => entry.id !== item.id))}
                title="删除"
              >
                ✕
              </button>
            </span>
          </div>
        )
      })}
      {listIds.map((id) => (
        <datalist id={`cli-model-${id}`} key={id}>
          {cliModels[id].map((model) => (
            <option key={model} value={model} />
          ))}
        </datalist>
      ))}
    </Section>
  )
}

/**
 * 可用模型清单编辑器：每个 CLI 类型一张卡片，一行一个模型。
 * 这是模型候选的唯一来源（不再去问 CLI 自己）；CLI 档案里的模型输入仍可直接手输。
 */
export function CliModelsEditor(props: {
  clis: CliStatus[]
  models: CliModelLists
  onChange: (models: CliModelLists) => void
}): JSX.Element {
  const { clis, models } = props
  /** 文本草稿：空行、敲到一半的模型名都留在草稿里，提交给配置的永远是去空后的清单 */
  const [drafts, setDrafts] = useState<Partial<Record<CliId, string>>>({})

  // 配置被外部改写（保存失败回滚、重新加载）时丢掉草稿，别让界面停在旧文本上
  useEffect(() => {
    setDrafts((current) => {
      const next = { ...current }
      let dropped = false
      for (const [cli, draft] of Object.entries(current) as [CliId, string][]) {
        if (parseModels(draft).join('\n') === (models[cli] ?? []).join('\n')) continue
        delete next[cli]
        dropped = true
      }
      return dropped ? next : current
    })
  }, [models])

  return (
    <Section
      title="可用模型"
      hint="手工维护，每行一个；CLI 设置里的模型输入用它做候选，仍可直接手输"
    >
      <div className="cli-grid">
        {clis.map((cli) => (
          <div className={`cli-card model-card ${cli.installed ? 'ok' : ''}`} key={cli.id}>
            <div className="cli-top">
              <span className="dot" />
              <span className="cli-name">{cli.label}</span>
              <span className="cli-ver">{cli.installed ? `${(models[cli.id] ?? []).length} 条` : '未检测到'}</span>
            </div>
            <textarea
              className="model-area"
              spellCheck={false}
              placeholder={'每行一个模型名，如\nclaude-sonnet-4\n留空 = 该 CLI 只用手输模型'}
              value={drafts[cli.id] ?? (models[cli.id] ?? []).join('\n')}
              onChange={(e) => {
                const text = e.target.value
                setDrafts((current) => ({ ...current, [cli.id]: text }))
                props.onChange({ ...models, [cli.id]: parseModels(text) })
              }}
            />
          </div>
        ))}
      </div>
    </Section>
  )
}

/**
 * 工作目录列表编辑器。
 * 刚点「添加目录」时那一行是空的，而配置校验不接受空目录，
 * 所以空行只存在于本地草稿，提交给配置的永远是去空后的列表。
 */
export function WorkDirsEditor(props: {
  dirs: string[]
  onChange: (dirs: string[]) => void
}): JSX.Element {
  const [rows, setRows] = useState<string[]>(props.dirs)
  useEffect(() => {
    setRows((current) => {
      const mine = current.map((d) => d.trim()).filter(Boolean)
      const incoming = props.dirs.map((d) => d.trim()).filter(Boolean)
      const same = mine.length === incoming.length && mine.every((d, i) => d === incoming[i])
      return same ? current : props.dirs
    })
  }, [props.dirs])
  const commit = (next: string[]): void => {
    setRows(next)
    props.onChange(next.map((d) => d.trim()).filter(Boolean))
  }
  return (
    <Section
      title="工作目录"
      hint="可留空，启动时再选择"
      action={<button className="add" onClick={() => commit([...rows, ''])}>+ 添加目录</button>}
    >
      {rows.map((d, i) => (
        <div className="row" key={i}>
          <span className="idx">{i + 1}</span>
          <input
            className="dir"
            value={d}
            placeholder="如 D:\work\my-project"
            onChange={(e) => {
              const next = [...rows]
              next[i] = e.target.value
              commit(next)
            }}
          />
          <button
            onClick={async () => {
              const picked = await window.clichilds.dirPick()
              if (picked) {
                const next = [...rows]
                next[i] = picked
                commit(next)
              }
            }}
          >
            浏览
          </button>
          <button className="danger" onClick={() => commit(rows.filter((_, j) => j !== i))}>
            ✕
          </button>
        </div>
      ))}
    </Section>
  )
}
