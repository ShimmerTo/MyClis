import { homedir } from 'os'
import { join } from 'path'
import { MODEL_TEST_PROMPT } from './types'
import type { CliAdapter, DeliveryProfile } from './types'
import { asRecord, contentText, num, scanHead, stamp, str, toolLine } from './transcript'

const HOME = homedir()

const REASONING_KINDS = new Set(['reasoning_text'])

function codebuddyFlags(model: string, permissionMode?: string): string[] {
  const flags = model ? ['--model', model] : []
  const allowed = new Set(['plan', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions'])
  const mode = str(permissionMode)
  return allowed.has(mode) ? [...flags, '--permission-mode', mode] : flags
}

/** 启动注入走 codebuddy 自己的追加系统提示参数 */
function codebuddyPrompt(extraPrompt?: string): string[] {
  return extraPrompt ? ['--append-system-prompt', extraPrompt] : []
}

/**
 * 实测（v2.154.0）：位置参数是「进 REPL 并带上初始提示」，进程跑完不退出。
 * 粘贴折叠阈值是「>800 字符 或 >2 行」，所以长任务一律走临时文件，不走粘贴。
 * 输入框没有常驻 placeholder，可用的锚点是底部常驻的 `? for shortcuts`。
 */
const codebuddyDelivery: DeliveryProfile = {
  initialPromptArgs: ({ file, lead }) => [`${lead} @${file}`],
  promptFileMode: 'tool-read',
  ready: /\?\s*for\s*shortcuts/i,
  allowSilentFallback: true,
  // 判据跑在去掉空白的文本上，所以词间一律用 \s*
  foldedEcho: /\[\s*Pasted\s*text\s*#\d+/i
}

export const codebuddyAdapter: CliAdapter = {
  id: 'codebuddy',
  label: 'CodeBuddy CLI',
  candidates: ['codebuddy'],
  knownExes: () => [],
  permissionOptions: [
    { id: 'default', label: '默认', description: '使用 CodeBuddy 默认批准策略' },
    { id: 'plan', label: '仅规划', description: '只规划，不直接修改代码' },
    { id: 'acceptEdits', label: '批准编辑', description: '自动批准文件编辑' },
    { id: 'auto', label: '自动', description: '由 CodeBuddy 自动判断权限' },
    { id: 'dontAsk', label: '不询问', description: '不弹出权限询问' },
    { id: 'bypassPermissions', label: '完全权限', description: '绕过权限检查', dangerous: true }
  ],
  launchArgs: (bin, model, permissionMode, extraPrompt) => [bin, ...codebuddyFlags(model, permissionMode), ...codebuddyPrompt(extraPrompt)],
  sessionIdArgs: (sessionId) => ['--session-id', sessionId],
  resumeArgs: (bin, model, permissionMode, sessionId, extraPrompt) => [
    bin,
    '--resume',
    sessionId,
    ...codebuddyFlags(model, permissionMode),
    ...codebuddyPrompt(extraPrompt)
  ],
  skillTargets: () => [{ kind: 'skills', dir: join(HOME, '.codebuddy', 'skills') }],
  // codebuddy 没有列模型的子命令（只有 --help 里那句「Currently supported」），模型名照旧手输
  testArgs: (bin, model) => [bin, '-p', ...(model ? ['--model', model] : []), MODEL_TEST_PROMPT],
  // <id>/subagents/agent-x.jsonl 是子代理的分叉，不属于本页要展示的主会话
  sessionScanDepth: 2,
  sessionRoot: () => join(HOME, '.codebuddy', 'projects'),
  sessionFileMatch: (id) => new RegExp(`^${id}\\.jsonl$`, 'i'),
  // 记录比 qoder 平一层：type 直接是 message|reasoning|function_call，role/content 在同一级
  parseTranscript: (line, out) => {
    const ts = stamp(line.timestamp)
    if (line.type === 'message') {
      const role = str(line.role)
      const text = contentText(line.content)
      if (!text) return
      if (role === 'user') out.push({ kind: 'user', text, ts })
      else if (role === 'assistant') out.push({ kind: 'assistant', text, ts })
      return
    }
    if (line.type === 'reasoning') {
      const text = contentText(line.rawContent, REASONING_KINDS)
      if (text) out.push({ kind: 'reasoning', text, ts })
      return
    }
    if (line.type === 'function_call') {
      const display = asRecord(line.providerData)?.argumentsDisplayText
      out.push({
        kind: 'tool',
        name: str(line.name),
        text: toolLine(line.name, str(display) || line.arguments),
        ts
      })
    }
    // function_call_result / file-history-snapshot / ai-title / summary / turn-metrics 一律跳过
  },
  parseUsage: (line) => {
    const provider = asRecord(line.providerData)
    const raw = asRecord(provider?.rawUsage)
    const message = asRecord(line.message)
    const usage = raw ?? asRecord(message?.usage)
    if (!usage) return undefined
    const input = num(usage.prompt_tokens ?? usage.input_tokens)
    const output = num(usage.completion_tokens ?? usage.output_tokens)
    const cachedInput = num(usage.prompt_cache_hit_tokens ?? usage.cache_read_input_tokens)
    const reasoning = num(asRecord(usage.completion_tokens_details)?.reasoning_tokens ?? usage.completion_thinking_tokens)
    return {
      key: str(provider?.request_id) || str(provider?.messageId) || str(provider?.conversationRequestId),
      model: str(provider?.model) || str(provider?.requestModelName) || undefined,
      input,
      output,
      cachedInput,
      reasoning,
      total: num(usage.total_tokens) || input + output,
      credit: num(usage.credit) || undefined,
      exact: input > 0 || output > 0
    }
  },
  readSessionHead: scanHead,
  /**
   * codebuddy 不内联 @file 内容，只把 @path 交给模型、由模型自己 Read，
   * 所以确认时只能认「首条用户消息出现了这个文件引用」，不能比对正文指纹。
   */
  delivery: codebuddyDelivery
}
