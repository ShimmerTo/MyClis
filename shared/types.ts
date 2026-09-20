// 主进程与渲染进程共用的类型与 IPC 通道定义

export type CliId = 'codex' | 'qoder' | 'codebuddy' | 'pi'

/** 终端角色：主会话 / 子任务终端 / 用户手动开的纯 shell */
export type TerminalRole = 'main' | 'child' | 'shell'

/**
 * 终端里跑的东西：某个 CLI，或一个纯 shell。
 * 纯 shell 没有 CLI 适配器 —— 不读 transcript、不跟随用量、不写会话历史，
 * 因此凡是拿它去查适配器的地方都必须先按 role 排除。
 */
export type TerminalProgram = CliId | 'shell'

export interface CliPermissionOption {
  id: string
  label: string
  description: string
  dangerous?: boolean
}

export type TerminalKind = 'powershell' | 'cmd' | 'gitbash'

/** 三种系统终端（唯一定义处）：设置页下拉、引导页、执行页顶部「终端」菜单共用 */
export const TERMINALS: { id: TerminalKind; label: string }[] = [
  { id: 'powershell', label: 'PowerShell' },
  { id: 'cmd', label: 'CMD' },
  { id: 'gitbash', label: 'Git Bash' }
]

export type ThemeKind = 'paper' | 'light' | 'dark'

/** 皮肤清单（唯一定义处）：paper 纯净浅色 / light 护眼浅色 / dark 深色 */
export const THEMES: { id: ThemeKind; label: string }[] = [
  { id: 'paper', label: '浅色' },
  { id: 'light', label: '护眼' },
  { id: 'dark', label: '深色' }
]

/** 校验 CLI 窗口展示形式：竖排堆叠 / 平铺 */
export type ReviewerLayout = 'vertical' | 'tile'
/** 平铺时宽度策略：固定宽度 / 所有窗口均分 */
export type TileWidthMode = 'fixed' | 'equal'
/** 执行页的会话切换方式：tabs = 顶部常驻页卡；hover = 鼠标移到顶部弹悬浮卡片（旧版） */
export type WorkbenchMode = 'tabs' | 'hover'

/** 文件对比的展示形式：统一视图 / 并排视图 */
export type DiffMode = 'unified' | 'split'

/** 状态栏显示方案：hidden = 不显示；always = 常驻显示（默认）；hover = 鼠标移到热区浮窗显示、移开隐藏 */
export type StatusBarMode = 'hidden' | 'always' | 'hover'

export interface UiConfig {
  reviewerLayout: ReviewerLayout
  tileWidthMode: TileWidthMode
  /** tileWidthMode=fixed 时每格宽度（px） */
  tileWidth: number
  /** 终端打开模式：页卡（默认）/ 隐藏式卡片 */
  workbenchMode: WorkbenchMode
  /** 输出抽屉高度（px）：用户拖过就按他的来，窗口变小时由渲染层按上下限夹紧 */
  outputDrawerHeight: number
  /** 变更抽屉高度（px） */
  changesDrawerHeight: number
  /** 变更面板的文件对比模式（统一 / 并排），跨会话记住 */
  diffMode: DiffMode
  /** 终端状态栏显示方案 */
  statusBarMode: StatusBarMode
}

/** 系统通知开关 */
export interface NotificationConfig {
  /** 某个 CLI 持续一段时间没有输出时发系统通知提醒 */
  cliIdle: boolean
}

/** 便签浮窗的收起方式：pinned = 展开后常驻（点外面不收起）；blur = 失去焦点后隐藏 */
export type NotePanelMode = 'pinned' | 'blur'

/** 便签设置 */
export interface NotesConfig {
  /** 便签存储目录（notes.json 与 notes-assets/ 的父目录）；空 = 默认 userData/clichilds */
  storageDir: string
  /** 浮窗行为 */
  panelMode: NotePanelMode
}

/** 子任务执行策略 */
export interface ReviewConfig {
  /** 子任务从被拉起那一刻起，多久还没写出结果文件就算失败（分钟） */
  childTimeoutMinutes: number
}

/** 子任务结果超时：默认 1 小时，可配置区间 5 ~ 720 分钟 */
export const DEFAULT_CHILD_TIMEOUT_MINUTES = 60
export const CHILD_TIMEOUT_MIN_MINUTES = 5
export const CHILD_TIMEOUT_MAX_MINUTES = 720

/** 每个子任务允许的重试次数：失败后最多再拉起这么多次（1 次首拉 + 2 次重试） */
export const MAX_CHILD_RETRIES = 2

/** 旧配置迁移专用；新配置统一使用 CommandConfig[]。 */
export interface SkillPrompts {
  design: string
  write: string
  review: string
}

/**
 * 每个 CLI 类型可选的模型清单，由设置页手工维护。
 * 唯一来源：CLI 档案的模型输入只拿它做候选，不再去问 CLI 自己。
 */
export type CliModelLists = Record<CliId, string[]>

/** 一条可在启动页分配给不同角色的 CLI 档案。 */
export interface CliConfig {
  id: string
  cli: CliId
  /** 显示别名；留空 = 自动用「CLI名-模型名-权限名」 */
  alias: string
  model?: string
  /** 由各 CLI 适配器声明的权限模式 id */
  permissionMode: string
}

/** 启动页的角色分配；三类子任务都可以不选择。 */
export interface LaunchConfig {
  mainCliId: string
  /** 启动页最后一次选中的工作目录；已不在 workDirs 里时读配置时清空，启动页回落到第一个 */
  workDir: string
  designCliIds: string[]
  /** 可多选；按模块拆分，一个编写 CLI 一份开发文档 */
  codeWriterCliIds: string[]
  codeReviewCliIds: string[]
}

export interface AppConfig {
  /** 至少 1 个（保存时校验） */
  workDirs: string[]
  terminal: TerminalKind
  /** 可复用的 CLI 档案，可配置多个同类 CLI/模型/权限组合 */
  cliConfigs: CliConfig[]
  /** 各 CLI 类型的可用模型清单（设置页手工维护，供 CLI 档案的模型输入做候选） */
  cliModels: CliModelLists
  /** 启动页最后一次选择 */
  launch: LaunchConfig
  /** 注入给 CLI 的内置/自定义命令 */
  commands: CommandConfig[]
  /** 启动主 CLI 时追加给它的系统提示（不写进命令文件） */
  injections: InjectionConfig[]
  /** 子任务执行策略（超时与重试） */
  review: ReviewConfig
  theme: ThemeKind
  ui: UiConfig
  /** 便签存储目录与浮窗行为 */
  notes: NotesConfig
  /** 系统通知开关 */
  notifications: NotificationConfig
  /** 点窗口关闭按钮时：true = 隐藏到托盘继续跑；false = 直接退出应用 */
  closeToTray: boolean
}

/** CLI 安装检测结果 */
export interface CliStatus {
  id: CliId
  label: string
  installed: boolean
  path?: string
  version?: string
  permissionOptions: CliPermissionOption[]
  health?: 'ok' | 'warning' | 'broken'
  diagnostics?: string[]
  /** 该 CLI 能不能跑一次非交互最小测试；false = 设置页不显示测试按钮 */
  canTestModel: boolean
}

/** 用某个模型跑一次非交互最小测试的结果 */
export interface CliTestResult {
  ok: boolean
  /** 从发起到 CLI 退出的耗时（ms） */
  elapsedMs: number
  /** 成功时模型回显的内容（已截断） */
  reply?: string
  /** 失败原因（超时、退出码非 0、CLI 未安装…） */
  error?: string
}

export type TriggerKind = 'design' | 'write' | 'review'

export type TerminalPhase = 'booting' | 'ready' | 'delivering' | 'running' | 'done' | 'error'

export interface TerminalRuntimeState {
  phase: TerminalPhase
  message?: string
  changedAt: number
  deliveryAttempt?: number
  submissionUncertain?: boolean
}

export interface TokenUsage {
  input: number
  output: number
  cachedInput?: number
  reasoning?: number
  total: number
  cost?: number
  credit?: number
  exact: boolean
  updatedAt: number
}

/** skill 发给本机 bridge 的任务上下文。 */
export interface TriggerRequest {
  query: string
  /** 发起请求的主 CLI 工作目录（必须有对应的活跃主会话） */
  workDir: string
  /** 系统提示里给出的本会话 id；填错或会话已结束会被拒绝，省略则回退到该目录最近启动的主会话 */
  session?: string
  /** 主 CLI 在 workDir 内生成的总览留痕文档；子终端一律只读参考 */
  documentPath: string
  /** 主 CLI 逐个下发的任务；不填则回落到按类型内置文案 + 共用 documentPath */
  targets?: TriggerTarget[]
}

/** 主 CLI 写给某一个被调起终端的任务。 */
export interface TriggerTarget {
  /** 设置页里的 CLI 档案 id，必须来自本次注入清单列出的那些 */
  profileId: string
  /** 该终端的完整任务指令：目标、范围内改动、明确禁止越界的范围、产出要求 */
  task: string
  /** 只交给这个终端的留痕文档（workDir 内，绝对或相对路径） */
  documents?: string[]
}

export interface TriggerResponse {
  count: number
  requested: number
  launched: number
  /** 本次 run 的编号：后续查询状态、等待、重试都要带上它 */
  runId: string
  /** 主 CLI 下一步该做什么，与 /status /wait /retry 的响应语义一致 */
  nextAction: RunNextAction
  /** 仅包含已成功启动的子任务，每个终端一个独立结果文件 */
  resultFiles: string[]
  /** 哪个档案 → 哪份结果，省得主 CLI 去拆文件名 */
  tasks: ChildTargetStatus[]
}

export type ChildState = 'launching' | 'running' | 'done' | 'failed'

/** 子任务失败原因：拉起失败 / 任务没投递进输入框 / 进程提前退出 / 超时没出结果 */
export type ChildFailure = 'launch' | 'delivery' | 'exit' | 'timeout'

export type RunState = 'active' | 'finished' | 'aborted'

/**
 * 主 CLI 下一步动作，由应用算好，主 CLI 只照着做：
 * wait 继续等 / retry 有失败可重试 / analyze 全部完成去读结果 /
 * report-failure 有失败且不能自动重试 / stop 本次 run 已随主会话结束而作废
 */
export type RunNextAction = 'wait' | 'retry' | 'analyze' | 'report-failure' | 'stop'

/** 某个子任务在一次 run 里的对外状态 */
export interface ChildTargetStatus {
  profileId: string
  label: string
  /** 本次 run 内的序号（1 起），与右侧窗口标题一致 */
  index: number
  state: ChildState
  /** 已经重试过几次（拉起次数 - 1） */
  retries: number
  /** 现在还能不能再重试 */
  canRetry: boolean
  termId?: string
  resultFile?: string
  failure?: ChildFailure
  error?: string
  /** 当前这次拉起已经过去的毫秒数 */
  elapsedMs: number
}

/** 一次 /trigger 下发的整体快照（/status /wait /retry 的响应主体） */
export interface RunSnapshot {
  runId: string
  runState: RunState
  nextAction: RunNextAction
  updatedAt: number
  targets: ChildTargetStatus[]
  /** /wait 专用：本次返回是不是因为有状态变化 */
  changed?: boolean
  reason?: 'transition' | 'timeout' | 'immediate'
}

export interface RetryResponse extends RunSnapshot {
  /** 本次真正重开了的 profileId */
  retried: string[]
  /** 没能重开的及原因（次数用尽、档案已被删…） */
  skipped: { profileId: string; reason: string }[]
}

export interface TerminalInfo {
  id: string
  role: TerminalRole
  /** 主会话使用的 CLI 档案 */
  profileId?: string
  /** 会话创建时解析好的档案显示名（别名），档案之后被改也不影响在跑的会话 */
  profileLabel?: string
  /** 子终端的任务类型 */
  taskKind?: TriggerKind
  /** 子终端的序号（1 起） */
  index?: number
  cli: TerminalProgram
  model?: string
  workDir: string
  shell: TerminalKind
  /** 该 CLI 自己的 session id（不是应用的 pty id）；codex 可能要到首条任务后才补上 */
  nativeSessionId?: string
  /** 子终端所属的主终端 id */
  parentTermId?: string
  /** 结果落盘的 md 路径（子任务完成时有效） */
  resultFile?: string
}

/** 一个存活 pty 会话的可读快照（启动页「进行中的任务」面板用） */
export interface SessionSummary extends TerminalInfo {
  /** 会话创建时间（epoch ms） */
  startedAt: number
  /** 最近一次收到 CLI 输出的时间（epoch ms） */
  lastOutputAt: number
  /** 子终端结果已落盘 */
  done?: boolean
  /** 会话首条用户消息（从 CLI 自己的 transcript 读回，读到前为空） */
  initialQuery?: string
  runtime: TerminalRuntimeState
  usage?: TokenUsage
}

export interface BridgeInfo {
  port: number
  baseUrl: string
}

/** 四套 CLI 的 jsonl 归一后的对话条目。 */
export interface ChatEntry {
  kind: 'user' | 'assistant' | 'reasoning' | 'tool' | 'system'
  text: string
  /** epoch ms；部分 CLI 的某些记录没有时间 */
  ts?: number
  /** 工具名，仅 kind='tool' 有 */
  name?: string
}

/** 一条历史会话里某个子终端的记录。 */
export interface HistoryChild {
  termId: string
  nativeSessionId?: string
  profileId?: string
  profileLabel?: string
  cli: CliId
  model?: string
  taskKind?: TriggerKind
  index?: number
  resultFile?: string
  done?: boolean
  startedAt: number
  endedAt?: number
  initialQuery?: string
  usage?: TokenUsage
}

/** 跨重启保留的一条主会话；子终端嵌在里面，一起淘汰。 */
export interface HistoryRecord {
  /** 应用自己的 pty id */
  sessionId: string
  /** 该 CLI 的原生 session id，resume 与读 transcript 都靠它 */
  nativeSessionId?: string
  cli: CliId
  profileId?: string
  profileLabel?: string
  model?: string
  permissionMode?: string
  workDir: string
  shell: TerminalKind
  startedAt: number
  endedAt?: number
  /** 本条是从哪条历史 resume 出来的 */
  resumedFrom?: string
  initialQuery?: string
  usage?: TokenUsage
  children: HistoryChild[]
  /** 读时算出的派生值：workDir 还在不在（不落盘） */
  dirMissing?: boolean
}

/** 从各 CLI 自己的会话目录里回填出来的历史。 */
export interface DiscoveredSession {
  nativeSessionId: string
  cli: CliId
  cwd: string
  startedAt: number
  bytes: number
  title?: string
  initialQuery?: string
  /** 命中的 transcript 绝对路径 */
  file: string
  /** 本应用启动过（nativeSessionId 命中 history.json） */
  mine: boolean
  dirMissing: boolean
}

export interface TranscriptReq {
  cli: CliId
  nativeSessionId: string
  /** 会话自己的 cwd，仅用于兜底定位与展示 */
  cwd?: string
}

export interface TranscriptPage {
  entries: ChatEntry[]
  truncated: boolean
  totalBytes: number
  file?: string
  reason?: 'file-missing' | 'dir-missing'
}

/** 右侧栏回填请求：整表拿回去，筛法在渲染层 */
export interface DiscoverReq {
  cli?: CliId
  limit?: number
}

/** 终端右键菜单动作（由主进程原生菜单回填给渲染进程执行） */
export type TermMenuAction = 'copy' | 'paste' | 'selectAll' | 'clear' | 'zoomIn' | 'zoomOut' | 'addNote'

export type BuiltinCommandKind = 'design' | 'write' | 'review'

export interface CommandConfig {
  /** 稳定 id；内置命令固定为 builtin-design/write/review */
  id: string
  /** 不带前导斜杠 */
  name: string
  enabled: boolean
  /** 内置正文留空 = 使用默认；自定义命令不可为空 */
  prompt: string
  builtinKind?: BuiltinCommandKind
}

export type BuiltinInjectionKind = 'present'

export interface InjectionConfig {
  /** 稳定 id；内置注入固定为 builtin-present */
  id: string
  name: string
  /** 设置页展示的说明；正文由应用固定生成，不落用户配置 */
  description: string
  enabled: boolean
  builtinKind?: BuiltinInjectionKind
}

export type OutputMedia = 'markdown' | 'image' | 'url'

export interface PresentFileInput {
  path: string
  label?: string
}

export interface PresentRequest {
  workDir: string
  /** 发起会话 id（展示协议 URL 的路径段）；缺失或已失效时回退到该目录最近活跃的主会话 */
  session?: string
  title?: string
  files: PresentFileInput[]
}

export interface OutputArtifact {
  id: string
  label: string
  path: string
  media: OutputMedia
  bytes: number
  mtime: number
}

export interface OutputBundle {
  id: string
  sessionId: string
  workDir: string
  title: string
  createdAt: number
  source: 'main-cli' | 'reviewer'
  artifacts: OutputArtifact[]
}

/**
 * 便签类型。三种类型决定 content 的含义与预览方式：
 * text = 正文；file = 文件绝对路径（按扩展名预览内容）；url = 网址。
 */
export type NoteKind = 'text' | 'file' | 'url'

/** 便签处理状态；todo 未处理（默认）、doing 进行中、done 已完成（列表中默认隐藏） */
export type NoteStatus = 'todo' | 'doing' | 'done'

export const NOTE_STATUSES: NoteStatus[] = ['todo', 'doing', 'done']

/** 一条便签；跨重启保留在存储目录（默认 userData/clichilds）下的 notes.json */
export interface Note {
  id: string
  /** 归属工作目录；运行窗口的浮窗按它过滤，管理页按它分组 */
  workDir: string
  kind: NoteKind
  /** kind='text' 是正文；'file' 是文件绝对路径；'url' 是网址 */
  content: string
  /** 展示名：text 默认取正文前 20 字，file 默认取文件名 */
  title: string
  status: NoteStatus
  /** 加入时间（epoch ms） */
  createdAt: number
  updatedAt: number
}

/** 便签预览的渲染分支：渲染层只按它分支，不自己判断扩展名 */
export type NoteAssetMedia = 'image' | 'markdown' | 'text' | 'pdf' | 'docx' | 'url' | 'binary'

/** 一条便签解析出来的可渲染内容 */
export interface NoteAssetResult {
  media: NoteAssetMedia
  /** 文本类内容（markdown / text / docx 转出的 HTML） */
  text?: string
  /** 图片的 data URL */
  dataUrl?: string
  /** pdf 的内联地址（自定义协议 clichilds-note://note/<id>） */
  url?: string
  /** 文件绝对路径，事实行与「用系统默认程序打开」用 */
  path?: string
  size?: number
  truncated?: boolean
  reason?: 'missing' | 'too-large' | 'unreadable' | 'unsupported'
}

/** 读一次剪贴板的结果；优先级 文件 → 图片 → 文本 */
export type ClipboardPayload =
  | { kind: 'files'; paths: string[] }
  | { kind: 'image'; path: string }
  | { kind: 'text'; text: string }
  | { kind: 'empty' }

/** git 变更类型（够 UI 分类用，不追求覆盖 plumbing 的全部状态） */
export type ChangeKind =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'untracked'
  | 'conflicted'
  | 'typechange'

/** 工作目录里一个发生变更的文件；path 相对仓库根，统一用 / 分隔 */
export interface ChangeFile {
  path: string
  /** 重命名/复制时的原路径 */
  origPath?: string
  /** git status 的 XY 两列，留给 tooltip */
  x: string
  y: string
  kind: ChangeKind
}

/** 单个文件改动前后的全文；binary 时正文为空，truncated 表示只给了前一段 */
export interface GitDiffResult {
  path: string
  oldText: string
  newText: string
  binary?: boolean
  truncated?: boolean
  /** 工作区里的绝对路径；文件已删除时给的是它原来的位置 */
  absolutePath?: string
  /** 字节数；工作区读不到（已删除）时回落到 HEAD 里那份的大小 */
  size?: number
  /** git 记录的权限位：100644 普通 / 100755 可执行 / 120000 符号链接；未跟踪文件没有记录 */
  mode?: string
  /** 图片正文的 data URL（仅图片类型且未超上限时给） */
  dataUrl?: string
}

/** 自绘标题栏高度（px）：窗口原生按钮叠加层、执行页标签栏、其它页顶部栏三处必须一致 */
export const TITLEBAR_HEIGHT = 34
/**
 * 原生窗口按钮叠加层的高度：比标题栏矮 1px。
 * 叠加层是盖在网页内容之上的不透明原生图层，被它盖住的区域画不出任何东西；
 * 不矮这 1px，标题栏底部那条分隔线一到按钮区就断了。
 */
export const TITLEBAR_OVERLAY_HEIGHT = TITLEBAR_HEIGHT - 1

/** IPC 通道名（唯一定义处） */
export const CH = {
  configGet: 'config:get',
  configSet: 'config:set',
  cliDetect: 'cli:detect',
  /** { cli, model } -> CliTestResult；真实调用一次模型，model 为空 = 测 CLI 默认模型 */
  cliModelTest: 'cli:model-test',
  dirPick: 'dir:pick',
  pasteImage: 'paste-image', // -> 剪贴板有图片则落盘临时目录，返回 PNG 绝对路径；无图片返回 null
  bridgeInfo: 'bridge:info',
  sessionStart: 'session:start', // { workDir, profileId, resumeSessionId? } -> { sessionId }
  sessionList: 'session:list', // -> SessionSummary[]（存活的 pty 会话）
  sessionsChanged: 'session:changed', // main -> renderer SessionSummary[]
  historyList: 'history:list', // -> HistoryRecord[]（跨重启的历史）
  historyChanged: 'history:changed', // main -> renderer HistoryRecord[]
  historyDelete: 'history:delete', // { sessionId }
  sessionDiscover: 'session:discover', // DiscoverReq -> DiscoveredSession[]
  transcriptRead: 'transcript:read', // TranscriptReq -> TranscriptPage
  termWrite: 'term:write', // { id, data }
  termResize: 'term:resize', // { id, cols, rows }
  termKill: 'term:kill', // { id }
  termRestart: 'term:restart', // { id } 关闭该子终端并按原参数重开一个（CLI 子任务重新投递同一任务，纯 shell 同类型重建）
  termRetryPrompt: 'term:retry-prompt', // { id }
  termAttach: 'term:attach', // id -> 断连期间的输出，并开始转发实时输出
  termDetach: 'term:detach', // { id } 停止转发，改为缓冲输出
  termMenu: 'term:menu', // { id, hasSelection } 请求弹出原生右键菜单
  termMenuAction: 'term:menu-action', // main -> renderer { id, action, workDir? }
  termData: 'term:data', // main -> renderer { id, data }
  termExit: 'term:exit', // main -> renderer { id }
  /** 便签：整表读 / 增 / 改 / 删 / 清（清可不带 workDir = 清全部） */
  notesList: 'notes:list',
  notesAdd: 'notes:add',
  notesUpdate: 'notes:update',
  notesRemove: 'notes:remove',
  notesClear: 'notes:clear',
  notesChanged: 'notes:changed', // main -> renderer Note[]
  /** 切换便签存储目录：把现有 notes.json 与图片资产迁移过去，并写回配置；返回最新 AppConfig */
  notesSetStorage: 'notes:set-storage',
  /** 解析一条便签要展示的内容（主进程按 noteId 取路径，渲染层不传路径） */
  notesAsset: 'notes:asset',
  /** 剪贴板图片落盘到便签资产目录，返回绝对路径；没有图片返回 null */
  notesSaveImage: 'notes:save-image',
  /** 读一次剪贴板（文件 / 图片 / 文本） */
  notesPaste: 'notes:paste',
  /** 用系统默认程序打开便签引用的文件；reveal=true 改为在资源管理器里定位 */
  notesOpenFile: 'notes:open-file',
  /** 清理没有便签引用的图片；dryRun=true 只统计不删 */
  notesCleanupAssets: 'notes:cleanup-assets',
  /** 仓库根相对路径 -> 绝对路径（复用 git 变更服务，处理「仓库根 ≠ 工作目录」） */
  pathResolve: 'path:resolve',
  outputList: 'output:list',
  outputRead: 'output:read',
  outputAsset: 'output:asset',
  outputsChanged: 'output:changed',
  externalOpen: 'external:open',
  gitBranch: 'git:branch',
  /** 工作目录的变更清单（watcher 触发后由主进程推送，渲染层按 workDir 过滤） */
  gitChanges: 'git:changes',
  /** 主动取一次变更清单（切标签时立刻要数据，不等 watcher 触发） */
  gitChangesList: 'git:changes:list',
  /** 取单个文件改动前后的全文，供 diff 组件渲染 */
  gitDiff: 'git:diff',
  /** 在系统文件管理器里定位某个变更文件（已删除则打开所在目录） */
  gitReveal: 'git:reveal',
  /** 在当前工作台的子终端区开一个纯 shell 终端（应用内，不弹系统窗口） */
  termOpenShell: 'term:open-shell',
  /** 用系统原生终端窗口打开同一份东西：同目录、同 Shell，CLI 会话还带上同一行启动命令 */
  termOpenExternal: 'term:open-external',
  /** 渲染层把当前皮肤的标题栏配色推给主进程，给窗口按钮叠加层上色 */
  titleBarTheme: 'ui:titlebar',
  /** 把「用其他 CLI 继续」的会话记录写成 txt 落到临时目录，返回绝对路径 */
  handoffWrite: 'handoff:write'
} as const

/** preload 暴露给渲染进程的 API 面（唯一声明处） */
export interface ClichildsApi {
  configGet(): Promise<AppConfig>
  configSet(cfg: AppConfig): Promise<AppConfig>
  cliDetect(): Promise<CliStatus[]>
  /** 用某个模型跑一次非交互最小测试（真实调用模型，可能耗时较久） */
  cliModelTest(req: { cli: CliId; model: string }): Promise<CliTestResult>
  dirPick(opts?: { create?: boolean }): Promise<string | null>
  pasteImage(): Promise<string | null>
  bridgeInfo(): Promise<BridgeInfo>
  sessionStart(payload: {
    workDir: string
    profileId: string
    /** 要恢复的 CLI 原生 session id；省略 = 新会话 */
    resumeSessionId?: string
    /** 启动就绪后自动投递的初始提示词（如「用其他 CLI 继续」的交接说明） */
    initialPrompt?: string
  }): Promise<{ sessionId: string }>
  sessionList(): Promise<SessionSummary[]>
  historyList(): Promise<HistoryRecord[]>
  historyDelete(sessionId: string): Promise<void>
  sessionDiscover(req: DiscoverReq): Promise<DiscoveredSession[]>
  transcriptRead(req: TranscriptReq): Promise<TranscriptPage>
  termWrite(id: string, data: string): void
  termResize(id: string, cols: number, rows: number): void
  termKill(id: string): void
  /** 关闭一个子终端并按原参数重开一个；主终端不支持，失败时抛错 */
  termRestart(id: string): Promise<void>
  termRetryPrompt(id: string): void
  termAttach(id: string): Promise<string>
  termDetach(id: string): void
  onSessionsChanged(cb: (list: SessionSummary[]) => void): () => void
  onHistoryChanged(cb: (list: HistoryRecord[]) => void): () => void
  showTermMenu(payload: { id: string; hasSelection: boolean }): void
  onTermMenuAction(cb: (p: { id: string; action: TermMenuAction; workDir?: string }) => void): () => void
  onTermData(cb: (p: { id: string; data: string }) => void): () => void
  onTermExit(cb: (p: { id: string }) => void): () => void
  /** 整表读便签；主进程每次变更后也会整表推给渲染层 */
  notesList(): Promise<Note[]>
  /** 新增一条便签；kind='file' 时主进程会校验路径存在且是文件（目录/不存在直接报错） */
  notesAdd(payload: { workDir: string; kind: NoteKind; content: string; title?: string }): Promise<Note>
  notesUpdate(payload: { id: string; title?: string; content?: string; status?: NoteStatus }): Promise<void>
  notesRemove(id: string): Promise<void>
  /** 不带 workDir = 清全部（管理页），带上 = 只清该工作目录（浮窗） */
  notesClear(payload?: { workDir?: string }): Promise<void>
  /** 切换便签存储目录：现有 notes.json 与图片资产一并迁移；返回写回后的最新配置 */
  notesSetStorage(payload: { dir: string }): Promise<AppConfig>
  onNotesChanged(cb: (list: Note[]) => void): () => void
  /** 解析一条便签要展示的内容；主进程按 noteId 取路径，渲染层不传路径 */
  notesAsset(payload: { noteId: string }): Promise<NoteAssetResult>
  /** 剪贴板图片落盘到便签资产目录，返回绝对路径；没有图片返回 null */
  notesSaveImage(): Promise<string | null>
  /** 读一次剪贴板；优先级 文件 → 图片 → 文本 */
  notesPaste(): Promise<ClipboardPayload>
  /** 用系统默认程序打开便签引用的文件；reveal=true 改为在资源管理器里定位 */
  notesOpenFile(payload: { noteId: string; reveal?: boolean }): Promise<void>
  /** 清理没有便签引用的图片；dryRun=true 只统计不删 */
  notesCleanupAssets(payload: { dryRun: boolean }): Promise<{ removed: number; bytes: number }>
  /** 仓库根相对路径 -> 绝对路径；主进程解析，渲染层不自己拼路径 */
  pathResolve(payload: { workDir: string; path: string }): Promise<string>
  /** 拖入文件取本地路径；非本地文件（网页里拖来的）返回空串 */
  getPathForFile(file: File): string
  outputList(sessionId: string): Promise<OutputBundle[]>
  outputRead(req: { sessionId: string; artifactId: string }): Promise<{
    media: OutputMedia
    text?: string
    dataUrl?: string
  }>
  /** Markdown 内嵌图片：以该 md 为基准解析相对路径，越界或非图片直接拒绝 */
  outputAsset(req: { sessionId: string; artifactId: string; src: string }): Promise<{ dataUrl: string }>
  onOutputsChanged(cb: (p: { sessionId: string; bundles: OutputBundle[] }) => void): () => void
  externalOpen(url: string): Promise<void>
  /** 在工作目录下执行 git rev-parse --abbrev-ref HEAD，非 git 目录返回 null */
  gitBranch(workDir: string): Promise<string | null>
  /** 工作目录及其子目录的变更文件清单（不含 .gitignore 忽略的文件） */
  gitChangesList(workDir: string): Promise<ChangeFile[]>
  /** 取单个文件改动前后的全文；binary / truncated 时正文可能为空或只给前一段 */
  gitDiff(req: { workDir: string; path: string; origPath?: string }): Promise<GitDiffResult>
  /** 在资源管理器里选中该文件；文件已删除时退化成打开它所在的目录 */
  gitReveal(req: { workDir: string; path: string }): Promise<void>
  /** 变更清单变化（主进程的目录监听触发后推送） */
  onGitChanges(cb: (p: { workDir: string; files: ChangeFile[] }) => void): () => void
  /** 新开一个系统终端窗口并定位到该目录（kind 省略 = 配置里的默认 Shell；不执行命令） */
  termOpenShell(workDir: string, kind?: TerminalKind): Promise<void>
  /** 用原生 cmd / PowerShell / Git Bash 窗口打开一份一模一样的终端；终端已结束时报错 */
  termOpenExternal(id: string): Promise<void>
  /** 更新窗口标题栏（原生最小化/最大化/关闭按钮区域）配色，跟随当前皮肤 */
  setTitleBarTheme(payload: { color: string; symbolColor: string }): void
  /** 交接记录落盘：写到系统临时目录的 clichilds-handoff/ 下，返回 txt 绝对路径 */
  handoffWrite(payload: { name: string; text: string }): Promise<{ path: string }>
}
