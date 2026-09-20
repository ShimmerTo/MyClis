import type { SpawnOptions, ExecFileOptions } from 'child_process'
import type { TerminalKind } from '../shared/types'

/** Windows 下隐藏子进程控制台窗口 */
export const windowsHide: ExecFileOptions['windowsHide'] & SpawnOptions['windowsHide'] = true

/**
 * 把命令行拼成可键入 shell 的一行（简单引号包裹含空格参数）。
 * git-bash 会把键入行里的 `\` 当转义吃掉，路径参数统一转成正斜杠。
 */
export function toShellLine(args: string[], shell?: TerminalKind): string {
  if (shell === 'powershell') {
    const quote = (value: string): string => `'${value.replace(/'/g, "''")}'`
    return `& ${args.map(quote).join(' ')}`
  }
  if (shell === 'gitbash') {
    const quote = (value: string): string => `'${value.replace(/\\/g, '/').replace(/'/g, `'"'"'`)}'`
    return args.map(quote).join(' ')
  }
  return args.map((value) => (/[\s&|<>^]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value)).join(' ')
}
