import type { SshControlApi } from '../packages/ssh/src/contracts'

export type * from '../packages/ssh/src/contracts'

export interface SshHostApi {
  ssh: SshControlApi
  sshResolveScope(workDir: string): Promise<{ scopeId: string; label: string }>
  sshPickIdentity(): Promise<string | null>
}
