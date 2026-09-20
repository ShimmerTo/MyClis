import { statSync } from 'fs'
import type { DiscoveredSession, DiscoverReq } from '../../shared/types'
import { adapters } from '../cli/registry'
import type { CliAdapter } from '../cli/types'
import { initialQueryOf, readHeadLines, safeIsDir, sessionIdOfFile, walkSessionFiles } from './sessionFiles'

/** 每个 CLI 最多回填多少条（按 mtime 倒序截断） */
const PER_CLI = 60
const TTL = 20_000

interface Cached {
  at: number
  rootMtime: number
  sessions: Omit<DiscoveredSession, 'mine' | 'dirMissing'>[]
}

const cache = new Map<string, Cached>()

function scan(adapter: CliAdapter): Omit<DiscoveredSession, 'mine' | 'dirMissing'>[] {
  const { files, missing } = walkSessionFiles(adapter)
  if (missing) return []
  const picked = files
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, PER_CLI)
    .map((f) => {
      const id = sessionIdOfFile(adapter, f.file)
      if (!id) return undefined
      // 读不到 cwd 就没法判断目录、也没法恢复，直接不收
      const headLines = readHeadLines(f.file)
      const head = adapter.readSessionHead?.(headLines)
      if (!head?.cwd) return undefined
      const initialQuery = initialQueryOf(adapter, headLines)
      return {
        nativeSessionId: id,
        cli: adapter.id,
        cwd: head.cwd,
        startedAt: head.startedAt ?? f.mtime,
        bytes: f.bytes,
        title: head.title,
        initialQuery: initialQuery?.slice(0, 2000),
        file: f.file
      }
    })
  return picked.filter((s): s is NonNullable<typeof s> => !!s)
}

function cachedScan(adapter: CliAdapter): Cached['sessions'] {
  const now = Date.now()
  const root = adapter.sessionRoot()
  let rootMtime = 0
  try {
    rootMtime = statSync(root).mtimeMs
  } catch {
    return []
  }
  const hit = cache.get(adapter.id)
  if (hit && hit.rootMtime === rootMtime && now - hit.at < TTL) return hit.sessions
  const sessions = scan(adapter)
  if (sessions.length > 0) cache.set(adapter.id, { at: now, rootMtime, sessions })
  return sessions
}

/**
 * 回填各 CLI 自己记下的会话（不只本应用启动的）。
 * 一律整表返回，「本应用 / 全部 / 仅当前目录」由渲染层自己筛——切换筛选不该重扫磁盘。
 * 只在右侧栏可见或点刷新时调用，别塞进 1s 的会话推送循环里。
 */
export function discoverSessions(req: DiscoverReq, mine: Set<string>): DiscoveredSession[] {
  const list: DiscoveredSession[] = []
  for (const adapter of adapters) {
    if (req.cli && adapter.id !== req.cli) continue
    for (const s of cachedScan(adapter)) {
      list.push({ ...s, mine: mine.has(`${s.cli}|${s.nativeSessionId}`), dirMissing: !safeIsDir(s.cwd) })
    }
  }
  list.sort((a, b) => {
    if (a.mine !== b.mine) return a.mine ? -1 : 1
    return b.startedAt - a.startedAt
  })
  return list.slice(0, req.limit ?? 240)
}
