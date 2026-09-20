import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { MODEL_TEST_PROMPT } from './types'
import type { CliAdapter, DeliveryProfile } from './types'
import { asRecord, contentText, num, scanHead, stamp, str, toolLine } from './transcript'

const HOME = homedir()

let modelNames: Map<string, string> | null = null
let modelNamesAt = 0

/**
 * transcript 里的模型是内部 id（dfmodel、qfmodel…），Qoder 自己的文案表里就有展示名。
 * 读不到就退回原始 id —— 宁可显示得丑，也不能拿配置里的旧模型名冒充当前模型。
 */
function modelLabel(id: string): string {
  const now = Date.now()
  if (!modelNames || now - modelNamesAt > 10 * 60_000) {
    modelNamesAt = now
    modelNames = new Map()
    try {
      const raw = readFileSync(join(HOME, '.qoder', '.auth', 'dynamic-texts.json'), 'utf-8')
      for (const match of raw.matchAll(/"modelSelector\.item\.([a-z0-9_-]+)":\s*"([^"]*)"/gi)) {
        if (!modelNames.has(match[1])) modelNames.set(match[1], match[2])
      }
    } catch {
      // 文案表缺失时保持空表
    }
  }
  return modelNames.get(id) ?? id
}

function qoderFlags(model: string, permissionMode?: string): string[] {
  const flags = model ? ['--model', model] : []
  const allowed = new Set(['accept_edits', 'auto', 'dont_ask', 'bypass_permissions'])
  const mode = str(permissionMode)
  return allowed.has(mode) ? [...flags, '--permission-mode', mode] : flags
}

/** 启动注入走 qodercli 自己的追加系统提示参数 */
function qoderPrompt(extraPrompt?: string): string[] {
  return extraPrompt ? ['--append-system-prompt', extraPrompt] : []
}

/**
 * 实测（1.1.56）：`-i` 是「执行提示词后继续交互」；隐藏的 `--prompt` 不带 `-p` 会被判成非交互，不能用。
 * qoder 不内联 @file，由模型自己 Read，且实测拒绝读取工作区之外的文件 —— 临时文件必须落在工作目录内。
 * 输入框锚点沿用 `type your message`；1.1.5x 起 TUI 把词间空格渲染成 ESC[1C（光标右移），
 * stripAnsi 后词会粘连成 "Typeyourmessage…"，所以词间只允许空白而不强制存在 —— 两种渲染都能命中。
 */
const qoderDelivery: DeliveryProfile = {
  initialPromptArgs: ({ file, lead }) => ['-i', `${lead} @${file}`],
  promptFileMode: 'tool-read',
  ready: /type\s*your\s*message/i,
  allowSilentFallback: true,
  // 判据跑在去掉空白的文本上，所以词间一律用 \s*
  foldedEcho: /\[\s*Pasted\s*text\s*#\d+/i
}

export const qoderAdapter: CliAdapter = {
  id: 'qoder',
  label: 'Qoder CLI',
  // PATH 上的 `qoder` 是 IDE 启动器，真正的 agent CLI 是 qodercli
  candidates: ['qodercli'],
  knownExes: () => [
    join(HOME, '.qoder', 'bin', 'qodercli', 'qodercli.exe'),
    join(HOME, '.qoder', 'entry', 'qoder.cmd')
  ],
  permissionOptions: [
    { id: 'default', label: '默认', description: '使用 Qoder 默认批准策略' },
    { id: 'accept_edits', label: '批准编辑', description: '自动批准文件编辑' },
    { id: 'auto', label: '自动', description: '由 Qoder 自动判断权限' },
    { id: 'dont_ask', label: '不询问', description: '不弹出权限询问' },
    { id: 'bypass_permissions', label: '完全权限', description: '绕过权限检查', dangerous: true }
  ],
  launchArgs: (bin, model, permissionMode, extraPrompt) => [
    bin,
    ...qoderFlags(model, permissionMode),
    ...qoderPrompt(extraPrompt)
  ],
  sessionIdArgs: (sessionId) => ['--session-id', sessionId],
  resumeArgs: (bin, model, permissionMode, sessionId, extraPrompt) => [
    bin,
    '--resume',
    sessionId,
    ...qoderFlags(model, permissionMode),
    ...qoderPrompt(extraPrompt)
  ],
  skillTargets: () => [{ kind: 'skills', dir: join(HOME, '.qoder', 'skills') }],
  testArgs: (bin, model) => [bin, '-p', ...(model ? ['--model', model] : []), MODEL_TEST_PROMPT],
  // 启动期只有 <id>/subagents 等旁支，主 transcript 就是 <id>.jsonl，深度 2 足够
  sessionScanDepth: 2,
  sessionRoot: () => join(HOME, '.qoder', 'projects'),
  sessionFileMatch: (id) => new RegExp(`^${id}\\.jsonl$`, 'i'),
  // 记录形态与 Claude 系一致：type=user|assistant|system，正文在 message.content 的块数组里
  parseTranscript: (line, out) => {
    const message = asRecord(line.message)
    const ts = stamp(line.timestamp)
    if (line.type === 'user') {
      const text = contentText(message?.content)
      if (text) out.push({ kind: 'user', text, ts })
      return
    }
    if (line.type === 'assistant') {
      const blocks = Array.isArray(message?.content) ? (message!.content as unknown[]) : []
      for (const item of blocks) {
        const block = asRecord(item)
        if (!block) continue
        if (block.type === 'tool_use') {
          out.push({ kind: 'tool', name: str(block.name), text: toolLine(block.name, block.input), ts })
        } else if (block.type === 'thinking') {
          const thinking = str(block.thinking)
          if (thinking) out.push({ kind: 'reasoning', text: thinking, ts })
        }
      }
      const text = contentText(blocks)
      if (text) out.push({ kind: 'assistant', text, ts })
      return
    }
    if (line.type === 'system' && line.subtype !== 'compact_boundary' && typeof line.content === 'string') {
      out.push({ kind: 'system', text: line.content, ts })
    }
    // workspace-directories / runtime-config / attachment / *-title / file-history-snapshot 一律跳过
  },
  parseUsage: (line) => {
    if (line.type !== 'assistant') return undefined
    const message = asRecord(line.message)
    const usage = asRecord(message?.usage)
    if (!usage) return undefined
    const input = num(usage.input_tokens)
    const output = num(usage.output_tokens)
    const cachedInput = num(usage.cache_read_input_tokens)
    const rawModel = str(message?.model)
    return {
      key: str(usage.request_id) || str(message?.id) || str(line.uuid),
      model: rawModel ? modelLabel(rawModel) : undefined,
      input,
      output,
      cachedInput,
      total: input + output,
      credit: num(usage.credits) || undefined,
      exact: input > 0 || output > 0
    }
  },
  readSessionHead: scanHead,
  // 启动期只有按回车继续的提示
  startupHandshake: (screen) => (/press enter to continue/i.test(screen) ? '\r' : undefined),
  delivery: qoderDelivery
}
