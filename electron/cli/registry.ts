import type { CliAdapter } from './types'
import { codexAdapter } from './codex'
import { qoderAdapter } from './qoder'
import { codebuddyAdapter } from './codebuddy'
import { piAdapter } from './pi'

/**
 * 适配器注册表。新增一个 CLI：新建适配器文件并在这里注册即可。
 */
export const adapters: CliAdapter[] = [codexAdapter, qoderAdapter, codebuddyAdapter, piAdapter]

export function getAdapter(id: string): CliAdapter | undefined {
  return adapters.find((a) => a.id === id)
}
