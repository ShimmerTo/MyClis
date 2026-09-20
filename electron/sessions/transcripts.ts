import type { ChatEntry, TranscriptPage, TranscriptReq } from '../../shared/types'
import { getAdapter } from '../cli/registry'
import { locateSessionFile, readChunk, safeIsDir } from './sessionFiles'

/** 只读尾部：codex 的 rollout 有几十 MB，整读会卡住主进程 */
const TAIL = 1_500_000
const MAX_ENTRIES = 300
const MAX_CHARS = 8000
/** 单行超过这个大小的一定是工具输出之类的巨型载荷，直接跳过 */
const MAX_LINE = 200_000

/** 读某条原生会话的对话正文（主 CLI 与子 CLI 走同一条路） */
export function readTranscript(req: TranscriptReq): TranscriptPage {
  const adapter = getAdapter(req.cli)
  if (!adapter) return { entries: [], truncated: false, totalBytes: 0, reason: 'dir-missing' }
  if (!safeIsDir(adapter.sessionRoot())) {
    return { entries: [], truncated: false, totalBytes: 0, reason: 'dir-missing' }
  }
  const found = locateSessionFile(adapter, req.nativeSessionId)
  if (!found) {
    return { entries: [], truncated: false, totalBytes: 0, reason: 'file-missing', file: adapter.sessionRoot() }
  }
  const offset = Math.max(0, found.bytes - TAIL)
  const chunk = readChunk(found.file, offset, TAIL)
  const entries: ChatEntry[] = []
  for (const line of chunk.lines) {
    if (line.length > MAX_LINE || line.length < 2) continue
    let parsed: Record<string, unknown> | undefined
    try {
      parsed = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    if (!parsed) continue
    adapter.parseTranscript?.(parsed, entries)
  }
  const kept = entries.slice(-MAX_ENTRIES)
  return {
    entries: kept.map((entry) => ({
      ...entry,
      text: entry.text.length > MAX_CHARS ? `${entry.text.slice(0, MAX_CHARS)}…` : entry.text
    })),
    truncated: offset > 0 || entries.length > kept.length,
    totalBytes: found.bytes,
    file: found.file
  }
}
