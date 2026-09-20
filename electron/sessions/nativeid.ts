import { resolve } from 'path'
import type { CliId } from '../../shared/types'
import { getAdapter } from '../cli/registry'
import { readHeadLines, sessionIdOfFile, walkSessionFiles } from './sessionFiles'

const TICK = 2000
const DEADLINE = 90_000
/** 允许 CLI 的时钟/落盘比我们的 startedAt 略早一点 */
const SLACK = 2000

/** 已被认领的 transcript 路径，永久排除 */
const claimed = new Set<string>()
/** 同一 workDir 的观测串成一条队列：并行扫「最新文件」归不准是谁的 */
const queues = new Map<string, Promise<void>>()
/** 队列里有人等超时了：后面的次序不再可信，整条队列放弃认领 */
const givenUp = new Set<string>()

export interface NativeIdWatch {
  stop(): void
}

/**
 * 观测「哪个 CLI 自己新建了一条会话」，用于 codex 这种没有预分配 session id 的 CLI。
 * 只认 cwd 与 mtime 都对得上的最早一份，拿不到就留空，绝不猜。
 */
export function watchNativeSession(o: {
  cli: CliId
  workDir: string
  startedAt: number
  onFound: (nativeSessionId: string) => void
}): NativeIdWatch {
  const adapter = getAdapter(o.cli)
  let cancelled = false
  const watch: NativeIdWatch = {
    stop: () => {
      cancelled = true
    }
  }
  if (!adapter?.readSessionHead || adapter.sessionIdArgs) return watch
  const key = resolve(o.workDir).toLowerCase()
  const previous = queues.get(key) ?? Promise.resolve()
  const task = async (): Promise<void> => {
    if (cancelled || givenUp.has(key)) return
    const result = await poll(adapter, o.workDir, o.startedAt, () => cancelled)
    if (result === 'cancelled') return
    if (result === 'timeout') {
      givenUp.add(key)
      return
    }
    o.onFound(result)
  }
  const tail = previous.then(task, task)
  queues.set(key, tail)
  void tail.then(() => {
    if (queues.get(key) === tail) {
      queues.delete(key)
      givenUp.delete(key)
    }
  })
  return watch
}

type Poll = string | 'timeout' | 'cancelled'

async function poll(
  adapter: NonNullable<ReturnType<typeof getAdapter>>,
  workDir: string,
  startedAt: number,
  isCancelled: () => boolean
): Promise<Poll> {
  const deadline = startedAt + DEADLINE
  while (!isCancelled()) {
    const hit = scanOnce(adapter, workDir, startedAt)
    if (hit) return hit
    if (Date.now() >= deadline) break
    await new Promise((r) => setTimeout(r, TICK))
  }
  return isCancelled() ? 'cancelled' : 'timeout'
}

function scanOnce(
  adapter: NonNullable<ReturnType<typeof getAdapter>>,
  workDir: string,
  startedAt: number
): string | undefined {
  const root = adapter.sessionRoot()
  const want = resolve(workDir).toLowerCase()
  const candidates = walkSessionFiles(adapter, startedAt - SLACK)
    .files.filter((f) => !claimed.has(f.file))
    .sort((a, b) => a.mtime - b.mtime)
  for (const candidate of candidates) {
    // 文件可能还在写，头部读不到 cwd 就本轮先跳过，下一轮再看
    const head = adapter.readSessionHead?.(readHeadLines(candidate.file))
    if (!head?.cwd) continue
    if (resolve(head.cwd).toLowerCase() !== want) continue
    if (!head.startedAt || head.startedAt < startedAt - SLACK) continue
    const id = sessionIdOfFile(adapter, candidate.file)
    if (!id) continue
    claimed.add(candidate.file)
    return id
  }
  return undefined
}
