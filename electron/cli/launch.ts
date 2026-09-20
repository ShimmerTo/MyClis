import { randomUUID } from 'crypto'
import type { CliAdapter, PromptFileRef } from './types'

/**
 * 组装 CLI 启动行。能预分配原生 id 的（qoder/codebuddy/pi）在这里就把 id 定下来，
 * 这样主会话与同一目录里的子会话不会认错；codex 没有这个 flag，返回 undefined，改由文件系统观测补。
 * extraPrompt 是启动注入，initialPrompt 是层1 投递的任务引用（拼在最末位），两者新会话与恢复都带。
 */
export function buildLaunch(
  adapter: CliAdapter,
  bin: string,
  model: string,
  permissionMode: string,
  resumeSessionId?: string,
  extraPrompt?: string,
  initialPrompt?: PromptFileRef
): { args: string[]; nativeSessionId?: string } {
  // 层1：CLI 自己在启动时提交这条任务，应用不再往输入框粘贴
  const tail = initialPrompt ? (adapter.delivery?.initialPromptArgs?.(initialPrompt) ?? []) : []
  if (resumeSessionId) {
    if (!adapter.resumeArgs) throw new Error(`${adapter.label} 不支持恢复历史会话`)
    return {
      args: adapter.resumeArgs(bin, model, permissionMode, resumeSessionId, extraPrompt).concat(tail),
      nativeSessionId: resumeSessionId
    }
  }
  const nativeSessionId = adapter.sessionIdArgs ? randomUUID() : undefined
  if (!nativeSessionId || !adapter.sessionIdArgs) {
    return { args: adapter.launchArgs(bin, model, permissionMode, extraPrompt).concat(tail) }
  }
  // 位置参数必须在最后：先全局参数与 --session-id，再挂任务引用
  return {
    args: adapter
      .launchArgs(bin, model, permissionMode, extraPrompt)
      .concat(adapter.sessionIdArgs(nativeSessionId), tail),
    nativeSessionId
  }
}
