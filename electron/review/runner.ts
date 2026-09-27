import { existsSync, mkdirSync, statSync } from 'fs'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'path'
import { MAX_CHILD_RETRIES, POLL_INTERVAL_MIN_MINUTES, POLL_INTERVAL_MAX_MINUTES } from '../../shared/types'
import type {
  ChildFailure,
  ChildControlEntry,
  HistoryChild,
  CliConfig,
  OutputProducer,
  RetryResponse,
  RunSnapshot,
  TerminalInfo,
  TriggerKind,
  TriggerRequest,
  TriggerResponse,
  TriggerTarget
} from '../../shared/types'
import { permissionLabelOf, profileLabel } from '../../shared/profile'
import { latestHistoryChildren } from '../../shared/children'
import { getCliBin } from '../cli/detect'
import { buildLaunch } from '../cli/launch'
import { getAdapter } from '../cli/registry'
import { loadConfig } from '../config/store'
import { PROMPT_LEAD, removePromptFile, writePromptFile } from '../prompts/promptFile'
import { ensureSessionWorkspace } from '../sessions/workspace'
import { toShellLine } from '../util'
import { bridgePort } from '../bridge/server'
import type { TerminalManager } from '../pty/terminals'
import type { HistoryStore } from '../sessions/history'
import type { OutputStore } from '../outputs/store'
import { abortRun, canRetry, hasWaiter, markTarget, newRun, nextAction, snapshot, trackRun, waitForChange } from './runs'
import type { ChildSpec, RunRecord, TargetRecord, WaitEnd } from './runs'

/** 子任务状态变化后唤醒主 CLI 的最短间隔（毫秒） */
const NUDGE_COOLDOWN_MS = 60_000

/**
 * 触发执行器：bridge 收到 /trigger/{design|write|review} 后，
 * 按主会话启动时的任务分配快照打开右侧子终端，并一直盯着结果 md 落盘。
 *
 * 每个 run 是一本台账：/status 查快照、/wait 阻塞等变化、/retry 重开失败的子任务。
 * 台账只放在内存里 —— 主终端一退出 run 就作废，应用重启后 runId 一律失效。
 */
export class ReviewRunner {
  private runs = new Map<string, RunRecord>()
  /** termId -> 归属的 run/目标，重开与「终端已退出仍能重试」都靠它 */
  private termIndex = new Map<string, { runId: string; profileId: string }>()
  /** termId -> 结果文件轮询定时器 */
  private watching = new Map<string, NodeJS.Timeout>()
  /** runId -> 上次提醒主 CLI 的时刻 */
  private nudgedAt = new Map<string, number>()
  private resuming = new Set<string>()

  constructor(
    private manager: TerminalManager,
    private history: HistoryStore,
    private outputs?: OutputStore
  ) {
    // 主终端退出 = 这次 run 没人盯了：立刻作废并唤醒所有 /wait，避免重试无限拉起。
    manager.onTerminalExit((info, runtime) => {
      const link = this.termIndex.get(info.id)
      const target = link ? this.runs.get(link.runId)?.targets.get(link.profileId) : undefined
      if (target) target.submissionUncertain = !!runtime.submissionUncertain
      this.termIndex.delete(info.id)
      if (info.role !== 'main') return
      for (const run of this.runs.values()) {
        if (run.mainTermId !== info.id) continue
        abortRun(run)
        for (const target of run.targets.values()) this.stopWatch(target.termId)
        this.nudgedAt.delete(run.runId)
      }
    })
  }

  /** 历史换绑之后同步迁移台账和原 spec 对象；异步启动、结果回调及重试都读取同一归属。 */
  reparentChildren(oldId: string, newId: string, workspaceSessionId: string): void {
    for (const run of this.runs.values()) {
      if (run.mainTermId !== oldId) continue
      run.mainTermId = newId
      for (const target of run.targets.values()) target.spec.parentTermId = newId
      // 已作废的 run 仍作废，不能因 resume 自动重启旧任务。
      this.nudgedAt.delete(run.runId)
    }
    this.manager.reparentChildren(oldId, newId, workspaceSessionId)
  }

  children(sessionId: string): ChildControlEntry[] {
    if (!this.manager.mainById(sessionId)) throw new Error('主会话已结束，请使用当前会话标识')
    return latestHistoryChildren(this.history.find(sessionId)?.children ?? []).map((child) => {
      const live = this.manager.get(child.termId)
      const link = this.termIndex.get(child.termId)
      let resumeDisabledReason: string | undefined
      try { this.resumeContext(sessionId, child.termId) } catch (error) {
        resumeDisabledReason = error instanceof Error ? error.message : '无法恢复此子会话'
      }
      return {
        termId: child.termId, cli: child.cli, profileId: child.profileId,
        profileLabel: child.profileLabel, nativeSessionId: child.nativeSessionId,
        taskKind: child.taskKind, live: !!live, resumable: !resumeDisabledReason,
        resumeDisabledReason, runId: link?.runId, resultFile: child.resultFile,
        approval: this.manager.runtimeOf(child.termId)?.approval
      }
    })
  }

  chooseApproval(sessionId: string, termId: string, approvalId: string, option: string): void {
    this.manager.chooseApproval(sessionId, termId, approvalId, option)
    const link = this.termIndex.get(termId)
    const run = link ? this.runs.get(link.runId) : undefined
    const target = link ? run?.targets.get(link.profileId) : undefined
    if (!run || !target || target.state !== 'waiting-approval') return
    target.approvalWaitMs = (target.approvalWaitMs ?? 0) + Date.now() - (target.approvalSince ?? Date.now())
    target.approvalSince = undefined
    markTarget(run, target, 'running')
  }

  private resumeContext(sessionId: string, termId: string): { main: TerminalInfo; child: HistoryChild; profile: CliConfig; key: string } {
    const main = this.manager.mainById(sessionId)
    if (!main) throw new Error('主会话已结束，请使用当前会话标识')
    const child = this.history.find(sessionId)?.children.find((item) => item.termId === termId)
    if (!child) throw new Error('此历史子 CLI 不属于当前主会话')
    if (!child.nativeSessionId) throw new Error('尚未记录原生会话标识，无法继续原对话')
    const profile = loadConfig().cliConfigs.find((item) => item.id === child.profileId && item.cli === child.cli)
    if (!profile) throw new Error('原 CLI 设置已删除或类型已变更，无法继续原对话')
    if (!getAdapter(child.cli)?.resumeArgs) throw new Error('此 CLI 不支持恢复原对话')
    const key = `${child.cli}|${child.nativeSessionId}`
    if (this.resuming.has(key)) throw new Error('此子 CLI 正在恢复，请勿重复下发')
    const live = this.manager.sessions().find((item) => item.cli === child.cli && item.nativeSessionId === child.nativeSessionId)
    if (live && (live.role !== 'child' || live.parentTermId !== sessionId ||
      (!live.done && live.runtime.phase !== 'ready') || live.runtime.approval)) {
      throw new Error('此原生会话仍在运行或等待审批，请先处理当前任务')
    }
    return { main, child, profile, key }
  }

  async resumeChild(sessionId: string, termId: string): Promise<{ termId: string }> {
    const known = this.history.find(sessionId)?.children.find((item) => item.termId === termId)
    const existing = this.manager.sessions().find((item) => item.role === 'child' && item.parentTermId === sessionId &&
      (item.id === termId || (!!known?.nativeSessionId && item.cli === known.cli && item.nativeSessionId === known.nativeSessionId)))
    if (this.manager.mainById(sessionId) && existing) return { termId: existing.id }
    const context = this.resumeContext(sessionId, termId)
    const { main, child, profile, key } = context
    const live = this.manager.sessions().find((item) => item.cli === child.cli && item.nativeSessionId === child.nativeSessionId)
    if (live) return { termId: live.id }
    this.resuming.add(key)
    try {
      const adapter = getAdapter(child.cli)!
      const bin = await getCliBin(child.cli)
      if (!this.manager.mainById(sessionId)) throw new Error('主会话已结束，取消恢复子 CLI')
      if (!bin) throw new Error(`未检测到可用的 ${adapter.label}`)
      if (this.manager.sessions().some((item) => item.cli === child.cli && item.nativeSessionId === child.nativeSessionId)) {
        throw new Error('原生子会话已在其它终端启动，取消重复恢复')
      }
      const launch = buildLaunch(adapter, bin, profile.model ?? '', profile.permissionMode, child.nativeSessionId)
      const info = await this.manager.create({
        role: 'child', cli: child.cli, profileId: profile.id, label: this.labelOf(profile),
        permissionMode: profile.permissionMode, model: profile.model,
        workDir: main.workDir, shell: main.shell, parentTermId: sessionId,
        workspaceSessionId: main.workspaceSessionId ?? main.id,
        taskKind: child.taskKind, index: child.index, nativeSessionId: launch.nativeSessionId,
        initialCommand: toShellLine(launch.args, main.shell), concealBoot: true,
        handshake: adapter.startupHandshake, delivery: adapter.delivery
      })
      this.history.recordChild(sessionId, {
        termId: info.id, cli: child.cli, profileId: profile.id, profileLabel: info.profileLabel,
        nativeSessionId: info.nativeSessionId, model: info.model, taskKind: child.taskKind,
        index: child.index, startedAt: Date.now()
      })
      return { termId: info.id }
    } finally {
      this.resuming.delete(key)
    }
  }

  /** 校验主 CLI 交付的文档，按 targets（可为任意非空子集）拉起子终端。 */
  async run(kind: TriggerKind, request: TriggerRequest): Promise<TriggerResponse> {
    const workDir = resolve(request.workDir.trim())
    const context = this.manager.taskContext(workDir, kind, request.session, request.commandId)
    if (!context) throw new Error(`未找到工作目录对应的主 CLI 会话：${workDir}`)
    if (kind === 'custom') {
      if (!request.targets?.length || request.targets.some((target) => !target.task?.trim())) {
        throw new Error('自定义命令必须提供非空 targets 和任务指令')
      }
      assignTargets(context.profiles, request.targets)
    }
    if (resolve(context.main.workDir).toLowerCase() !== workDir.toLowerCase()) {
      throw new Error('任务工作目录与指定主会话不一致，请使用该主会话的工作目录')
    }
    const resumptions = new Map<string, ReturnType<ReviewRunner['resumeContext']>>()
    const profiles = [...context.profiles]
    for (const target of request.targets ?? []) {
      if (!target.resumeTermId) continue
      if (!request.session) throw new Error('继续历史子 CLI 必须指定当前主会话 session')
      const resume = this.resumeContext(context.main.id, target.resumeTermId)
      if (resume.profile.id !== target.profileId) throw new Error('历史子 CLI 与指定的 profileId 不一致')
      resumptions.set(target.profileId, resume)
      const index = profiles.findIndex((profile) => profile.id === target.profileId)
      if (kind === 'custom' && profiles[index].cli !== resume.profile.cli) {
        throw new Error('历史子 CLI 类型与自定义命令的会话分配不一致，请重新启动主会话')
      }
      if (index < 0) profiles.push(resume.profile)
      else if (kind !== 'custom') profiles[index] = resume.profile
    }
    if (profiles.length === 0) throw new Error('当前主会话未配置此类子任务')

    const documentPath = resolveDocument(workDir, request.documentPath)
    // 全量校验在锁定和启动之前，避免错误请求留下半批任务。
    const selected = assignTargets(profiles, request.targets)
    const taskName = sanitizeSegment(
      basename(documentPath, extname(documentPath)).replace(
        /[-_ ]?(?:方案设计文档|代码开发任务|代码检查文档|自定义命令任务)(?:[-_ ]?总览)?$/u,
        ''
      )
    )

    const order: string[] = []
    const targets = new Map<string, TargetRecord>()
    selected.profiles.forEach((profile, i) => {
      const spec: ChildSpec = {
        workDir,
        kind,
        profileId: profile.id,
        index: i + 1,
        parentTermId: context.main.id,
        shell: context.main.shell,
        taskName,
        query: request.query,
        documentPath,
        ownDocs: (selected.byId.get(profile.id)?.documents ?? []).map((p) => resolveDocument(workDir, p)),
        task: selected.byId.get(profile.id)?.task,
        resumeSessionId: resumptions.get(profile.id)?.child.nativeSessionId
      }
      order.push(profile.id)
      targets.set(profile.id, {
        profileId: profile.id,
        label: this.labelOf(profile),
        index: i + 1,
        spec,
        producer: producerOf(profile),
        state: 'launching',
        launches: 1,
        startedAt: Date.now()
      })
    })

    const run = newRun({ kind, workDir, mainTermId: context.main.id, order, targets })
    trackRun(this.runs, run)
    for (const resume of resumptions.values()) this.resuming.add(resume.key)
    try {
      await Promise.all(selected.profiles.map((profile) => this.launchInto(run, targets.get(profile.id)!, profile, true)))
    } finally {
      for (const resume of resumptions.values()) this.resuming.delete(resume.key)
    }

    const snap = snapshot(run)
    return {
      count: snap.targets.filter((target) => target.termId).length,
      requested: selected.profiles.length,
      launched: snap.targets.filter((target) => target.termId).length,
      runId: run.runId,
      nextAction: snap.nextAction,
      resultFiles: snap.targets.flatMap((target) => (target.termId && target.resultFile ? [target.resultFile] : [])),
      tasks: snap.targets
    }
  }

  /** 某次 run 的即时快照；runId 不属于本次运行（含应用重启）时回 null */
  status(runId: string): RunSnapshot | null {
    const run = this.runs.get(runId)
    return run ? snapshot(run) : null
  }

  /** 无变化时按配置挂起，完成、失败或审批仍立即返回。 */
  async wait(runId: string, timeoutMs: number, signal: AbortSignal): Promise<RunSnapshot | null> {
    const run = this.runs.get(runId)
    if (!run) return null
    // 已经有待办（失败待重试 / 全部完成 / 已作废）就不占用连接，直接回当前快照
    if (run.abortedAt || nextAction(run) !== 'wait') {
      return snapshot(run, { changed: true, reason: 'immediate' })
    }
    const end: WaitEnd = await waitForChange(run, clampWait(timeoutMs), signal)
    if (end === 'aborted') return snapshot(run)
    return snapshot(run, { changed: end === 'transition', reason: end === 'transition' ? 'transition' : 'timeout' })
  }

  /** 重开当前失败且没超过重试上限的子任务；同一目标最多重试 MAX_CHILD_RETRIES 次 */
  async retry(runId: string): Promise<RetryResponse | null> {
    const run = this.runs.get(runId)
    if (!run) return null
    const retried: string[] = []
    const skipped: { profileId: string; reason: string }[] = []
    if (run.abortedAt) return { ...snapshot(run), retried, skipped }

    const plan: TargetRecord[] = []
    for (const id of run.order) {
      const target = run.targets.get(id)
      if (!target || target.state !== 'failed') continue
      // 超时判失败之后结果文件才写出来的情况：直接算完成，别白跑一遍
      if (target.resultFile && existsSync(target.resultFile)) {
        this.finishTarget(run, target)
        continue
      }
      if (!canRetry(target)) {
        const reason = target.submissionUncertain
          ? target.error ?? '任务已提交但接收未确认，请核查结果后重新发起任务'
          : `重试次数已用完（每个子任务最多 ${MAX_CHILD_RETRIES} 次）`
        skipped.push({ profileId: id, reason })
        continue
      }
      // 同步翻转，先于任何 await —— 并发的两次 /retry 不会重复消耗次数
      target.launches += 1
      target.startedAt = Date.now()
      markTarget(run, target, 'launching', { failure: undefined, error: undefined, resultFile: undefined })
      plan.push(target)
    }

    await Promise.all(
      plan.map(async (target) => {
        const profile = loadConfig().cliConfigs.find((item) => item.id === target.profileId)
        if (!profile) {
          this.failTarget(run, target, 'launch', `CLI 设置已不存在：${target.profileId}`)
          return
        }
        if (await this.launchInto(run, target, profile)) retried.push(target.profileId)
      })
    )
    return { ...snapshot(run), retried, skipped }
  }

  retryPrompt(id: string): void {
    const link = this.termIndex.get(id)
    const run = link ? this.runs.get(link.runId) : undefined
    const target = link ? run?.targets.get(link.profileId) : undefined
    if (!run || !target || run.abortedAt || target.termId !== id || target.state === 'done') return
    if (!this.manager.get(run.mainTermId) || !this.manager.retryPrompt(id)) return
    this.stopWatch(id)
    target.startedAt = Date.now()
    target.submissionUncertain = false
    markTarget(run, target, 'running', { failure: undefined, error: undefined })
    this.watchTarget(run, target)
  }

  /**
   * 关闭一个子终端，并按原参数重开一个（同工作目录、同 CLI 档案、同一条任务指令）。
   * 结果文件换新的时间戳：上一轮的结果留在历史与输出抽屉里不被覆盖，
   * 新一轮也不会因为老结果文件还在就被立刻判成「已完成」。
   * 旧进程坏死后（卡在弹窗、没进输入框）占着会话与锁不放，必须先杀再拉，
   * 否则新进程会跟着一起卡死；拉不起来就按 launch 失败记进台账。
   * 人工重开不拒绝，但一样计入重试次数，保证 /status 里的 retries 是真实值。
   */
  async restart(id: string): Promise<void> {
    const link = this.termIndex.get(id)
    if (!link) {
      const info = this.manager.get(id)
      const parentId = info?.parentTermId
      const child = parentId ? this.history.find(parentId)?.children.find((item) => item.termId === id) : undefined
      if (!parentId || !child?.nativeSessionId || !this.manager.mainById(parentId)) {
        throw new Error('此子终端没有可恢复的原生会话，无法重开')
      }
      if (!loadConfig().cliConfigs.some((profile) => profile.id === child.profileId && profile.cli === child.cli)) {
        throw new Error('原 CLI 设置已删除或类型已变更，无法重开')
      }
      this.manager.kill(id)
      await this.resumeChild(parentId, id)
      return
    }
    const run = this.runs.get(link.runId)
    const target = run?.targets.get(link.profileId)
    if (!run || !target) throw new Error('这个终端所属的子任务已经不在台账里，无法重开')
    if (run.abortedAt || !this.manager.get(run.mainTermId)) throw new Error('主会话已结束，无法重开子任务')
    const profile = loadConfig().cliConfigs.find((item) => item.id === target.profileId)
    if (!profile) throw new Error(`CLI 设置已不存在：${target.profileId}`)
    target.launches += 1
    target.startedAt = Date.now()
    markTarget(run, target, 'launching', { failure: undefined, error: undefined, resultFile: undefined })
    await this.launchInto(run, target, profile)
  }

  /**
   * 拉一个子终端进台账：先把上一轮那个杀掉（坏死的进程会连累新进程一起卡住），
   * 成功则登记 termIndex、起结果文件监听；失败只写进台账（failure=launch），
   * 不抛给调用方 —— 一个目标拉不起来不该影响整批。
   */
  private async launchInto(run: RunRecord, target: TargetRecord, profile: CliConfig, resumeReserved = false): Promise<boolean> {
    if (run.abortedAt || !this.manager.get(run.mainTermId)) return false
    const key = target.spec.resumeSessionId ? `${profile.cli}|${target.spec.resumeSessionId}` : undefined
    if (key && !resumeReserved && this.resuming.has(key)) {
      this.failTarget(run, target, 'launch', '此子 CLI 正在恢复，请勿重复下发')
      return false
    }
    if (key && !resumeReserved) this.resuming.add(key)
    target.submissionUncertain = false
    target.approvalSince = undefined
    target.approvalWaitMs = 0
    const previous = target.termId
    if (previous) {
      this.termIndex.delete(previous)
      this.stopWatch(previous)
      target.termId = undefined
      this.manager.kill(previous)
    }
    try {
      const { info, resultFile } = await this.launchChild(target.spec, profile)
      if (run.abortedAt || !this.manager.get(run.mainTermId)) {
        this.manager.kill(info.id)
        return false
      }
      target.termId = info.id
      target.resultFile = resultFile
      target.producer = producerOf(profile)
      this.termIndex.set(info.id, { runId: run.runId, profileId: target.profileId })
      markTarget(run, target, 'running', { failure: undefined, error: undefined })
      this.watchTarget(run, target)
      return true
    } catch (error) {
      this.failTarget(run, target, 'launch', error instanceof Error ? error.message : String(error))
      return false
    } finally {
      if (key && !resumeReserved) this.resuming.delete(key)
    }
  }

  /** 拉起一个子终端；首拉与重试共用这一条路径 */
  private async launchChild(
    spec: ChildSpec,
    profile: CliConfig
  ): Promise<{ info: TerminalInfo; resultFile: string }> {
    const adapter = getAdapter(profile.cli)
    if (!adapter) throw new Error('未注册 CLI 适配器')
    const bin = await getCliBin(profile.cli)
    if (!this.manager.get(spec.parentTermId)) throw new Error('主会话已结束，取消启动子任务')
    if (!bin) throw new Error(`未检测到可用的 ${adapter.label}`)
    if (spec.resumeSessionId) {
      const live = this.manager.sessions().find((item) => item.cli === profile.cli && item.nativeSessionId === spec.resumeSessionId)
      if (live) {
        if (live.role !== 'child' || live.parentTermId !== spec.parentTermId ||
          (!live.done && live.runtime.phase !== 'ready') || live.runtime.approval) {
          throw new Error('原生子会话仍在运行，取消重复启动')
        }
        this.manager.kill(live.id)
      }
    }
    const label = this.labelOf(profile)
    const resultFile = this.resultPath(spec, label)
    const prompt = childPrompt(
      spec.kind,
      spec.query,
      spec.documentPath,
      spec.ownDocs,
      spec.task,
      resultFile
    )
    // 层1 投递：正文写进工作目录内的临时文件，命令行只带引导语和相对路径
    const main = this.manager.mainById(spec.parentTermId)!
    const workspaceSessionId = main.workspaceSessionId ?? main.id
    const promptFile = adapter.delivery?.initialPromptArgs ? writePromptFile(spec.workDir, prompt, workspaceSessionId) : undefined
    const launch = buildLaunch(
      adapter,
      bin,
      profile.model ?? '',
      profile.permissionMode,
      spec.resumeSessionId,
      undefined,
      promptFile ? { file: promptFile.rel, lead: PROMPT_LEAD } : undefined
    )
    let info
    try {
      info = await this.manager.create({
        role: 'child',
        profileId: profile.id,
        permissionMode: profile.permissionMode,
        label,
        taskKind: spec.kind,
        index: spec.index,
        cli: profile.cli,
        model: profile.model,
        workDir: spec.workDir,
        shell: spec.shell,
        initialCommand: toShellLine(launch.args, spec.shell),
        concealBoot: true,
        nativeSessionId: launch.nativeSessionId,
        parentTermId: spec.parentTermId,
        workspaceSessionId,
        autoPrompt: prompt,
        handshake: adapter.startupHandshake,
        delivery: adapter.delivery,
        promptFile: promptFile?.abs
      })
    } catch (error) {
      // 子终端没拉起来时临时文件不能留在用户仓库里
      removePromptFile(promptFile?.abs)
      throw error
    }
    this.history.recordChild(spec.parentTermId, {
      termId: info.id,
      nativeSessionId: info.nativeSessionId,
      profileId: profile.id,
      profileLabel: info.profileLabel,
      // 子终端就是用这个档案的 CLI 起的，info.cli 在类型上还可能是纯 shell
      cli: profile.cli,
      model: info.model,
      taskKind: spec.kind,
      index: spec.index,
      resultFile,
      startedAt: Date.now()
    })
    return { info, resultFile }
  }

  /** 本次任务的结果文件路径：任务名 + 类型 + 时间戳 + 档案名 + 序号 */
  private resultPath(spec: ChildSpec, label: string): string {
    const main = this.manager.mainById(spec.parentTermId)
    if (!main) throw new Error('主会话已结束')
    const resultsDir = join(ensureSessionWorkspace(spec.workDir, main.workspaceSessionId ?? main.id), 'results')
    mkdirSync(resultsDir, { recursive: true })
    const resultLabel = { design: '方案校验', write: '代码编写', review: '代码检查', custom: '自定义命令' }[spec.kind]
    return join(
      resultsDir,
      `${spec.taskName}-${resultLabel}-${timestamp()}-${sanitizeSegment(label)}-${spec.index}.md`
    )
  }

  private labelOf(profile: CliConfig): string {
    const adapter = getAdapter(profile.cli)
    return adapter
      ? profileLabel(profile, adapter.label, permissionLabelOf(adapter.permissionOptions, profile.permissionMode))
      : profile.cli
  }

  private timeoutMs(): number {
    return loadConfig().review.childTimeoutMinutes * 60_000
  }

  /**
   * 监听结果文件与子终端本身：出结果、进程提前退出、任务没投递进输入框、超过设定时间没结果，
   * 四种结局都要落成台账里的终态，主 CLI 才能靠 /wait 被唤醒并决定重试还是放弃。
   */
  private watchTarget(run: RunRecord, target: TargetRecord): void {
    const termId = target.termId
    const resultFile = target.resultFile
    if (!termId || !resultFile) return
    mkdirSync(join(resultFile, '..'), { recursive: true })
    const timer = setInterval(() => {
      if (run.abortedAt) {
        this.stopWatch(termId)
        return
      }
      if (existsSync(resultFile)) {
        this.finishTarget(run, target)
        return
      }
      if (!this.manager.get(termId)) {
        // 终端提前退出不等于任务完成；recordExit 已负责写 endedAt，这里只标失败。
        this.failTarget(run, target, 'exit', '子 CLI 已经退出，但没写出结果文件')
        return
      }
      const runtime = this.manager.runtimeOf(termId)
      target.submissionUncertain = !!runtime?.submissionUncertain
      if (runtime?.approval) {
        target.approvalSince ??= Date.now()
        if (target.approval?.id !== runtime.approval.id) {
          target.approval = runtime.approval
          markTarget(run, target, 'waiting-approval')
          this.nudgeMain(run)
        }
        return
      }
      if (target.state === 'waiting-approval') {
        target.approvalWaitMs = (target.approvalWaitMs ?? 0) + Date.now() - (target.approvalSince ?? Date.now())
        target.approvalSince = undefined
        markTarget(run, target, 'running')
      }
      if (runtime?.phase === 'error') {
        this.failTarget(run, target, 'delivery', runtime.message ?? '任务没能投递进 CLI 输入框')
        return
      }
      const elapsed = Date.now() - target.startedAt - (target.approvalWaitMs ?? 0)
      if (elapsed > this.timeoutMs()) {
        this.failTarget(
          run,
          target,
          'timeout',
          `拉起后 ${Math.round(elapsed / 60_000)} 分钟仍没有写出结果文件（超时上限 ${loadConfig().review.childTimeoutMinutes} 分钟）`
        )
      }
    }, 2000)
    this.watching.set(termId, timer)
  }

  private stopWatch(termId?: string): void {
    if (!termId) return
    const timer = this.watching.get(termId)
    if (timer) clearInterval(timer)
    this.watching.delete(termId)
  }

  private finishTarget(run: RunRecord, target: TargetRecord): void {
    const termId = target.termId
    const resultFile = target.resultFile
    if (!termId || !resultFile) return
    this.stopWatch(termId)
    this.manager.markDone(termId, resultFile)
    this.history.recordDone(termId, resultFile)
    markTarget(run, target, 'done', { resultFile, failure: undefined, error: undefined })
    if (target.spec.parentTermId) {
      // 产物名统一成「任务名 结果类型+序号」：结果文件名带时间戳与 CLI 名，不适合直接展示
      const label = `${target.spec.taskName} ${OUTPUT_RESULT_NAME[target.spec.kind]}${target.index}`
      try {
        this.outputs?.publishReviewer(target.spec.parentTermId, {
          title: label,
          file: resultFile,
          label,
          producer: target.producer
        })
      } catch (error) {
        // 输出抽屉失败不能影响任务完成事实；保留 resultFile，供终端与历史页继续访问。
        console.error('发布 reviewer 输出失败', error)
      }
    }
    this.nudgeMain(run)
  }

  private failTarget(run: RunRecord, target: TargetRecord, failure: ChildFailure, error: string): void {
    this.stopWatch(target.termId)
    const recovery = failure === 'exit' ? '请核查结果后重新发起任务' : '请核查终端与结果后手动重开'
    const message = target.submissionUncertain
      ? `${error}；任务已提交但接收未确认，已停止自动重试，${recovery}`
      : error
    markTarget(run, target, 'failed', { failure, error: message })
    this.nudgeMain(run)
  }

  /**
   * 子任务有变化时把主 CLI 叫起来看：/wait 在挂起时不需要打扰（它本来就会被唤醒），
   * 只有主 CLI 已经离开循环、终端也安静下来时，才补一条极短的提醒。
   * 提醒失败（终端正忙、回显没确认）什么都不做 —— 它下次自己 /status 也能看到。
   */
  private nudgeMain(run: RunRecord): void {
    if (run.abortedAt) return
    const now = Date.now()
    if (now - (this.nudgedAt.get(run.runId) ?? 0) < NUDGE_COOLDOWN_MS) return
    if (this.mainIsWaiting(run.mainTermId)) return
    const snap = snapshot(run)
    const done = snap.targets.filter((target) => target.state === 'done').length
    const failed = snap.targets.filter((target) => target.state === 'failed').length
    const text =
      `[clichilds] 本次子任务有更新（完成 ${done} / 失败 ${failed}）。` +
      `请执行 curl.exe -sS http://127.0.0.1:${bridgePort()}/status/${run.runId} 查看状态，` +
      `并按返回的 nextAction 继续处理；全部完成或无法继续时才结束本轮回复。`
    if (this.manager.nudge(run.mainTermId, text)) this.nudgedAt.set(run.runId, now)
  }

  private mainIsWaiting(mainTermId: string): boolean {
    for (const run of this.runs.values()) {
      if (run.mainTermId === mainTermId && hasWaiter(run)) return true
    }
    return false
  }
}

/** 主 CLI 交付的文档一律要落在工作目录内，且是真实存在的 Markdown 文件。 */
function resolveDocument(workDir: string, given: string): string {
  const path = resolve(isAbsolute(given) ? given : join(workDir, given))
  const rel = relative(workDir, path)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`任务文档必须位于当前工作目录内：${path}`)
  }
  if (extname(path).toLowerCase() !== '.md' || !existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`任务文档不存在或不是 Markdown 文件：${path}`)
  }
  return path
}

/**
 * targets 可以是快照里的任意非空子集（只拉起一个 CLI 也允许），但每个 profileId 必须原样来自快照。
 * 不填 targets = 按快照全员拉起（旧行为）。
 */
function assignTargets(
  profiles: CliConfig[],
  targets?: TriggerTarget[]
): { profiles: CliConfig[]; byId: Map<string, TriggerTarget> } {
  const byId = new Map<string, TriggerTarget>()
  if (!targets || targets.length === 0) return { profiles, byId }
  for (const target of targets) {
    if (!profiles.some((profile) => profile.id === target.profileId)) {
      throw new Error(
        `targets 里的 profileId 不属于本次任务：${target.profileId}；可用的是 ${profiles
          .map(profileName)
          .join('、')}`
      )
    }
    if (byId.has(target.profileId)) {
      throw new Error(`targets 里重复指定了同一个 CLI：${profileName(profiles.find((p) => p.id === target.profileId)!)}`)
    }
    byId.set(target.profileId, target)
  }
  return { profiles: profiles.filter((profile) => byId.has(profile.id)), byId }
}

function profileName(profile: CliConfig): string {
  const adapter = getAdapter(profile.cli)
  const label = adapter
    ? profileLabel(profile, adapter.label, permissionLabelOf(adapter.permissionOptions, profile.permissionMode))
    : profile.cli
  return `${label}(profileId=${profile.id})`
}

function clampWait(timeoutMs: number): number {
  const value = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs : loadConfig().review.pollIntervalMinutes * 60_000
  return Math.min(POLL_INTERVAL_MAX_MINUTES * 60_000, Math.max(POLL_INTERVAL_MIN_MINUTES * 60_000, Math.round(value)))
}

function timestamp(now = new Date()): string {
  const part = (n: number, width = 2): string => String(n).padStart(width, '0')
  return (
    `${now.getFullYear()}${part(now.getMonth() + 1)}${part(now.getDate())}-` +
    `${part(now.getHours())}${part(now.getMinutes())}${part(now.getSeconds())}-${part(now.getMilliseconds(), 3)}`
  )
}

function sanitizeSegment(value: string): string {
  const clean = value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[. -]+|[. -]+$/g, '')
  return (clean || '未命名任务').slice(0, 80)
}

/** 输出列表里的产物名：「任务名 + 结果类型 + 序号」；结果文件名带时间戳与 CLI 名，不直接展示 */
const OUTPUT_RESULT_NAME: Record<TriggerKind, string> = {
  design: '校验结果',
  write: '开发结果',
  review: '检查结果',
  custom: '执行结果'
}

/** 产物第二行「CLI名 - 模型名」：CLI 名取适配器显示名，模型留空由渲染层显示「默认」 */
function producerOf(profile: CliConfig): OutputProducer {
  const adapter = getAdapter(profile.cli)
  return { cliLabel: adapter?.label ?? profile.cli, model: profile.model?.trim() || undefined }
}

const DEFAULT_FOCUS: Record<TriggerKind, string> = {
  design: '结合当前代码库，检查方案的可行性、完整性、边界情况、风险与验证方法。',
  write: '按照任务文档直接修改当前工作区代码，完成必要测试与验证；不要只给建议或方案。',
  review: '结合文档与当前代码改动，检查正确性、遗漏、回归、安全性和测试覆盖。',
  custom: '按照交付文档与任务指令完成工作，不超出授权范围，并说明结果与验证依据。'
}

/** 越界禁令必须留在主进程：子 CLI 看不到 SKILL.md，可信输入只有这段和喂给它的文档。 */
const SCOPE_LOCK =
  '只允许改动任务指令与专属文档中列为「范围内」的文件；凡被标为「范围外」或「禁止改动」的文件与目录（含测试、配置、锁文件）一律不得新建、修改或删除，任何越界改动都视为本次任务失败。不要读取或执行本会话 requests 下其它 CLI 的开发文档，也不要扫描其它会话目录。'

function childPrompt(
  kind: TriggerKind,
  query: string,
  documentPath: string,
  ownDocs: string[],
  task: string | undefined,
  resultFile: string
): string {
  const role = {
    design: '独立校验实现方案',
    write: '负责完成代码开发',
    review: '独立检查代码实现',
    custom: '执行自定义命令交付的任务'
  }[kind]
  const docs = [`总览文档（只读参考）：${documentPath}`, ...ownDocs.map((p) => `本终端专属文档：${p}`)]
  const fallback = [query.trim() ? `用户原始指令：${query.trim()}` : '', DEFAULT_FOCUS[kind]].join('\n\n')
  return [
    `你是 clichilds 拉起的子 CLI，当前任务是${role}。`,
    `必须先完整读取主 CLI 交付的 Markdown 文档：\n${docs.join('\n')}`,
    // 主 CLI 逐终端写好 task 时不再塞完整用户指令：那是全部模块范围的并集，正是越界的来源。
    task?.trim() || fallback,
    kind === 'write' || kind === 'custom' ? SCOPE_LOCK : '',
    kind === 'custom'
      ? '按照任务授权决定执行或只读分析，不擅自扩大范围。完成后在结果中说明完成内容、验证依据、未完成项与剩余风险。'
      : kind === 'write'
        ? '必须实际完成实现，不要只给建议或方案。完成后在结果中列出改动文件、实现摘要、验证命令与结果、剩余风险。'
        : '只做审查，不修改业务代码。结果应给出明确问题、证据、严重程度和可执行建议；没有问题也要写明检查范围和结论。',
    `完成后必须用文件写入工具将完整 Markdown 结果写入下面的精确路径，不得改名：${resultFile}。写入后立即停止，不要等待主 CLI 继续指示。`
  ]
    .filter(Boolean)
    .join('\n\n')
}
