/**
 * 四套 CLI 的 transcript 记录格式互不相同，这里只放它们共用的取值小工具，
 * 具体的字段映射留在各自适配器里（归属地在 CliAdapter.parseTranscript）。
 */
import type { SessionHead } from './types'

const TEXT_KINDS = new Set(['text', 'input_text', 'output_text'])

export function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

export function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/** 时间戳：qoder/pi 是 ISO 串，codebuddy/codex 头尾混用毫秒数 */
export function stamp(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const t = Date.parse(v)
    return Number.isNaN(t) ? undefined : t
  }
  return undefined
}

export function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined
}

/** jsonl 一行；被尾部截断的半行会解析失败，返回 undefined 由调用方跳过 */
export function tryParse(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown
    return asRecord(parsed)
  } catch {
    return undefined
  }
}

/** message.content 可能是裸字符串，也可能是块数组；只收正文类块，工具结果不要。 */
export function contentText(content: unknown, kinds: Set<string> = TEXT_KINDS): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const item of content) {
    const block = asRecord(item)
    if (!block) continue
    const kind = block.type
    if (typeof kind === 'string' && !kinds.has(kind)) continue
    const text = str(block.text)
    if (text) parts.push(text)
  }
  return parts.join('\n')
}

/** 工具调用压成一行摘要：`exec · npm run dev`；入参与输出都不展开。 */
export function toolLine(name: unknown, args: unknown): string {
  // codex / codebuddy 的 arguments 是 JSON 串，先还原成对象再挑要显示的那一项
  let value = args
  if (typeof value === 'string') {
    const trimmed = value.trim()
    value = trimmed.startsWith('{') || trimmed.startsWith('[') ? (tryParse(trimmed) ?? value) : value
  }
  let brief = ''
  if (typeof value === 'string') brief = value
  else if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const pick = obj.cmd ?? obj.command ?? obj.path ?? obj.file_path ?? obj.input ?? obj.pattern
    brief = typeof pick === 'string' ? pick : JSON.stringify(pick ?? '')
  }
  const first = brief.trim().split('\n')[0].slice(0, 120)
  const label = str(name) || 'tool'
  return first ? `${label} · ${first}` : label
}

/** qoder / codebuddy / pi 三家都把 cwd 平铺在记录上，扫头部即可，不必各写一份 */
export function scanHead(lines: string[]): SessionHead {
  let cwd: string | undefined
  let startedAt: number | undefined
  let title: string | undefined
  for (const raw of lines) {
    const line = tryParse(raw)
    if (!line) continue
    const message = asRecord(line.message)
    if (!cwd) cwd = str(line.cwd) || str(message?.cwd) || undefined
    if (startedAt === undefined) startedAt = stamp(line.timestamp) ?? stamp(message?.timestamp)
    if (!title) {
      for (const key of ['customTitle', 'aiTitle', 'title', 'summary']) {
        const value = str(line[key]).trim()
        if (value) {
          title = value
          break
        }
      }
    }
    if (cwd && startedAt !== undefined && title) break
  }
  return { cwd, startedAt, title }
}
