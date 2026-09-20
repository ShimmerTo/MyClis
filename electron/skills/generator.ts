import type { AppConfig } from '../../shared/types'
import { permissionLabelOf, profileLabel } from '../../shared/profile'
import { getAdapter } from '../cli/registry'
import type { SkillAssignment, SkillCtx, SkillFile } from './templates'
import { buildSkillFiles } from './templates'

/**
 * 由当前配置渲染全部 skills 文件。
 * 新增一个触发命令：在 templates 里加一项并注册到 buildSkillFiles。
 */
export function generateSkillFiles(cfg: AppConfig, bridgeUrl: string): SkillFile[] {
  // 清单由实时配置解析，主 CLI 照着它填 targets；写进正文会被用户改旧。
  const assigned = (ids: string[]): SkillAssignment[] =>
    ids.flatMap((id) => {
      const profile = cfg.cliConfigs.find((item) => item.id === id)
      const adapter = profile ? getAdapter(profile.cli) : undefined
      if (!profile || !adapter) return []
      return [
        {
          id: profile.id,
          label: profileLabel(
            profile,
            adapter.label,
            permissionLabelOf(adapter.permissionOptions, profile.permissionMode)
          )
        }
      ]
    })
  const ctx: SkillCtx = {
    bridgeUrl,
    commands: cfg.commands,
    assignments: {
      design: assigned(cfg.launch.designCliIds),
      write: assigned(cfg.launch.codeWriterCliIds),
      review: assigned(cfg.launch.codeReviewCliIds)
    }
  }
  return buildSkillFiles(ctx)
}

export type { SkillFile, SkillCtx } from './templates'
export { DEFAULT_PROMPTS, PLACEHOLDER_HINT } from '../../shared/skillPrompts'
