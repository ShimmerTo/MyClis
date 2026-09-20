import { homedir } from 'os'
import { join } from 'path'
import { MODEL_TEST_PROMPT } from './types'
import type { CliAdapter, DeliveryProfile } from './types'
import { asRecord, contentText, num, scanHead, stamp, str, toolLine } from './transcript'

const HOME = homedir()

const THINKING = new Set(['thinking'])

function piFlags(model: string, permissionMode?: string): string[] {
  const flags = model ? ['--model', model] : []
  if (permissionMode === 'approve') return [...flags, '-a']
  if (permissionMode === 'no_approve') return [...flags, '-na']
  if (permissionMode === 'readonly') return [...flags, '--tools', 'read,grep,find,ls']
  return flags
}

/** 启动注入走 pi 自己的追加系统提示参数 */
function piPrompt(extraPrompt?: string): string[] {
  return extraPrompt ? ['--append-system-prompt', extraPrompt] : []
}

/**
 * 实测（0.82.1）：位置参数是「带初始提示进交互模式」（--help 明写），@file 会被内联展开。
 * 注意 pi 的 `@` 会吃掉整个 argv，路径与引导语必须分成两个参数。
 * 编辑器没有常驻 placeholder，footer 里的上下文百分比是唯一稳定锚点。
 */
const piDelivery: DeliveryProfile = {
  initialPromptArgs: ({ file, lead }) => [`@${file}`, lead],
  promptFileMode: 'inline',
  ready: /\d+(?:\.\d+)?%\/[\d.]+k/i,
  allowSilentFallback: true,
  // 判据跑在去掉空白的文本上，所以词间一律用 \s*
  foldedEcho: /\[\s*paste\s*#\d+/i
}

export const piAdapter: CliAdapter = {
  id: 'pi',
  label: 'Pi CLI',
  // npm 全局安装 @mariozechner/pi-coding-agent 后的可执行名
  candidates: ['pi'],
  knownExes: () => [],
  // Pi 设计上无权限弹窗；这里的选项只影响目录信任与工具集
  permissionOptions: [
    { id: 'default', label: '默认', description: '继承 Pi 用户配置；未信任目录首次启动会询问 Project trust' },
    { id: 'approve', label: '信任目录', description: '本次运行信任项目本地文件（-a）' },
    { id: 'no_approve', label: '不信任目录', description: '本次运行忽略项目本地文件（-na）' },
    { id: 'readonly', label: '只读', description: '仅加载 read/grep/find/ls 工具，不改文件' }
  ],
  // --model 支持 provider/id 形式（如 openai/gpt-4o）
  launchArgs: (bin, model, permissionMode, extraPrompt) => [bin, ...piFlags(model, permissionMode), ...piPrompt(extraPrompt)],
  sessionIdArgs: (sessionId) => ['--session-id', sessionId],
  // Pi 用 --session 指定要接着写的会话，不新建
  resumeArgs: (bin, model, permissionMode, sessionId, extraPrompt) => [
    bin,
    '--session',
    sessionId,
    ...piFlags(model, permissionMode),
    ...piPrompt(extraPrompt)
  ],
  skillTargets: () => [{ kind: 'skills', dir: join(HOME, '.pi', 'agent', 'skills') }],
  // -p 是非交互入口；测试不写会话，免得在会话目录里留下一堆 ping
  testArgs: (bin, model) => [
    bin,
    '-p',
    '--no-session',
    ...(model ? ['--model', model] : []),
    MODEL_TEST_PROMPT
  ],
  sessionScanDepth: 2,
  sessionRoot: () => join(HOME, '.pi', 'agent', 'sessions'),
  // 文件名是 <ISO时间>_<id>.jsonl
  sessionFileMatch: (id) => new RegExp(`_${id}\\.jsonl$`, 'i'),
  parseTranscript: (line, out) => {
    if (line.type !== 'message') return
    const message = asRecord(line.message)
    if (!message) return
    const ts = stamp(line.timestamp) ?? stamp(message.timestamp)
    const role = str(message.role)
    const blocks = Array.isArray(message.content) ? (message.content as unknown[]) : []
    if (role === 'toolResult') return
    for (const item of blocks) {
      const block = asRecord(item)
      if (block?.type === 'toolCall') {
        out.push({ kind: 'tool', name: str(block.name), text: toolLine(block.name, block.arguments), ts })
      } else if (block?.type === 'thinking') {
        const thinking = str(block.thinking) || contentText([block], THINKING)
        if (thinking) out.push({ kind: 'reasoning', text: thinking, ts })
      }
    }
    const text = typeof message.content === 'string' ? message.content : contentText(blocks)
    if (!text) return
    if (role === 'user') out.push({ kind: 'user', text, ts })
    else if (role === 'assistant') out.push({ kind: 'assistant', text, ts })
    // session / model_change / thinking_level_change 等状态记录一律跳过
  },
  parseUsage: (line) => {
    if (line.type !== 'message') return undefined
    const message = asRecord(line.message)
    if (str(message?.role) !== 'assistant') return undefined
    const usage = asRecord(message?.usage)
    if (!usage) return undefined
    const input = num(usage.input)
    const output = num(usage.output)
    const cachedInput = num(usage.cacheRead)
    const reasoning = num(usage.reasoning)
    const cost = asRecord(usage.cost)
    return {
      key: str(message?.id) || str(line.id),
      model: str(message?.model) || undefined,
      input,
      output,
      cachedInput,
      reasoning,
      total: num(usage.totalTokens) || input + output,
      cost: num(cost?.total) || undefined,
      exact: input > 0 || output > 0
    }
  },
  readSessionHead: scanHead,
  // 启动期只有未信任目录会出现 Project trust 选择器；回车保存默认选项（Trust）
  startupHandshake: (screen) => (/Project trust/i.test(screen) ? '\r' : undefined),
  delivery: piDelivery
}
