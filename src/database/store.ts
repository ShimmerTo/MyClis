import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { DbConfigAction, DbSnapshot } from '@shared/database'

interface State { snapshot: DbSnapshot | null; error: string; detailId?: string }
let state: State = { snapshot: null, error: '' }
let off: (() => void) | undefined
let pending: Promise<void> | undefined
const listeners = new Set<() => void>()
const publish = (patch: Partial<State>) => { state = { ...state, ...patch }; listeners.forEach(fn => fn()) }
const adopt = (snapshot: DbSnapshot) => { if (!state.snapshot || snapshot.seq >= state.snapshot.seq) publish({ snapshot, error: '' }) }
export const dbError = (error: unknown): string => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : 'Database 操作失败'
export function refreshDatabase(): Promise<void> {
  if (!pending) pending = window.clichilds.database.getSnapshot().then(adopt).catch(error => publish({ error: dbError(error) })).finally(() => { pending = undefined })
  return pending
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (!off) { off = window.clichilds.database.onChanged(adopt); void refreshDatabase() }
  return () => { listeners.delete(listener); if (!listeners.size) { off?.(); off = undefined } }
}
export function useDatabase(): State { return useSyncExternalStore(subscribe, () => state) }
export function showDatabaseRequest(id?: string): void { publish({ detailId: id }) }
export async function saveDatabase(action: DbConfigAction, expectedRevision: number): Promise<void> {
  adopt(await window.clichilds.database.updateConfig({ action, expectedRevision }))
}
export function useDatabaseAction() {
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const locked = useRef(false), mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const run = async (operation: () => Promise<void>): Promise<boolean> => {
    if (locked.current) return false
    locked.current = true; setBusy(true); setError('')
    try { await operation(); return true }
    catch (cause) { if (mounted.current) setError(dbError(cause)); else publish({ error: dbError(cause) }); await refreshDatabase(); return false }
    finally { locked.current = false; if (mounted.current) setBusy(false) }
  }
  return { busy, error, run }
}
export const requestKey = (request: { sessionId: string; requestId: string }): string => JSON.stringify([request.sessionId, request.requestId])
export const stateLabels = { checking: '检查中', pending_approval: '待批准', executing: '执行中', succeeded: '已完成', failed: '失败', unknown: '结果待核验', rejected: '已拒绝', expired: '已过期', cancelled: '已取消' }
