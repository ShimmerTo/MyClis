import {
  CHILD_TIMEOUT_MAX_MINUTES,
  CHILD_TIMEOUT_MIN_MINUTES,
  DEFAULT_CHILD_TIMEOUT_MINUTES
} from '../../shared/types'
import type {
  AppConfig,
  CliId,
  CliModelLists,
  CommandConfig,
  InjectionConfig,
  LaunchConfig,
  SkillPrompts
} from '../../shared/types'
import { isAbsolute } from 'path'
import { DEFAULT_COMMANDS, DEFAULT_INJECTIONS } from '../../shared/skillPrompts'

/** 可配置模型清单的 CLI 类型（也是 CliModelLists 的全部键） */
export const CLI_IDS: CliId[] = ['codex', 'qoder', 'codebuddy', 'pi']
const CLI_ID_SET = new Set<CliId>(CLI_IDS)

/** 单个 CLI 类型的模型清单上限，挡住粘贴整份目录之类的误操作 */
const MODELS_PER_CLI = 100
const MODEL_LENGTH = 120

const EMPTY_MODELS: CliModelLists = { codex: [], qoder: [], codebuddy: [], pi: [] }

export const DEFAULT_CONFIG: AppConfig = {
  workDirs: [],
  terminal: 'powershell',
  cliConfigs: [],
  cliModels: structuredClone(EMPTY_MODELS),
  launch: {
    mainCliId: '',
    workDir: '',
    designCliIds: [],
    codeWriterCliIds: [],
    codeReviewCliIds: []
  },
  commands: structuredClone(DEFAULT_COMMANDS),
  injections: structuredClone(DEFAULT_INJECTIONS),
  review: { childTimeoutMinutes: DEFAULT_CHILD_TIMEOUT_MINUTES },
  theme: 'dark',
  ui: {
    reviewerLayout: 'vertical',
    tileWidthMode: 'fixed',
    tileWidth: 480,
    workbenchMode: 'tabs',
    // 1400x900 窗口下的观感：输出栏 36% 高、变更栏 42% 高
    outputDrawerHeight: 324,
    changesDrawerHeight: 378,
    diffMode: 'unified',
    statusBarMode: 'always'
  },
  notes: { storageDir: '', panelMode: 'pinned' },
  notifications: { cliIdle: true },
  closeToTray: true
}

/** 保存前的结构校验；返回错误消息列表（空 = 通过） */
export function validateAppConfig(cfg: AppConfig): string[] {
  const errors: string[] = []
  // workDirs 可为空（启动时才强制选择），只查已有条目的合法性
  if (!Array.isArray(cfg.workDirs)) {
    errors.push('工作目录列表无效')
  } else {
    cfg.workDirs.forEach((d, i) => {
      if (!d || !d.trim()) errors.push(`第 ${i + 1} 个工作目录为空`)
    })
    const seen = new Set<string>()
    for (const d of cfg.workDirs) {
      const key = d.trim().toLowerCase()
      if (seen.has(key)) errors.push(`工作目录重复：${d}`)
      seen.add(key)
    }
  }
  if (cfg.terminal !== 'powershell' && cfg.terminal !== 'cmd' && cfg.terminal !== 'gitbash') {
    errors.push('终端必须是 powershell / cmd / gitbash')
  }

  for (const cli of CLI_IDS) {
    const models = cfg.cliModels?.[cli]
    if (!Array.isArray(models)) {
      errors.push(`可用模型缺少 ${cli} 的清单`)
      continue
    }
    if (models.length > MODELS_PER_CLI) errors.push(`可用模型 ${cli} 超过 ${MODELS_PER_CLI} 条`)
    for (const model of models) {
      if (typeof model !== 'string' || !model.trim()) errors.push(`可用模型 ${cli} 存在空条目`)
      else if (model.length > MODEL_LENGTH) errors.push(`可用模型 ${cli} 的「${model.slice(0, 20)}…」超过 ${MODEL_LENGTH} 字符`)
    }
  }

  const ids = new Set<string>()
  for (const [i, item] of cfg.cliConfigs.entries()) {
    if (!item.id.trim()) errors.push(`CLI 设置第 ${i + 1} 项缺少 id`)
    if (ids.has(item.id)) errors.push(`CLI 设置 id 重复：${item.id}`)
    ids.add(item.id)
    if (!CLI_ID_SET.has(item.cli)) errors.push(`CLI 设置第 ${i + 1} 项类型无效`)
    if (!item.permissionMode?.trim()) errors.push(`CLI 设置第 ${i + 1} 项未选择运行权限`)
  }

  const checkRefs = (refs: string[], label: string): void => {
    const seen = new Set<string>()
    for (const id of refs) {
      if (!ids.has(id)) errors.push(`${label}引用了不存在的 CLI 设置：${id}`)
      if (seen.has(id)) errors.push(`${label}重复选择了 CLI 设置：${id}`)
      seen.add(id)
    }
  }
  if (cfg.launch.mainCliId && !ids.has(cfg.launch.mainCliId)) errors.push('主 CLI 引用了不存在的 CLI 设置')
  checkRefs(cfg.launch.designCliIds, '方案校验')
  checkRefs(cfg.launch.codeWriterCliIds, '代码编写')
  checkRefs(cfg.launch.codeReviewCliIds, '代码检查')

  const commandIds = new Set<string>()
  const commandNames = new Set<string>()
  const builtinKinds = new Set<string>()
  for (const [i, command] of cfg.commands.entries()) {
    if (!command.id?.trim()) errors.push(`命令第 ${i + 1} 项缺少 id`)
    if (commandIds.has(command.id)) errors.push(`命令 id 重复：${command.id}`)
    commandIds.add(command.id)
    const name = command.name?.replace(/^\//, '').trim() ?? ''
    if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(name)) {
      errors.push(`命令名无效：${command.name || '（空）'}；只能使用小写字母、数字和连字符`)
    }
    if (commandNames.has(name.toLowerCase())) errors.push(`命令名重复：${name}`)
    commandNames.add(name.toLowerCase())
    if (typeof command.prompt !== 'string') errors.push(`命令 ${name} 的提示词必须是字符串`)
    else {
      if (command.prompt.length > 8000) errors.push(`命令 ${name} 的提示词过长（上限 8000 字符）`)
      const unknown = [...command.prompt.matchAll(/\{([^}]+)\}/g)]
        .map((m) => m[1])
        .filter((key) => key !== 'query')
      if (unknown.length > 0) errors.push(`命令 ${name} 使用了未知变量：${[...new Set(unknown)].join('、')}`)
      if (!command.builtinKind && !command.prompt.trim()) errors.push(`自定义命令 ${name} 的提示词不能为空`)
    }
    if (command.builtinKind) {
      if (builtinKinds.has(command.builtinKind)) errors.push(`内置命令重复：${command.builtinKind}`)
      builtinKinds.add(command.builtinKind)
    }
  }
  for (const kind of ['design', 'write', 'review']) {
    if (!builtinKinds.has(kind)) errors.push(`缺少内置命令：${kind}`)
  }

  const injectionIds = new Set<string>()
  const injectionKinds = new Set<string>()
  for (const [i, item] of cfg.injections.entries()) {
    if (!item.id?.trim()) errors.push(`默认注入第 ${i + 1} 项缺少 id`)
    if (injectionIds.has(item.id)) errors.push(`默认注入 id 重复：${item.id}`)
    injectionIds.add(item.id)
    if (item.builtinKind) {
      if (injectionKinds.has(item.builtinKind)) errors.push(`内置默认注入重复：${item.builtinKind}`)
      injectionKinds.add(item.builtinKind)
    }
  }
  if (!injectionKinds.has('present')) errors.push('缺少内置默认注入：present')

  const timeout = cfg.review?.childTimeoutMinutes
  if (
    !Number.isFinite(timeout) ||
    timeout < CHILD_TIMEOUT_MIN_MINUTES ||
    timeout > CHILD_TIMEOUT_MAX_MINUTES
  ) {
    errors.push(
      `子任务结果超时需在 ${CHILD_TIMEOUT_MIN_MINUTES} ~ ${CHILD_TIMEOUT_MAX_MINUTES} 分钟之间`
    )
  }

  if (cfg.ui?.reviewerLayout === 'tile' && cfg.ui?.tileWidthMode === 'fixed') {
    const w = cfg.ui.tileWidth
    if (!Number.isFinite(w) || w < 240 || w > 1600) errors.push('平铺固定宽度需在 240 ~ 1600 px 之间')
  }
  // 抽屉高度来自渲染层拖拽，越界值会让抽屉顶掉整个终端区
  const drawers: [string, number][] = [
    ['输出抽屉高度', cfg.ui?.outputDrawerHeight],
    ['变更抽屉高度', cfg.ui?.changesDrawerHeight]
  ]
  for (const [label, value] of drawers) {
    if (!Number.isFinite(value) || value < 120 || value > 2000) errors.push(`${label}需在 120 ~ 2000 px 之间`)
  }

  // 便签存储目录要么留空（用默认位置），要么必须是绝对路径 —— 相对路径会跟着进程 cwd 漂移
  if (cfg.notes?.storageDir && !isAbsolute(cfg.notes.storageDir)) {
    errors.push('便签存储目录必须是绝对路径')
  }
  if (cfg.notes?.panelMode !== 'pinned' && cfg.notes?.panelMode !== 'blur') {
    errors.push('便签浮窗行为无效')
  }
  return errors
}

/**
 * 抽屉高度：只接受合理区间内的有限数，缺省与越界都回落到默认值（旧配置没有这两个字段）
 */
function drawerHeight(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.round(Math.min(2000, Math.max(120, value)))
}

/** 子任务结果超时（分钟）：旧配置没有这个字段，缺省与越界都回落到默认值 */
function childTimeoutMinutes(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_CHILD_TIMEOUT_MINUTES
  return Math.round(Math.min(CHILD_TIMEOUT_MAX_MINUTES, Math.max(CHILD_TIMEOUT_MIN_MINUTES, value)))
}

/** 可用模型清单：去空、去重、截断，四个 CLI 类型一个都不能少（旧配置里没有这个字段） */
function normalizeModelLists(raw: unknown): CliModelLists {
  const source = (raw ?? {}) as Record<string, unknown>
  const out = structuredClone(EMPTY_MODELS)
  for (const cli of CLI_IDS) {
    const list = Array.isArray(source[cli]) ? source[cli] : []
    const seen = new Set<string>()
    for (const item of list) {
      if (typeof item !== 'string') continue
      const model = item.trim().slice(0, MODEL_LENGTH)
      if (!model || seen.has(model)) continue
      if (out[cli].length >= MODELS_PER_CLI) break
      seen.add(model)
      out[cli].push(model)
    }
  }
  return out
}

/**
 * 与默认值合并；只接受当前统一 CLI 配置契约，不兼容旧字段。
 * 唯一的例外：launch.codeWriterCliId 这个标量刚改成数组，磁盘上的旧配置还带着它，
 * 静默清空会让 /myclis-code 下次保存时被注入器一并删掉，所以要认它一次。
 */
type LegacyConfig = Partial<AppConfig> & { skillPrompts?: Partial<SkillPrompts> }

export function mergeConfig(raw: LegacyConfig | null): AppConfig {
  if (!raw) return structuredClone(DEFAULT_CONFIG)
  const cliConfigs = (Array.isArray(raw.cliConfigs) ? raw.cliConfigs : []).map((item) => ({
    ...item,
    alias: typeof item.alias === 'string' ? item.alias : '',
    model: item.model ?? '',
    permissionMode: item.permissionMode || 'default'
  }))
  const validIds = new Set(cliConfigs.map((x) => x.id))
  const workDirs = Array.isArray(raw.workDirs) ? raw.workDirs : []
  const source = raw.launch ?? DEFAULT_CONFIG.launch
  const designCliIds = Array.isArray(source.designCliIds) ? source.designCliIds : []
  const codeReviewCliIds = Array.isArray(source.codeReviewCliIds) ? source.codeReviewCliIds : []
  const legacyWriter = (source as Partial<LaunchConfig & { codeWriterCliId?: unknown }>).codeWriterCliId
  const codeWriterCliIds = Array.isArray(source.codeWriterCliIds)
    ? source.codeWriterCliIds
    : typeof legacyWriter === 'string' && validIds.has(legacyWriter)
      ? [legacyWriter]
      : []
  // 上次选中的工作目录被删掉后就没有意义了：清空，让启动页回落到第一个
  const savedWorkDir = typeof source.workDir === 'string' ? source.workDir : ''
  const launch: LaunchConfig = {
    mainCliId: validIds.has(source.mainCliId ?? '') ? source.mainCliId! : (cliConfigs[0]?.id ?? ''),
    workDir: workDirs.includes(savedWorkDir) ? savedWorkDir : '',
    designCliIds: designCliIds.filter((id) => validIds.has(id)),
    codeWriterCliIds: [...new Set(codeWriterCliIds)].filter((id) => validIds.has(id)),
    codeReviewCliIds: codeReviewCliIds.filter((id) => validIds.has(id))
  }
  const legacyPrompts = raw.skillPrompts ?? {}
  const incoming = Array.isArray(raw.commands) ? raw.commands : []
  const commands: CommandConfig[] = []
  for (const builtin of DEFAULT_COMMANDS) {
    const saved = incoming.find((item) => item?.builtinKind === builtin.builtinKind || item?.id === builtin.id)
    const legacy = legacyPrompts[builtin.builtinKind!]
    commands.push({
      ...builtin,
      ...saved,
      id: builtin.id,
      builtinKind: builtin.builtinKind,
      name: String(saved?.name || builtin.name).replace(/^\//, '').trim(),
      prompt: String(saved?.prompt ?? legacy ?? '').replace(/\{resultDir\}/g, '.clichilds/results'),
      enabled: typeof saved?.enabled === 'boolean' ? saved.enabled : true
    })
  }
  for (const item of incoming) {
    if (!item || item.builtinKind || DEFAULT_COMMANDS.some((builtin) => builtin.id === item.id)) continue
    commands.push({
      id: String(item.id || ''),
      name: String(item.name || '').replace(/^\//, '').trim(),
      enabled: item.enabled !== false,
      prompt: String(item.prompt || '').replace(/\{resultDir\}/g, '.clichilds/results')
    })
  }
  const incomingInjections = Array.isArray(raw.injections) ? raw.injections : []
  const injections: InjectionConfig[] = DEFAULT_INJECTIONS.map((builtin) => {
    const saved = incomingInjections.find(
      (item) => item?.builtinKind === builtin.builtinKind || item?.id === builtin.id
    )
    return {
      ...builtin,
      name: String(saved?.name || builtin.name).trim(),
      description: String(saved?.description ?? builtin.description),
      enabled: typeof saved?.enabled === 'boolean' ? saved.enabled : true
    }
  })
  return {
    workDirs,
    terminal: raw.terminal ?? DEFAULT_CONFIG.terminal,
    cliConfigs,
    cliModels: normalizeModelLists(raw.cliModels),
    launch,
    commands,
    injections,
    review: { childTimeoutMinutes: childTimeoutMinutes(raw.review?.childTimeoutMinutes) },
    theme: raw.theme ?? DEFAULT_CONFIG.theme,
    ui: {
      ...DEFAULT_CONFIG.ui,
      ...(raw.ui ?? {}),
      outputDrawerHeight: drawerHeight(raw.ui?.outputDrawerHeight, DEFAULT_CONFIG.ui.outputDrawerHeight),
      changesDrawerHeight: drawerHeight(raw.ui?.changesDrawerHeight, DEFAULT_CONFIG.ui.changesDrawerHeight),
      diffMode: raw.ui?.diffMode === 'split' ? 'split' : 'unified',
      // 旧配置没有这个字段：缺省常驻（与改动前的行为一致）
      statusBarMode:
        raw.ui?.statusBarMode === 'hidden' || raw.ui?.statusBarMode === 'hover' ? raw.ui.statusBarMode : 'always'
    },
    notes: {
      // 旧配置没有这个字段：空 = 沿用默认存储位置；浮窗行为缺省常驻（与旧行为一致）
      storageDir: typeof raw.notes?.storageDir === 'string' ? raw.notes.storageDir.trim() : '',
      panelMode: raw.notes?.panelMode === 'blur' ? 'blur' : 'pinned'
    },
    notifications: {
      ...DEFAULT_CONFIG.notifications,
      ...(raw.notifications ?? {}),
      cliIdle: raw.notifications?.cliIdle !== false
    },
    // 缺省 = 隐藏到托盘（与旧行为一致）；显式 false 才直接退出
    closeToTray: raw.closeToTray !== false
  }
}
