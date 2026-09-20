import type { ChatEntry, CliId, TranscriptPage } from '@shared/types'

/** 「用其他 CLI 继续」时，被交接会话的来源信息 */
export interface HandoffSource {
  label: string
  cli: CliId
  cwd?: string
  nativeSessionId?: string
}

/** 只要用户提问与 AI 回复：思考、工具、系统条目不属于「任务上下文」 */
const KIND_HEAD: Partial<Record<ChatEntry['kind'], string>> = {
  user: '用户',
  assistant: '助手'
}

const stamp = (ts: number): string => new Date(ts).toLocaleString('zh-CN', { hour12: false })

/**
 * 把一条会话的正文整理成交接用的纯文本，落盘后交给新 CLI 读。
 * 只保留 user / assistant 两类条目，避免把大段工具输出与思考塞进交接文件。
 */
export function buildHandoffText(source: HandoffSource, page: TranscriptPage): string {
  const lines: string[] = ['# 会话交接记录', '']
  lines.push(`- 来源 CLI：${source.label}`)
  if (source.nativeSessionId) lines.push(`- 原生会话 id：${source.nativeSessionId}`)
  if (source.cwd) lines.push(`- 工作目录：${source.cwd}`)
  lines.push(`- 导出时间：${stamp(Date.now())}`)
  lines.push(`- 原始条目：${page.entries.length} 条${page.truncated ? '（只取到最近的部分）' : ''}`)
  lines.push('')

  const kept = page.entries.filter((entry) => entry.kind === 'user' || entry.kind === 'assistant')
  if (kept.length === 0) {
    lines.push('（这条会话没有可整理的问答正文 —— 新 CLI 需要先自己看一遍代码库）')
    return lines.join('\n')
  }
  for (const entry of kept) {
    lines.push(`## ${KIND_HEAD[entry.kind] ?? entry.kind}`)
    if (entry.ts) lines.push(`时间：${stamp(entry.ts)}`)
    lines.push('')
    lines.push(entry.text.trim() || '（空）')
    lines.push('')
  }
  return lines.join('\n')
}

/** 新 CLI 启动就绪后自动投递的交接说明 */
export function handoffPrompt(path: string): string {
  return `当前任务完成的历史记录：${path}，请继续完成`
}
