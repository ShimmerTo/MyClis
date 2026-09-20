import { randomUUID } from 'crypto'
import { basename, resolve } from 'path'
import * as pty from '@lydell/node-pty'
import type { IPty } from '@lydell/node-pty'
import { CH } from '../../shared/types'
import type {
  CliConfig,
  CliId,
  SessionSummary,
  TerminalInfo,
  TerminalRuntimeState,
  TokenUsage,
  TriggerKind
} from '../../shared/types'
import { resolveShell } from './shells'
import { watchNativeSession } from '../sessions/nativeid'
import type { NativeIdWatch } from '../sessions/nativeid'
import { getAdapter } from '../cli/registry'
import type { DeliveryProfile } from '../cli/types'
import { removePromptFile } from '../prompts/promptFile'
import { UsageWatcher } from '../metrics/watcher'
import {
  initialQueryOf,
  lastUserMessageOf,
  locateSessionFile,
  readHeadLines,
  sizeOf
} from '../sessions/sessionFiles'

// 回显窗口必须同时容纳长文本的首尾探针，避免首探针被挤掉。
const ECHO_WINDOW = 65536
/** 就绪判据只看最近一屏：累积文本会让「曾经出现过」冒充「此刻就绪」 */
const READY_WINDOW = 8192
/** 层1 投递确认的轮询间隔 */
const DELIVERY_POLL_MS = 1500
/** 确认后再留一会儿才删临时文件，给模型读取留一轮时间 */
const PROMPT_FILE_KEEP_MS = 60_000


export type TaskAssignments = Record<TriggerKind, CliConfig[]>

function cloneTaskAssignments(assignments: TaskAssignments): TaskAssignments {
  return {
    design: assignments.design.map((profile) => ({ ...profile })),
    write: assignments.write.map((profile) => ({ ...profile })),
    review: assignments.review.map((profile) => ({ ...profile }))
  }
}

interface TerminalOptionsBase {
  /** 预分配的终端 id（主会话要在启动注入里带上它，只能在 spawn 前定下来） */
  id?: string
  profileId?: string
  /** 档案显示名（别名），落到 TerminalInfo.profileLabel */
  label?: string
  taskKind?: TriggerKind
  index?: number
  model?: string
  workDir: string
  shell: TerminalInfo['shell']
  /** 进入 shell 后自动键入的命令（CLI 启动行）；纯 shell 会话没有 */
  initialCommand?: string
  /** CLI 启动行之后、TUI 就绪时再自动键入的一行子任务指令 */
  autoPrompt?: string
  /** CLI 启动期握手（如目录信任弹窗自动回车），autoPrompt 前生效 */
  handshake?: (text: string) => string | undefined
  /** 自动投递契约：就绪判据与确认窗口都从这里取 */
  delivery?: DeliveryProfile
  /**
   * 层1：任务正文已写进这个临时文件、命令行已经带上 @file，不需要再往输入框粘贴。
   * 给了它就走层1（等 transcript 确认），否则才走粘贴链路。
   */
  promptFile?: string
  /** 该 CLI 的原生 session id（能预分配的在 spawn 前就定下来了） */
  nativeSessionId?: string
  /** 子终端指回主终端 */
  parentTermId?: string
  /** 仅主会话保存：启动时的任务分配快照 */
  taskAssignments?: TaskAssignments
  /** 就绪之前攒下的输出不回放给界面（隐藏 chcp 与 CLI 启动行的回显） */
  concealBoot?: boolean
}

/** 跑 CLI 的会话（主会话 / 子任务）：有启动行，也就能预分配或观测原生 session id */
interface CliTerminalOptions extends TerminalOptionsBase {
  role: 'main' | 'child'
  cli: CliId
}

/** 用户手动开的纯 shell：没有启动行，也就没有就绪等待、transcript 与用量 */
interface PlainShellOptions extends TerminalOptionsBase {
  role: 'shell'
  cli: 'shell'
}

/** 按 role 判别：cli 是不是真 CLI 决定后面哪些跟随器能挂 */
export type CreateTerminalOptions = CliTerminalOptions | PlainShellOptions

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '')
}

/** 去掉所有空白后的文本：终端换行不会打断回显匹配 */
function plainKey(s: string): string {
  return stripAnsi(s).replace(/\s+/g, '')
}

/**
 * transcript 里收到的用户消息是不是我们投的那条。
 * 不能只用一个方向的 startsWith：CLI 会加 system-reminder 之类的包裹，
 * 所以改成「收到的包含正文开头」或「正文以收到的开头起始」任一成立即可。
 */
function fingerprintHit(received: string, expected?: string): boolean {
  if (!expected) return true
  const want = plainKey(expected)
  if (!received || !want) return false
  // 长度下限不能省：resume 场景下新消息还没落盘，尾部仍是历史最后一条用户消息，
  // 只要它恰好是本次正文的开头片段就会被误判成已投递。
  if (received.length < Math.min(60, want.length)) return false
  return received.includes(want.slice(0, 40)) || want.startsWith(received.slice(0, 60))
}

/**
 * CodeBuddy 自身加载失败的判据。必须是 Node 的模块加载报错，而不是正文里出现这几个词：
 * `--resume` 会把历史对话（含本项目文档与源码，里面就写着 `Cannot find module ...codebuddy-code...`）
 * 重新打印到终端，只按关键字匹配就会把回放正文当成启动失败，且 error 阶段不会自愈，会话直接废掉。
 * 真报错一定同时有「带引号的模块路径」与 Node 自己的 loader 栈。
 */
function codebuddyModuleMissing(text: string): boolean {
  const hit = /Cannot find module\s+'([^']+)'/i.exec(text)
  if (!hit) return false
  if (!/(?:codebuddy-code|windows-child-process)/i.test(hit[1])) return false
  const around = text.slice(Math.max(0, hit.index - 400), hit.index + hit[0].length + 400)
  return /node:internal\/modules\/cjs\/loader|Require stack:|MODULE_NOT_FOUND/.test(around)
}

/** PowerShell / CMD 默认码页会吞掉 UTF-8 中文，先切到 65001 */
function utf8Prelude(shell: TerminalInfo['shell']): string | null {
  if (shell === 'powershell') return 'chcp 65001 > $null'
  if (shell === 'cmd') return 'chcp 65001 >nul'
  return null
}

interface Managed {
  info: TerminalInfo
  proc: IPty
  startedAt: number
  lastOutputAt: number
  /** 渲染层是否有终端挂载在此会话上 */
  attached: boolean
  /** 未挂载期间攒下的原始输出（含 ANSI），挂载时回放 */
  raw: string
  done?: boolean
  runtime: TerminalRuntimeState
  usage?: TokenUsage
  initialQuery?: string
  taskAssignments?: TaskAssignments
  /** 就绪前的输出攒下来会被丢弃，界面等 phase 离开 booting 后才挂载 */
  concealBoot?: boolean
  /** 启动时键入的那行 CLI 命令：「用原生窗口打开一份」要原样再跑一遍 */
  launchLine?: string
  /** 观测原生 session id 的轮询（codex 这类无法预分配的 CLI） */
  nativeWatch?: NativeIdWatch
  usageWatch?: UsageWatcher
  queryTimer?: NodeJS.Timeout
  /** 层1 投递确认的轮询（等 transcript 出现这次提交的用户消息） */
  deliveryTimer?: NodeJS.Timeout
  stopDeliveryWatch?: () => void
  /** 层1 投递的正文指纹（比对 transcript 用） */
  deliveryText?: string
  retryPrompt?: () => void
  stopStartup?: () => void
  promptSubmitted?: boolean
  /** 是否出过任何输出（纯启动期还没吐字不算「停止输出」） */
  hadOutput?: boolean
  /** 本轮静默是否已通知过；出新的输出后复位 */
  idleNotified?: boolean
  /** 剥离 ANSI 后的屏幕尾部：nudge 判断主 CLI 是不是停在输入框 */
  plainTail: string
  /** 该 CLI 的投递契约，nudge 与粘贴链路共用 */
  delivery?: DeliveryProfile
  /** 层1 投递写下的临时文件，终端结束时清理（确认时不能删：模型可能还没读） */
  promptFile?: string
}

/** 「有过输出 → 持续静默」多久算停止输出（毫秒） */
const IDLE_NOTIFY_MS = 30_000
/** 静默检测的扫描间隔（毫秒） */
const IDLE_CHECK_INTERVAL_MS = 5_000
/** 给主 CLI 补提醒前要求的静默时长：它得确实停在输入框，而不是正在长回合里 */
const NUDGE_QUIET_MS = 45_000
/** 补提醒的回显确认窗口 */
const NUDGE_ECHO_MS = 1_500
/** 屏幕尾部保留长度（nudge 的探针只需要一小段） */
const NUDGE_TAIL = 4096

type Emitter = (channel: string, payload: unknown) => void

/**
 * pty 会话管理：主终端 + 子任务终端统一在这里创建/销毁。
 * 数据流：pty -> onTermData -> 渲染层 xterm；xterm -> term:write -> pty。
 */
export class TerminalManager {
  private map = new Map<string, Managed>()
  private exitListeners = new Set<(info: TerminalInfo, runtime: TerminalRuntimeState) => void>()
  private nativeIdListeners = new Set<(termId: string, nativeSessionId: string) => void>()
  private idleListeners = new Set<(info: TerminalInfo, silentMs: number) => void>()
  private idleTimer: NodeJS.Timeout
  private notifiedAt = 0

  constructor(private emit: Emitter) {
    this.idleTimer = setInterval(() => this.checkIdle(), IDLE_CHECK_INTERVAL_MS)
    // 不让检测定时器拖住进程退出（托盘常驻时无所谓，退出时省心）
    this.idleTimer.unref()
  }

  /** 会话从「有过输出」变为持续静默时回调；每个静默周期只回调一次，再出输出后复位 */
  onIdle(cb: (info: TerminalInfo, silentMs: number) => void): () => void {
    this.idleListeners.add(cb)
    return () => this.idleListeners.delete(cb)
  }

  private checkIdle(): void {
    if (this.idleListeners.size === 0) return
    const now = Date.now()
    for (const m of this.map.values()) {
      if (!m.hadOutput || m.idleNotified) continue
      // 启动期本就会短暂静默，已出结果/已结束的会话也不会再输出，都不算「停止输出」
      if (m.runtime.phase === 'booting' || m.runtime.phase === 'done' || m.done) continue
      const silentMs = now - m.lastOutputAt
      if (silentMs < IDLE_NOTIFY_MS) continue
      m.idleNotified = true
      for (const cb of this.idleListeners) cb(m.info, silentMs)
    }
  }

  onTerminalExit(cb: (info: TerminalInfo, runtime: TerminalRuntimeState) => void): () => void {
    this.exitListeners.add(cb)
    return () => this.exitListeners.delete(cb)
  }

  /** 原生 session id 观测到了（codex 主/子终端都靠它补记） */
  onNativeId(cb: (termId: string, nativeSessionId: string) => void): () => void {
    this.nativeIdListeners.add(cb)
    return () => this.nativeIdListeners.delete(cb)
  }

  get(id: string): TerminalInfo | undefined {
    return this.map.get(id)?.info
  }

  /** 会话当前的运行阶段（子任务失败判定要读它：phase=error 表示任务没投递进输入框） */
  runtimeOf(id: string): TerminalRuntimeState | undefined {
    const m = this.map.get(id)
    return m ? { ...m.runtime } : undefined
  }

  /** 「用原生窗口打开一份」需要的参数：工作目录、该终端自己的 Shell，以及 CLI 会话的同一行启动命令 */
  externalTarget(id: string): { workDir: string; shell: TerminalInfo['shell']; command?: string } | undefined {
    const m = this.map.get(id)
    if (!m) return undefined
    return { workDir: m.info.workDir, shell: m.info.shell, command: m.launchLine }
  }

  /** 终端挂载：取回未挂载期间攒下的输出，此后改为实时转发 */
  attach(id: string): string {
    const m = this.map.get(id)
    if (!m) return ''
    m.attached = true
    // 直接从 booting 跳走（如子终端跑到 done）的情况在挂载时补丢弃；异常照样保留给「查看终端」
    const drop = !!m.concealBoot && m.runtime.phase !== 'error'
    if (drop) m.concealBoot = false
    const out = drop ? '' : m.raw
    m.raw = ''
    return out
  }

  /** 终端卸载（例如切回启动页）：停止转发，输出改为缓冲 */
  detach(id: string): void {
    const m = this.map.get(id)
    if (m) m.attached = false
  }

  /** 最近启动的主会话。 */
  latestMain(): TerminalInfo | undefined {
    return [...this.map.values()]
      .filter((m) => m.info.role === 'main')
      .sort((a, b) => b.startedAt - a.startedAt)[0]?.info
  }

  /** 按终端 id 找主会话；不是主会话或已退出都算找不到 */
  mainById(id: string): TerminalInfo | undefined {
    const managed = this.map.get(id)
    return managed?.info.role === 'main' ? managed.info : undefined
  }

  /** 找到该工作目录里任务分配快照对应的主会话。 */
  taskContext(
    workDir: string,
    kind: TriggerKind,
    sessionId?: string
  ): { main: TerminalInfo; profiles: CliConfig[] } | undefined {
    const managed = this.pickMain(workDir, sessionId, true)
    if (!managed) return undefined
    return {
      main: managed.info,
      profiles: (managed.taskAssignments?.[kind] ?? []).map((item) => ({ ...item }))
    }
  }

  sessions(): SessionSummary[] {
    return [...this.map.values()]
      .sort((a, b) => a.startedAt - b.startedAt)
      .map((m) => ({
        ...m.info,
        startedAt: m.startedAt,
        lastOutputAt: m.lastOutputAt,
        done: m.done,
        initialQuery: m.initialQuery,
        runtime: { ...m.runtime },
        usage: m.usage ? { ...m.usage } : undefined
      }))
  }

  mainForWorkDir(workDir: string, sessionId?: string): TerminalInfo {
    const managed = this.pickMain(workDir, sessionId, false)
    if (!managed) throw new Error(`未找到工作目录对应的主 CLI 会话：${workDir}`)
    return managed.info
  }

  /**
   * 解析请求该落到哪个主会话：会话标识命中（在跑的主会话）就用它，
   * 否则回落该工作目录里最近活跃的一个（并列取最近启动的）。
   * 同一目录允许多个主会话，这里不再报错——请求方本来就带着「我是谁」；
   * 显式给了 id 却无效时：/trigger 报错（静默投给别的会话更糟），/present 回退（丢输出更糟）。
   */
  private pickMain(workDir: string, sessionId: string | undefined, strictSession: boolean): Managed | undefined {
    const given = sessionId?.trim()
    if (given) {
      const managed = this.map.get(given)
      if (managed?.info.role === 'main') return managed
      if (strictSession) {
        throw new Error(`会话标识无效或该会话已结束：${given}；省略该字段可回退到该工作目录最近启动的主会话`)
      }
    }
    const normalized = resolve(workDir).toLowerCase()
    return [...this.map.values()]
      .filter((m) => m.info.role === 'main' && resolve(m.info.workDir).toLowerCase() === normalized)
      .sort((a, b) => b.lastOutputAt - a.lastOutputAt || b.startedAt - a.startedAt)[0]
  }

  markDone(id: string, resultFile?: string): void {
    const m = this.map.get(id)
    if (!m || m.done) return
    m.done = true
    m.stopStartup?.()
    m.runtime = { phase: 'done', message: '结果已生成', changedAt: Date.now() }
    if (resultFile) m.info.resultFile = resultFile
    this.notify()
  }

  retryPrompt(id: string): boolean {
    const managed = this.map.get(id)
    if (!managed?.retryPrompt || managed.runtime.phase !== 'error' || managed.promptSubmitted || managed.done) return false
    managed.retryPrompt()
    return true
  }

  /**
   * 给主终端补一条极短提醒（子任务状态有变化，而主 CLI 已经不在 /wait 循环里了）。
   * 只有「CLI 确实停在输入框、且安静了足够久」才敢敲字；只投递一次，
   * 回显没确认就把刚贴进去的内容清掉，绝不盲按回车、也不重复贴 —— 宁可不提醒。
   * 返回是否真的投递了（调用方拿它做冷却）。
   */
  nudge(id: string, text: string): boolean {
    const m = this.map.get(id)
    if (!m || m.info.role !== 'main') return false
    if (m.runtime.phase === 'booting' || m.runtime.phase === 'delivering') return false
    if (Date.now() - m.lastOutputAt < NUDGE_QUIET_MS) return false
    if (m.delivery?.ready && !m.delivery.ready.test(m.plainTail)) return false
    const body = text.replace(/\u001b/g, '')
    const probe = plainKey(body.slice(0, 24))
    m.proc.write(`\x1b[200~${body}\x1b[201~`)
    setTimeout(() => {
      if (!this.map.has(id)) return
      if (probe && plainKey(m.plainTail).includes(probe)) m.proc.write('\r')
      else m.proc.write('\x15')
    }, NUDGE_ECHO_MS)
    return true
  }

  setUsage(id: string, usage: TokenUsage): void {
    const m = this.map.get(id)
    if (!m) return
    m.usage = usage
    this.notify()
  }

  /** 事后补上的原生 session id；终端已退出也要通知订阅方，历史记录还得补 */
  setNativeSessionId(id: string, nativeSessionId: string): void {
    const m = this.map.get(id)
    if (m && !m.info.nativeSessionId) {
      m.info.nativeSessionId = nativeSessionId
      this.startUsageWatch(id, m)
      this.startQueryWatch(id, m)
      this.notify()
    }
    for (const cb of this.nativeIdListeners) cb(id, nativeSessionId)
  }

  private startUsageWatch(id: string, managed: Managed): void {
    if (managed.usageWatch || !managed.info.nativeSessionId) return
    // 纯 shell 没有 CLI 适配器，也没有 transcript 可跟随
    if (managed.info.cli === 'shell') return
    const adapter = getAdapter(managed.info.cli)
    if (!adapter?.parseUsage) return
    managed.usageWatch = new UsageWatcher(adapter, managed.info.nativeSessionId, (usage, model) => {
      if (this.map.get(id) !== managed) return
      // 模型是 CLI 自己记的事实：用户在 TUI 里换过模型时，配置里的名字就不再可信
      if (model) managed.info.model = model
      this.setUsage(id, usage)
    })
  }

  /**
   * 问题描述来自 CLI 自己的 transcript，首条用户消息往往是敲下去之后才落盘的，
   * 所以拿到原生 id 后隔一段时间重试几次，读到就停。
   */
  private startQueryWatch(id: string, managed: Managed): void {
    if (managed.queryTimer || managed.initialQuery) return
    if (managed.info.cli === 'shell') return
    const adapter = getAdapter(managed.info.cli)
    if (!adapter) return
    let tries = 0
    let file = ''
    const attempt = (): void => {
      managed.queryTimer = undefined
      if (this.map.get(id) !== managed || managed.initialQuery) return
      tries += 1
      const nativeSessionId = managed.info.nativeSessionId
      if (nativeSessionId) {
        try {
          // 定位一次就记住；之后只重读这一份文件头部，不用再遍历目录
          file = file || locateSessionFile(adapter, nativeSessionId)?.file || ''
          const query = file ? initialQueryOf(adapter, readHeadLines(file)) : undefined
          if (query) {
            managed.initialQuery = query
            this.notify()
            return
          }
        } catch {
          file = ''
        }
      }
      if (tries < 60) managed.queryTimer = setTimeout(attempt, 10_000)
    }
    managed.queryTimer = setTimeout(attempt, 2500)
  }

  /**
   * 层1 的接收确认：任务正文已经在启动行里交给 CLI，这里只等它把这次的用户消息写进 transcript。
   * inline（pi/codex）比对正文指纹；tool-read（codebuddy/qoder）只认文件引用出现 ——
   * 它们的首条用户消息文本只有 `@path`，比对正文必然失败。
   * 一律看尾部：resume 出来的会话头部是历史消息，只有尾部才是这次刚提交的。
   * 确认不了不报错，转「已提交待确认」，绝不重复投递。
   */
  private startDeliveryConfirm(
    id: string,
    managed: Managed,
    setRuntime: (phase: TerminalRuntimeState['phase'], message?: string, uncertain?: boolean) => void
  ): void {
    const mode = managed.delivery?.promptFileMode ?? 'inline'
    const timeout = managed.delivery?.transcriptConfirmMs ?? 30_000
    const ref = managed.promptFile ? basename(managed.promptFile).toLowerCase() : ''
    // 定位一次就记住；每次轮询都遍历整棵会话目录会把主进程拖住
    let file = ''
    let seenBytes = -1
    let last = ''
    const startedAt = Date.now()
    const stop = (): void => {
      if (managed.deliveryTimer) clearInterval(managed.deliveryTimer)
      managed.deliveryTimer = undefined
    }
    managed.stopDeliveryWatch = stop
    managed.deliveryTimer = setInterval(() => {
      // 会话没了、已结束、或已经判过异常，都不要再改状态
      if (this.map.get(id) !== managed || managed.done || managed.runtime.phase === 'error') {
        stop()
        return
      }
      const adapter = managed.info.cli === 'shell' ? undefined : getAdapter(managed.info.cli)
      const nid = managed.info.nativeSessionId
      let hit = false
      if (nid && adapter?.parseTranscript) {
        try {
          if (!file) file = locateSessionFile(adapter, nid)?.file ?? ''
          if (file) {
            // 文件没长大就不用重新解析：一轮会话尾部可能上兆
            const bytes = sizeOf(file)
            if (bytes !== seenBytes) {
              seenBytes = bytes
              last = lastUserMessageOf(adapter, file) ?? ''
            }
          }
          if (last) {
            const received = plainKey(last)
            hit = mode === 'inline' ? fingerprintHit(received, managed.deliveryText) : received.includes(ref)
          }
        } catch (error) {
          console.error('读取层1 投递确认失败', error)
        }
      }
      if (hit) {
        stop()
        // 确认后也不立刻删：tool-read 那两家是「先记用户消息、再由模型读文件」。
        // 给足一轮读取的时间再删，避免任务正文凭空消失。
        const target = managed.promptFile
        setTimeout(() => {
          if (this.map.get(id) !== managed) return
          removePromptFile(target)
          managed.promptFile = undefined
        }, PROMPT_FILE_KEEP_MS).unref?.()
        // 先不删临时文件：tool-read 那两家是「先记用户消息、再由模型读文件」，
        // 确认就删会赶在读取之前。文件统一在终端结束时清理。
        managed.promptSubmitted = true
        setRuntime('running', '任务已投递（transcript 确认）')
        return
      }
      if (Date.now() - startedAt >= timeout) {
        stop()
        managed.promptSubmitted = true
        setRuntime('running', '任务已随启动行提交，接收未确认；请勿重复投递', true)
      }
    }, DELIVERY_POLL_MS)
    managed.deliveryTimer.unref?.()
  }

  /** 会话列表推送（输出会高频触发，这里限流到 1s 一次） */
  private notify(): void {
    this.emit(CH.sessionsChanged, this.sessions())
  }

  private touch(m: Managed): void {
    const now = Date.now()
    m.lastOutputAt = now
    // 出过输出才算「活跃过」；有新输出就重新武装静默通知
    m.hadOutput = true
    m.idleNotified = false
    if (now - this.notifiedAt < 1000) return
    this.notifiedAt = now
    this.notify()
  }

  create(opts: CreateTerminalOptions): TerminalInfo {
    const shell = resolveShell(opts.shell)
    if (!shell) throw new Error(`终端不可用：${opts.shell}（请确认已安装 Git for Windows）`)
    const wanted = opts.id ?? randomUUID()
    // 预分配 id 撞上在跑的终端时直接换一个：注入文案里的 id 失效会走兜底，总好过覆盖台账
    const id = this.map.has(wanted) ? randomUUID() : wanted
    const proc = pty.spawn(shell.file, shell.args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: opts.workDir,
      env: { ...process.env } as Record<string, string>
    })
    const info: TerminalInfo = {
      id,
      role: opts.role,
      profileId: opts.profileId,
      profileLabel: opts.label,
      taskKind: opts.taskKind,
      index: opts.index,
      cli: opts.cli,
      model: opts.model,
      workDir: opts.workDir,
      shell: opts.shell,
      nativeSessionId: opts.nativeSessionId,
      parentTermId: opts.parentTermId
    }
    const startedAt = Date.now()
    const managed: Managed = {
      info,
      proc,
      startedAt,
      lastOutputAt: startedAt,
      attached: false,
      raw: '',
      plainTail: '',
      delivery: opts.delivery,
      promptFile: opts.promptFile,
      deliveryText: opts.promptFile ? opts.autoPrompt : undefined,
      runtime:
        opts.role === 'shell'
          ? // 纯 shell 没有 CLI 要等，一建出来就是就绪态（界面直接挂 xterm，不显示启动层）
            { phase: 'ready', message: '终端已就绪', changedAt: startedAt }
          : { phase: 'booting', message: 'CLI 启动中', changedAt: startedAt },
      concealBoot: !!opts.concealBoot && !!opts.initialCommand,
      launchLine: opts.initialCommand,
      taskAssignments: opts.taskAssignments ? cloneTaskAssignments(opts.taskAssignments) : undefined
    }
    this.map.set(id, managed)
    this.startUsageWatch(id, managed)
    this.startQueryWatch(id, managed)
    this.notify()
    // 没预分配 id 的 CLI（codex）只能事后观测；纯 shell 会话没有 id 可观测
    if (opts.role !== 'shell' && opts.initialCommand && !info.nativeSessionId) {
      managed.nativeWatch = watchNativeSession({
        cli: opts.cli,
        workDir: opts.workDir,
        startedAt,
        onFound: (nativeSessionId) => this.setNativeSessionId(id, nativeSessionId)
      })
    }
    let screen = ''
    let plain = ''
    let handshakeActive = true
    let settleTimer: NodeJS.Timeout | null = null
    let deliveryTimer: NodeJS.Timeout | null = null
    let keysSent = 0
    let lastKeyAt = 0
    let lastDataAt = Date.now()
    const setRuntime = (
      phase: TerminalRuntimeState['phase'], message?: string, attempt?: number, submissionUncertain?: boolean
    ): void => {
      if (this.map.get(id) !== managed || managed.done) return
      managed.runtime = { phase, message, changedAt: Date.now(), deliveryAttempt: attempt, submissionUncertain }
      // 界面先显示加载层、等就绪才挂载终端：启动期攒下的回显（chcp、CLI 启动行）离开 booting 时丢弃；
      // 异常则保留原始输出，「查看终端」还能看到 CLI 自己报的错
      if (managed.concealBoot && phase !== 'booting' && phase !== 'error') {
        managed.concealBoot = false
        managed.raw = ''
      }
      this.notify()
    }
    const stopHandshake = (): void => {
      handshakeActive = false
      if (settleTimer) {
        clearTimeout(settleTimer)
        settleTimer = null
      }
    }
    managed.stopStartup = () => {
      stopHandshake()
      if (deliveryTimer) clearInterval(deliveryTimer)
      deliveryTimer = null
      // 层1 的确认轮询也归启动流程管，会话结束时一起停
      if (managed.deliveryTimer) clearInterval(managed.deliveryTimer)
      managed.deliveryTimer = undefined
    }
    proc.onData((data) => {
      if (this.map.get(id) !== managed) return
      if (managed.attached) this.emit(CH.termData, { id, data })
      else managed.raw = (managed.raw + data).slice(-65536)
      screen = (screen + data).slice(-ECHO_WINDOW)
      plain = (plain + stripAnsi(data)).slice(-ECHO_WINDOW)
      managed.plainTail = plain.slice(-NUDGE_TAIL)
      lastDataAt = Date.now()
      this.touch(managed)
      if (opts.cli === 'codebuddy' && codebuddyModuleMissing(stripAnsi(screen))) {
        managed.stopStartup?.()
        setRuntime('error', 'CodeBuddy 工具模块缺失；请在设置页复制诊断并检查当前 Node/NVM 安装')
      }
      if (!opts.autoPrompt && managed.runtime.phase === 'booting' && opts.delivery?.ready?.test(plain)) {
        setRuntime('ready', '输入框已就绪')
      }
      if (!handshakeActive || !opts.handshake) return
      // 等界面稳定后再判定，避免启动过程中连按回车
      if (settleTimer) clearTimeout(settleTimer)
      settleTimer = setTimeout(() => {
        settleTimer = null
        if (!handshakeActive) return
        const key = opts.handshake!(screen)
        if (!key || keysSent >= 6 || Date.now() - lastKeyAt < 800) return
        proc.write(key)
        screen = ''
        keysSent += 1
        lastKeyAt = Date.now()
      }, 400)
    })
    proc.onExit(() => this.remove(id))

    const prelude = utf8Prelude(opts.shell)
    if (opts.initialCommand) {
      // 先把控制台切到 UTF-8（否则中文指令会被 GBK 码页吃掉），再键入 CLI 启动命令
      if (prelude) {
        setTimeout(() => {
          if (this.map.has(id)) proc.write(`${prelude}\r`)
        }, 500)
      }
      setTimeout(() => {
        if (this.map.has(id)) proc.write(`${opts.initialCommand}\r`)
      }, prelude ? 1600 : 600)
    }
    if (opts.promptFile) {
      // 层1：任务正文在启动行里就交给 CLI 了，这里只等它把这次的用户消息写进 transcript
      setRuntime('delivering', '任务已随启动行提交，等待接收确认')
      this.startDeliveryConfirm(id, managed, (phase, message, uncertain) =>
        setRuntime(phase, message, undefined, uncertain)
      )
    } else if (opts.autoPrompt) {
      // reviewer 投递必须确认文本真正进入输入框；禁止超时后盲打正文或回车。
      // 投递前再剥一次 ESC：正文里的 `\x1b` 会把括号粘贴提前闭合，后半段变成键盘输入。
      const prof = opts.delivery
      const promptText = opts.autoPrompt.replace(/\u001b/g, '')
      const probes = [plainKey(promptText.slice(0, 32)), plainKey(promptText.slice(-32))].filter(Boolean)
      let attempt = 0
      let promptTyped = false
      const verifyTranscript = (): boolean => {
        const nid = managed.info.nativeSessionId
        const adapter = managed.info.cli === 'shell' ? undefined : getAdapter(managed.info.cli)
        if (!nid || !adapter?.parseTranscript) return false
        try {
          const file = locateSessionFile(adapter, nid)?.file
          const query = file ? initialQueryOf(adapter, readHeadLines(file)) : undefined
          const received = plainKey(query ?? '')
          const expected = plainKey(promptText)
          return received.length >= Math.min(60, expected.length) && expected.startsWith(received)
        } catch (error) {
          console.error('读取任务投递确认失败', error)
          return false
        }
      }
      const deliver = (): void => {
        attempt += 1
        let state: 'boot' | 'typed' | 'verify' = 'boot'
        let typedAt = 0
        let verifyAt = 0
        let lastVerifyAt = 0
        let matchSince = 0
        const bootAt = Date.now()
        if (deliveryTimer) clearInterval(deliveryTimer)
        handshakeActive = true
        keysSent = 0
        setRuntime('booting', '等待 CLI 输入框就绪', attempt)
        if (promptTyped) {
          plain = ''
          screen = ''
          promptTyped = false
          proc.write('\x15')
        }
        deliveryTimer = setInterval(() => {
          if (this.map.get(id) !== managed || managed.done || managed.runtime.phase === 'error') {
            managed.stopStartup?.()
            return
          }
          const now = Date.now()
          const quiet = now - lastDataAt > (prof?.readyQuietMs ?? 1200)
          if (state === 'boot') {
            // 就绪 = 输入框文案命中 且（屏幕静默 或 文案已稳定出现）。
            // qoder 空闲界面有持续重绘的状态栏/光标，全局静默几乎永远等不到，
            // 只靠 quiet 会把投递饿死到超时（正文根本没粘贴进去）。
            // 文案稳定出现 2.5s 作为兜底：既避开发起瞬间的握手/hook 抢键，又不被重绘饿死。
            // 只匹配最近一屏：累积文本会让「banner 里出现过一次」冒充「此刻就绪」。
            const matched = !!prof?.ready && prof.ready.test(plain.slice(-READY_WINDOW))
            if (matched && !matchSince) matchSince = now
            else if (!matched) matchSince = 0
            const stable = matchSince > 0 && now - matchSince > (prof?.readyStableMs ?? 2500)
            const ready = prof?.ready
              ? matched && (quiet || stable)
              : !!prof?.allowSilentFallback && quiet && now - bootAt > 3000
            if (!ready) {
              if (now - bootAt > (prof?.readyTimeoutMs ?? 60000)) {
                managed.stopStartup?.()
                setRuntime('error', '等待 CLI 输入框超时；可手动重试投递', attempt)
              }
              return
            }
            stopHandshake()
            state = 'typed'
            typedAt = now
            plain = ''
            setRuntime('delivering', '正在投递任务', attempt)
            promptTyped = true
            proc.write(`\x1b[200~${promptText}\x1b[201~`)
            return
          }
          if (state === 'verify') {
            if (now - verifyAt < 4000) return
            if (now - verifyAt < 30000 && now - lastVerifyAt < 2000) return
            lastVerifyAt = now
            if (verifyTranscript()) {
              managed.stopStartup?.()
              setRuntime('running', '任务已投递（transcript 确认）', attempt)
            } else if (now - verifyAt >= (prof?.transcriptConfirmMs ?? 30000)) {
              managed.stopStartup?.()
              setRuntime('running', '任务已提交但接收未确认；等待结果，请勿重复投递', attempt, true)
            }
            return
          }
          if (now - typedAt < 800) return
          const echoed = plainKey(plain)
          if (probes.length > 0 && probes.every((probe) => echoed.includes(probe))) {
            managed.promptSubmitted = true
            managed.stopStartup?.()
            proc.write('\r')
            setRuntime('running', '任务已投递', attempt)
            return
          }
          if (now - typedAt < (prof?.echoTimeoutMs ?? 7000)) return
          // 折叠证据由适配器声明：codebuddy/qoder 是 [Pasted text #N]，codex 是 [Pasted Content N chars]，pi 是 [paste #N]
          const folded = !!prof?.foldedEcho && prof.foldedEcho.test(echoed)
          if (!folded) {
            managed.stopStartup?.()
            setRuntime('error', '任务回显未确认，尚未提交；可查看终端后重试投递', attempt)
            return
          }
          // 折叠回显只证明输入框收下了粘贴；提交后只能等确认，不能再次整段重投。
          state = 'verify'
          verifyAt = now
          managed.promptSubmitted = true
          setRuntime('delivering', '任务已提交，等待接收确认', attempt, true)
          proc.write('\r')
        }, 300)
      }
      managed.retryPrompt = deliver
      deliver()
    } else {
      setTimeout(stopHandshake, 12000)
      // 没有稳定 placeholder 的 CLI（如 Pi）用静默作为主终端 ready 的兜底。
      setTimeout(() => {
        if (this.map.has(id) && managed.runtime.phase === 'booting') setRuntime('ready', '终端已就绪')
      }, 5000)
    }
    return info
  }

  write(id: string, data: string): void {
    const managed = this.map.get(id)
    if (!managed) return
    managed.proc.write(data)
    if (managed.runtime.phase === 'ready') {
      // 焦点上报（\x1b[I）、鼠标回传这类纯控制序列是终端挂载/TUI 带来的自动回包，
      // 不算「开始交互」；只有剥掉转义与控制字符后还有可见字符的键入才推到 running，
      // 否则刚进工作台页卡就转圈，看起来像已经在执行任务。
      const visible = data
        .replace(/\x1b\[[0-9;:<=?>!]*[ -/]*[@-~]/g, '')
        .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
        .replace(/[\x00-\x1f\x7f\x80-\x9f]/g, '')
      if (visible) {
        managed.runtime = { phase: 'running', message: '已开始交互', changedAt: Date.now() }
        this.notify()
      }
    }
  }

  resize(id: string, cols: number, rows: number): void {
    try {
      this.map.get(id)?.proc.resize(Math.max(20, cols), Math.max(6, rows))
    } catch {
      /* pty 已退出时忽略 */
    }
  }

  private remove(id: string): void {
    const managed = this.map.get(id)
    if (!managed) return
    this.map.delete(id)
    managed.stopStartup?.()
    managed.stopDeliveryWatch?.()
    managed.nativeWatch?.stop()
    managed.usageWatch?.stop()
    // 层1 写下的临时文件不能留在用户仓库里
    removePromptFile(managed.promptFile)
    managed.promptFile = undefined
    if (managed.queryTimer) clearTimeout(managed.queryTimer)
    this.emit(CH.termExit, { id })
    for (const cb of this.exitListeners) cb(managed.info, managed.runtime)
    if (managed.info.role === 'main') {
      for (const child of [...this.map.values()]) {
        if (child.info.role === 'child' && child.info.parentTermId === id) this.kill(child.info.id)
      }
    }
    this.notify()
  }

  kill(id: string): void {
    const managed = this.map.get(id)
    if (!managed) return
    this.remove(id)
    try {
      managed.proc.kill()
    } catch (error) {
      console.error('关闭终端进程失败', error)
    }
  }
}
