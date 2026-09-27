import type { DbControlApi } from '../packages/database/src/contracts'
export type * from '../packages/database/src/contracts'
export { DB_METADATA_TTL, canUseRowKeyType } from '../packages/database/src/contracts'
export interface DatabaseHostApi {
  database: DbControlApi
  databaseResolveScope(workDir: string): Promise<{ scopeId: string; label: string }>
  databasePickFile(): Promise<string | null>
}
