import { TERMINALS } from '@shared/types'
import type { TerminalKind, TerminalPhase } from '@shared/types'

export const PHASE_LABEL: Record<TerminalPhase, string> = {
  booting: '启动中',
  ready: '已就绪',
  delivering: '投递中',
  running: '运行中',
  done: '已完成',
  error: '异常'
}

/** 会话已运行时长（列表卡片用） */
export const runTime = (startedAt: number): string => {
  const s = Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
  const m = Math.floor(s / 60)
  return m >= 60 ? `${Math.floor(m / 60)} 小时 ${m % 60} 分` : `${m} 分 ${String(s % 60).padStart(2, '0')} 秒`
}

/** 用最近一次输出距今的时间描述会话活跃度 */
export const outputState = (lastOutputAt: number): string => {
  const s = Math.floor((Date.now() - lastOutputAt) / 1000)
  if (s < 3) return '输出中…'
  if (s < 60) return `${s} 秒前还有输出`
  return '静默'
}

/** 系统终端的显示名（PowerShell / CMD / Git Bash） */
export const shellLabel = (kind: TerminalKind): string =>
  TERMINALS.find((t) => t.id === kind)?.label ?? kind

/** 回落首问时的截取长度：侧栏一栏放不下整条问题 */
const TASK_NAME_MAX = 30

export interface TaskName {
  text: string
  /** 名字来自首问截断，卡片下方就不再重复整条首问 */
  fromQuery: boolean
}

/** 卡片标题的任务名：CLI 自己起的会话标题优先，其次截首问首个非空行，都没有才用目录名 */
export const taskName = (
  title: string | undefined,
  initialQuery: string | undefined,
  fallback: string
): TaskName => {
  const native = title?.split('\n').map((l) => l.trim()).find((l) => l)
  if (native) return { text: native, fromQuery: false }
  const query = (initialQuery ?? '').split('\n').map((l) => l.trim()).find((l) => l) ?? ''
  if (!query) return { text: fallback, fromQuery: false }
  return {
    text: query.length > TASK_NAME_MAX ? `${query.slice(0, TASK_NAME_MAX)}…` : query,
    fromQuery: true
  }
}
