import type { ChatEntry, CliId, CliPermissionOption } from '../../shared/types'

export interface UsageSample {
  /** 同一模型请求的稳定 id，用于避免同一 usage 在多条记录中重复累计 */
  key?: string
  /** 该 CLI 实际在用的模型展示名（配置里写的可能和 TUI 切过的不一致） */
  model?: string
  input: number
  output: number
  cachedInput?: number
  reasoning?: number
  total: number
  cost?: number
  credit?: number
  exact: boolean
  /** CLI 已提供会话累计值，直接覆盖而不是累加 */
  cumulative?: boolean
}

/** skills / 自定义命令的注入目标 */
export interface SkillTarget {
  kind: 'skills' | 'prompts'
  /** 绝对目录 */
  dir: string
}

/**
 * 模型测试用的探针提示词。只要求模型回一句话，不要求内容；
 * 保持无空格无引号，避免各 Shell 的引号规则参与进来。
 */
export const MODEL_TEST_PROMPT = 'ping'

/** transcript 头部能捞到的会话元信息（回填列表用） */
export interface SessionHead {
  cwd?: string
  startedAt?: number
  title?: string
}

/**
 * 层1 投递的引用：正文已写进工作目录内的临时文件，命令行只带这一句引导语和文件路径。
 * 这样换行、引号、长度上限、粘贴折叠四件事都不再影响投递。
 */
export interface PromptFileRef {
  /** 临时文件路径（相对工作目录，避开各 Shell 对反斜杠的处理差异） */
  file: string
  /** 单行引导语，会原样进命令行，必须短且不含 shell 特殊字符 */
  lead: string
}

/**
 * 自动投递契约：每个 CLI 自己声明「任务怎么送进去、怎么证明收到了」。
 * 整体省略 = 不支持自动投递（不再隐式按「输出静默」投递）。
 */
export interface DeliveryProfile {
  /**
   * 【层1】初始提示怎么拼进启动命令行（拼在最末位，新会话与 resume 同源）。
   * 省略 = 该 CLI 只能靠粘贴投递。
   */
  initialPromptArgs?: (ref: PromptFileRef) => string[]
  /**
   * 层1 的文件形态：
   * inline = CLI 自己把文件内容内联进首条用户消息（pi / codex）；
   * tool-read = CLI 只拿到 @path，由模型自己读（codebuddy / qoder）。
   * 决定确认时能不能比对正文指纹。
   */
  promptFileMode?: 'inline' | 'tool-read'
  /** 【层3，仅粘贴兜底用】输入框就绪锚点，作用于最近一屏而非 spawn 以来的累积文本 */
  ready?: RegExp
  /** 锚点命中后需稳定存在的时长，避开发起瞬间的握手抢键；默认 2500 */
  readyStableMs?: number
  /** 输出静默多久算就绪；默认 1200 */
  readyQuietMs?: number
  /** 没有 ready 时是否允许「静默即就绪」；默认 false（不再由缺字段隐式表达） */
  allowSilentFallback?: boolean
  /** 等就绪的硬超时；默认 60000 */
  readyTimeoutMs?: number
  /** 【层4，仅粘贴兜底用】长粘贴被 TUI 折叠时的证据 */
  foldedEcho?: RegExp
  /** 等屏幕证据的窗口；默认 7000 */
  echoTimeoutMs?: number
  /** 【层2】提交后用 transcript 做接收确认的窗口；默认 30000，0 = 不做 */
  transcriptConfirmMs?: number
}

export interface CliAdapter {
  id: CliId
  label: string
  /** PATH 上可能命中多个，取第一个真实存在的 */
  candidates: string[]
  /** 额外已知安装位置（qoder 的 PATH `qoder` 是 IDE 启动器，故用显式路径兜底） */
  knownExes: () => string[]
  /** 此 CLI 实际支持的权限模式，供设置页动态展示 */
  permissionOptions: CliPermissionOption[]
  /**
   * 生成启动命令（模型为空则省略模型参数，权限为空/无效则使用 default）。
   * extraPrompt 是应用要追加给 CLI 的系统提示（启动注入），各 CLI 自己挑参数与位置。
   */
  launchArgs: (bin: string, model: string, permissionMode?: string, extraPrompt?: string) => string[]
  /** 本 CLI 用户级配置下，skills/自定义命令可写入的目录 */
  skillTargets: () => SkillTarget[]
  /**
   * 启动握手：CLI 启动期对特定界面自动按键。
   * 返回要发送的按键，或 undefined 不处理。由终端在输出稳定后调用。
   */
  startupHandshake?: (visibleText: string) => string | undefined
  /** 自动投递契约（就绪判据、投递方式、确认窗口）。省略 = 不支持自动投递 */
  delivery?: DeliveryProfile

  /**
   * 用指定模型跑一次非交互最小测试的命令行（省略 = 设置页不提供测试按钮）。
   * 模型为空表示测 CLI 自己的默认模型；实现里不要带任何权限参数。
   */
  testArgs?: (bin: string, model: string) => string[]

  /**
   * 预分配原生 session id 的参数片段，追加在 launchArgs 之后。
   * 没有这个能力（codex）就省略，改由文件系统观测反推。
   */
  sessionIdArgs?: (sessionId: string) => string[]
  /**
   * 恢复某个原生会话。各 CLI 的全局参数与子命令顺序不同（codex 要求全局 flag 排在
   * `resume` 之前），所以由适配器自己拼完整命令行。
   */
  resumeArgs?: (
    bin: string,
    model: string,
    permissionMode: string | undefined,
    sessionId: string,
    extraPrompt?: string
  ) => string[]
  /** 该 CLI 存放会话 transcript 的根目录 */
  sessionRoot: () => string
  /**
   * 用原生 id 匹配 transcript 文件名。目录名对 cwd 的编码规则三家各不相同，
   * 所以一律「在 root 下递归找文件名」，不猜目录。
   */
  sessionFileMatch: (sessionId: string) => RegExp
  /** 从 sessionRoot 往下递归的最大层数（codex 按年月日分目录，需要更深） */
  sessionScanDepth?: number
  /** 把一行已解析的 jsonl 记录归一化进 out；无关记录直接返回 */
  parseTranscript?: (line: Record<string, unknown>, out: ChatEntry[]) => void
  /** 从原生 transcript 的一行提取 token/cost 使用事件。 */
  parseUsage?: (line: Record<string, unknown>) => UsageSample | undefined
  /** 从文件前几行提取 cwd / 开始时间 / 标题 */
  readSessionHead?: (lines: string[]) => SessionHead
}
