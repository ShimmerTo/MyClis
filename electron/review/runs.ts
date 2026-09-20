import { randomUUID } from 'crypto'
import { MAX_CHILD_RETRIES } from '../../shared/types'
import type {
  ChildFailure,
  ChildState,
  ChildTargetStatus,
  RunNextAction,
  RunSnapshot,
  RunState,
  TerminalInfo,
  TriggerKind
} from '../../shared/types'

/**
 * 一个子终端的完整任务规格：首拉时记下来，重试/重开时用它把同一个任务原样再跑一遍。
 * 不存 profile 本身（重开要读最新的档案配置）与结果路径（每次都换新时间戳）。
 */
export interface ChildSpec {
  workDir: string
  kind: TriggerKind
  profileId: string
  index: number
  parentTermId: string
  shell: TerminalInfo['shell']
  /** 结果文件名里的任务片段（取自总览文档名） */
  taskName: string
  query: string
  documentPath: string
  ownDocs: string[]
  task?: string
}

/** 一个子任务在一次 run 里的全部事实；终端退出后仍然保留，重试靠它 */
export interface TargetRecord {
  profileId: string
  label: string
  index: number
  spec: ChildSpec
  state: ChildState
  /** 该目标的终端创建次数：1 = 首次，上限 MAX_CHILD_RETRIES + 1 */
  launches: number
  termId?: string
  resultFile?: string
  failure?: ChildFailure
  error?: string
  submissionUncertain?: boolean
  /** 当前这次拉起的时刻（超时起算点） */
  startedAt: number
  finishedAt?: number
}

/** /wait 的挂起者：有 notable 转变时被唤醒 */
interface Waiter {
  notify: () => void
}

export type WaitEnd = 'transition' | 'timeout' | 'aborted'

/** 一次 /trigger 下发的 run 台账 */
export interface RunRecord {
  runId: string
  kind: TriggerKind
  workDir: string
  mainTermId: string
  createdAt: number
  updatedAt: number
  /** 非空 = 已随主会话结束作废 */
  abortedAt?: number
  /** profileId 顺序，快照稳定 */
  order: string[]
  targets: Map<string, TargetRecord>
  waiters: Set<Waiter>
}

/** 台账上限与保留时长：只清非 active 的旧 run，active 的永远保留 */
const MAX_RUNS = 32
const RUN_TTL_MS = 24 * 60 * 60 * 1000

export function newRun(input: {
  kind: TriggerKind
  workDir: string
  mainTermId: string
  order: string[]
  targets: Map<string, TargetRecord>
}): RunRecord {
  const now = Date.now()
  return { ...input, runId: randomUUID(), createdAt: now, updatedAt: now, waiters: new Set() }
}

export function runState(run: RunRecord): RunState {
  if (run.abortedAt) return 'aborted'
  for (const target of run.targets.values()) {
    if (target.state === 'launching' || target.state === 'running') return 'active'
  }
  return 'finished'
}

export function canRetry(target: TargetRecord): boolean {
  return target.state === 'failed' && !target.submissionUncertain && target.launches <= MAX_CHILD_RETRIES
}

/**
 * 主 CLI 下一步该做什么。retry 排在 wait 前面：已经确定失败的目标要立刻处理，
 * 其余还在跑的继续等，不必先耗到全部结束。
 */
export function nextAction(run: RunRecord): RunNextAction {
  const targets = [...run.targets.values()]
  if (run.abortedAt) return 'stop'
  if (targets.every((target) => target.state === 'done')) return 'analyze'
  if (targets.some((target) => canRetry(target))) return 'retry'
  if (targets.some((target) => target.state === 'launching' || target.state === 'running')) return 'wait'
  return 'report-failure'
}

export function targetStatus(target: TargetRecord, now = Date.now()): ChildTargetStatus {
  return {
    profileId: target.profileId,
    label: target.label,
    index: target.index,
    state: target.state,
    retries: Math.max(0, target.launches - 1),
    canRetry: canRetry(target),
    termId: target.termId,
    resultFile: target.resultFile,
    failure: target.failure,
    error: target.error,
    elapsedMs: Math.max(0, (target.finishedAt ?? now) - target.startedAt)
  }
}

export function snapshot(run: RunRecord, extra: Pick<RunSnapshot, 'changed' | 'reason'> = {}): RunSnapshot {
  return {
    runId: run.runId,
    runState: runState(run),
    nextAction: nextAction(run),
    updatedAt: run.updatedAt,
    targets: run.order.flatMap((id) => {
      const target = run.targets.get(id)
      return target ? [targetStatus(target)] : []
    }),
    ...extra
  }
}

/** 记下一个子任务的状态转变；只有 done/failed 与作废才唤醒 /wait 的挂起者 */
export function markTarget(
  run: RunRecord,
  target: TargetRecord,
  state: ChildState,
  patch: Partial<Pick<TargetRecord, 'failure' | 'error' | 'resultFile'>> = {}
): void {
  target.state = state
  // 用 in 判断：显式传 undefined 表示「清掉上一轮失败留下的痕迹」，与「没传」要区分开
  if ('failure' in patch) target.failure = patch.failure
  if ('error' in patch) target.error = patch.error
  if ('resultFile' in patch) target.resultFile = patch.resultFile
  // 重开时 startedAt 已经是新的，finishedAt 必须跟着清掉，否则 elapsedMs 会算成负数被夹到 0
  if (state === 'done' || state === 'failed') target.finishedAt = Date.now()
  else target.finishedAt = undefined
  run.updatedAt = Date.now()
  if (state === 'done' || state === 'failed') settleWaiters(run)
}

export function abortRun(run: RunRecord): void {
  if (run.abortedAt) return
  run.abortedAt = Date.now()
  run.updatedAt = run.abortedAt
  settleWaiters(run)
}

export function settleWaiters(run: RunRecord): void {
  for (const waiter of [...run.waiters]) waiter.notify()
}

/**
 * 挂起直到有 notable 转变、超时，或 HTTP 连接断开。
 * 挂起者自带超时，所以不需要额外的数量上限。
 */
export function waitForChange(run: RunRecord, timeoutMs: number, signal: AbortSignal): Promise<WaitEnd> {
  if (signal.aborted) return Promise.resolve('aborted')
  return new Promise((resolve) => {
    let settled = false
    const finish = (end: WaitEnd): void => {
      if (settled) return
      settled = true
      run.waiters.delete(waiter)
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve(end)
    }
    const timer = setTimeout(() => finish('timeout'), timeoutMs)
    const onAbort = (): void => finish('aborted')
    const waiter: Waiter = { notify: () => finish('transition') }
    signal.addEventListener('abort', onAbort)
    run.waiters.add(waiter)
  })
}

/** 每个 run 是否还有 /wait 挂起：有挂起说明主 CLI 正在循环里，不用再提醒它 */
export function hasWaiter(run: RunRecord): boolean {
  return run.waiters.size > 0
}

/** 挂到台账上并清掉过期/超量的旧 run（不碰 active 的） */
export function trackRun(runs: Map<string, RunRecord>, run: RunRecord): void {
  runs.set(run.runId, run)
  const now = Date.now()
  for (const [id, item] of runs) {
    if (id === run.runId) continue
    if (item.abortedAt) continue
    const stale = runState(item) !== 'active' && now - item.updatedAt > RUN_TTL_MS
    if (stale) runs.delete(id)
  }
  while (runs.size > MAX_RUNS) {
    const victim = [...runs.values()]
      .filter((item) => item.runId !== run.runId && runState(item) !== 'active')
      .sort((a, b) => a.updatedAt - b.updatedAt)[0]
    if (!victim) break
    runs.delete(victim.runId)
  }
}
