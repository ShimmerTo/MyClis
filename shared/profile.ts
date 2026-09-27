// CLI 档案显示名：别名留空时回落「CLI名-模型名-权限名」
import type { CliConfig, CliPermissionOption, CliStatus, TerminalProgram } from './types'

export function autoAlias(cliLabel: string, model: string, permissionLabel: string): string {
  return `${cliLabel}-${model.trim() || '默认'}-${permissionLabel}`
}

export function permissionLabelOf(options: CliPermissionOption[], id: string): string {
  return options.find((option) => option.id === id)?.label ?? id
}

/** 用户填的别名优先，留空则按当前组合自动生成 */
export function profileLabel(profile: CliConfig, cliLabel: string, permissionLabel: string): string {
  return profile.alias?.trim() || autoAlias(cliLabel, profile.model ?? '', permissionLabel)
}

/** 渲染层入口：cli 标签与权限标签都从检测结果里查 */
export function profileLabels(
  profile: CliConfig,
  clis: CliStatus[]
): { cliLabel: string; permissionLabel: string; label: string } {
  const status = clis.find((cli) => cli.id === profile.cli)
  const cliLabel = status?.label ?? profile.cli
  const permissionLabel = permissionLabelOf(status?.permissionOptions ?? [], profile.permissionMode)
  return { cliLabel, permissionLabel, label: profileLabel(profile, cliLabel, permissionLabel) }
}

/** 会话启动时记录的权限模式：以实跑参数为准展示，检测结果里查不到（老会话 / CLI 未装）返回 null，调用处不显示 */
export function sessionPermission(
  clis: CliStatus[],
  cli: TerminalProgram,
  permissionMode: string | undefined
): CliPermissionOption | null {
  if (!permissionMode) return null
  return (
    clis.find((item) => item.id === cli)?.permissionOptions.find((item) => item.id === permissionMode) ?? null
  )
}
