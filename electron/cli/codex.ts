import { homedir } from 'os'
import { join } from 'path'
import { MODEL_TEST_PROMPT } from './types'
import type { CliAdapter, DeliveryProfile } from './types'
import { asRecord, num, stamp, str, toolLine, tryParse } from './transcript'

const HOME = homedir()

/** 权限与模型的全局参数；codex 要求它们出现在 `resume` 子命令之前。 */
function codexFlags(model: string, permissionMode = 'default'): string[] {
  const flags = model ? ['--model', model] : []
  if (permissionMode === 'read-only') return [...flags, '--sandbox', 'read-only', '--ask-for-approval', 'on-request']
  if (permissionMode === 'approval') {
    return [...flags, '--sandbox', 'workspace-write', '--ask-for-approval', 'on-request']
  }
  if (permissionMode === 'auto') return [...flags, '--approve-for-me']
  if (permissionMode === 'workspace-full') {
    return [...flags, '--sandbox', 'workspace-write', '--ask-for-approval', 'never']
  }
  if (permissionMode === 'full') return [...flags, '--dangerously-bypass-approvals-and-sandbox']
  return flags
}

/**
 * codex 没有 --append-system-prompt；`-c` 的值按 TOML 解析，解析失败时原样当字面量用，
 * 因此可承载任意单行文本。必须与其它全局参数一样排在 `resume` 子命令之前。
 */
function codexPrompt(extraPrompt?: string): string[] {
  return extraPrompt ? ['-c', 'developer_instructions=' + extraPrompt] : []
}

/**
 * 实测（0.142.5）：`codex [OPTIONS] [PROMPT]` 的位置参数是「带提示词启动会话」，
 * resume 也支持 `codex resume <id> <prompt>`；@file 会被内联展开进首条用户消息。
 * 旧的 `ask codex to do anything` 锚点在新版已失效（改成轮播 tips），这里先不设锚点，
 * 只保留静默兜底 —— 层1 生效时根本用不到它。
 */
const codexDelivery: DeliveryProfile = {
  initialPromptArgs: ({ file, lead }) => [`${lead} @${file}`],
  promptFileMode: 'inline',
  allowSilentFallback: true,
  // 判据跑在去掉空白的文本上，所以词间一律用 \s*
  foldedEcho: /\[\s*Pasted\s*Content\s*\d+/i
}

export const codexAdapter: CliAdapter = {
  id: 'codex',
  label: 'Codex CLI',
  candidates: ['codex'],
  knownExes: () => [join(HOME, '.codex', 'bin', 'codex.cmd')],
  permissionOptions: [
    { id: 'default', label: '默认', description: '继承 Codex 用户配置' },
    { id: 'read-only', label: '只读', description: '只读沙箱，需要时请求批准' },
    { id: 'approval', label: '批准', description: '可写工作区，危险操作按需批准' },
    { id: 'auto', label: '自动审批', description: '由 Codex 自动审查批准请求' },
    { id: 'workspace-full', label: '工作区完全', description: '可写工作区且不询问' },
    { id: 'full', label: '完全权限', description: '绕过批准与沙箱', dangerous: true }
  ],
  launchArgs: (bin, model, permissionMode, extraPrompt) => [
    bin,
    ...codexFlags(model, permissionMode),
    ...codexPrompt(extraPrompt)
  ],
  // codex 没有预分配 session id 的 flag（--session-id 只存在于 MCP 头里），只能事后观测
  resumeArgs: (bin, model, permissionMode, sessionId, extraPrompt) => [
    bin,
    ...codexFlags(model, permissionMode),
    ...codexPrompt(extraPrompt),
    'resume',
    sessionId
  ],
  skillTargets: () => [{ kind: 'prompts', dir: join(HOME, '.codex', 'prompts') }],
  // exec 是非交互入口；工作目录可能在非 git 仓库下（测试跑在临时目录），要跳过仓库检查
  testArgs: (bin, model) => [
    bin,
    'exec',
    '--skip-git-repo-check',
    ...(model ? ['--model', model] : []),
    MODEL_TEST_PROMPT
  ],
  // 目录信任/继续提示一律回车取默认项；TERM=dumb 的 "Continue anyway? [y/N]" 要先答 y
  startupHandshake: (screen) => {
    if (/continue anyway/i.test(screen)) return 'y\r'
    if (/do you trust the contents of this directory|press enter to continue/i.test(screen)) return '\r'
    return undefined
  },
  delivery: codexDelivery,
  sessionRoot: () => join(HOME, '.codex', 'sessions'),
  // sessions/YYYY/MM/DD/rollout-<ISO>-<uuid>.jsonl
  sessionScanDepth: 4,
  sessionFileMatch: (id) => new RegExp(`rollout-.*-${id}\\.jsonl$`, 'i'),
  parseTranscript: (line, out) => {
    const payload = asRecord(line.payload)
    if (!payload) return
    const ts = stamp(line.timestamp)
    const kind = str(payload.type)
    // 正文只认 event_msg：response_item 里的 message 与它重复，只从中取工具调用。
    if (line.type === 'event_msg') {
      if (kind === 'user_message') out.push({ kind: 'user', text: str(payload.message), ts })
      else if (kind === 'agent_message') out.push({ kind: 'assistant', text: str(payload.message), ts })
      else if (kind === 'agent_reasoning') {
        out.push({ kind: 'reasoning', text: str(payload.text ?? payload.summary), ts })
      }
      return
    }
    if (line.type === 'response_item' && (kind === 'function_call' || kind === 'custom_tool_call')) {
      // 老式 function_call 带 JSON 的 arguments；新式 custom_tool_call（exec）只有 input 源码串
      out.push({
        kind: 'tool',
        name: str(payload.name),
        text: toolLine(payload.name, payload.arguments ?? payload.input),
        ts
      })
    }
    // function_call_output / session_meta / turn_context / world_state 一律跳过
  },
  parseUsage: (line) => {
    const payload = asRecord(line.payload)
    if (line.type !== 'event_msg' || payload?.type !== 'token_count') return undefined
    const info = asRecord(payload.info)
    const total = asRecord(info?.total_token_usage)
    if (!total) return undefined
    return {
      input: num(total.input_tokens),
      output: num(total.output_tokens),
      cachedInput: num(total.cached_input_tokens),
      reasoning: num(total.reasoning_output_tokens),
      total: num(total.total_tokens),
      exact: true,
      cumulative: true
    }
  },
  readSessionHead: (lines) => {
    for (const raw of lines) {
      const line = tryParse(raw)
      const payload = line && asRecord(line.payload)
      if (line?.type === 'session_meta' && payload) {
        return { cwd: str(payload.cwd) || undefined, startedAt: stamp(payload.timestamp) }
      }
    }
    return {}
  }
}
