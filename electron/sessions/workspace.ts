import { mkdirSync } from 'fs'
import { join } from 'path'

/** 稳定会话目录相对路径；拒绝缺参，避免误写到名为 undefined 的公共目录。 */
export function workspaceRelativePath(id: string): string {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id)) throw new Error('无效的会话目录标识')
  return `.clichilds/${id}`
}

/** 预建主 CLI 与子 CLI 共用的会话工作目录。 */
export function ensureSessionWorkspace(workDir: string, id: string): string {
  const root = join(workDir, workspaceRelativePath(id))
  for (const name of ['requests', 'results', 'prompts']) mkdirSync(join(root, name), { recursive: true })
  return root
}
