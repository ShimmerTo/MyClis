import type { HistoryChild } from './types'

export function latestHistoryChildren(children: HistoryChild[]): HistoryChild[] {
  const latest = new Map<string, HistoryChild>()
  for (const child of children) {
    const key = child.nativeSessionId ? `${child.cli}|${child.nativeSessionId}` : child.termId
    latest.set(key, child)
  }
  return [...latest.values()]
}
