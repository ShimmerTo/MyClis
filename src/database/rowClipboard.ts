import type { DatabaseKind, DbColumn, DbResult, DbTable, DbValue } from '@shared/database'

type RowResult = Pick<DbResult, 'columns' | 'rows' | 'nonRoundTripColumns'>
type ColumnType = Pick<DbColumn, 'name' | 'type'>

function selectedRows(result: RowResult, rowIndexes: readonly number[]): DbValue[][] {
  if (!rowIndexes.length) throw new Error('请先选择要复制的行。')
  if (!result.columns.length) throw new Error('结果缺少字段，无法复制。')
  if (new Set(result.columns).size !== result.columns.length) throw new Error('结果包含重复字段名，无法无损复制。')
  const indexes = [...new Set(rowIndexes)].sort((a, b) => a - b)
  return indexes.map(index => {
    if (!Number.isSafeInteger(index) || index < 0 || index >= result.rows.length) throw new Error('行选择已失效，请重新选择。')
    const row = result.rows[index]
    if (!row || row.length !== result.columns.length) throw new Error('结果行与字段不一致，无法复制。')
    for (const value of row) {
      if (value === null || typeof value === 'string' || typeof value === 'boolean') continue
      if (typeof value === 'number' && Number.isFinite(value)) continue
      throw new Error('结果含有不支持的值类型，无法无损复制。')
    }
    return row
  })
}

/** 将选中行按结果字段顺序转换为 JSON；保留原始值类型，不推断或转换数值字符串。 */
export function formatRowsJson(result: RowResult, rowIndexes: readonly number[]): string {
  const rows = selectedRows(result, rowIndexes)
  return JSON.stringify(rows.map(row => Object.fromEntries(result.columns.map((name, index) => [name, row[index]]))), null, 2)
}

function assertUnicode(value: string): void {
  // TextEncoder 会悄悄替换孤立代理项；宁可拒绝，也不能生成内容已改变的 SQL。
  for (const character of value) {
    const code = character.codePointAt(0)!
    if (code >= 0xd800 && code <= 0xdfff) throw new Error('文本含有无效 Unicode，无法无损生成 INSERT SQL。')
  }
}

function quoteIdentifier(kind: DatabaseKind, name: string): string {
  if (!name || name.includes('\0')) throw new Error('标识符为空或含有 NUL，无法生成 INSERT SQL。')
  assertUnicode(name)
  if (kind === 'mysql') return '`' + name.replace(/`/g, '``') + '`'
  if (kind === 'mssql') return '[' + name.replace(/]/g, ']]') + ']'
  return '"' + name.replace(/"/g, '""') + '"'
}

function normalizedType(kind: DatabaseKind, type: string): string {
  const value = type.trim().toLowerCase()
  // MSSQL 元数据会给内置类型加方括号；不剥离 schema 或用户自定义类型的引用。
  return kind === 'mssql' && /^\[[a-z0-9 ]+\]$/.test(value) ? value.slice(1, -1) : value
}

function numericType(kind: DatabaseKind, type: string): boolean {
  const patterns: Record<DatabaseKind, RegExp> = {
    mysql: /^(?:tinyint|smallint|mediumint|bigint|int|integer|decimal|numeric|dec|fixed|float|double(?: precision)?|real)(?:\s*\(\s*\d+(?:\s*,\s*\d+)?\s*\))?(?: unsigned)?(?: zerofill)?$/,
    postgres: /^(?:smallint|integer|bigint|int2|int4|int8|numeric|decimal|real|double precision|float4|float8|smallserial|serial|bigserial)(?:\s*\(\s*\d+(?:\s*,\s*-?\d+)?\s*\))?$/,
    mssql: /^(?:tinyint|smallint|int|bigint|decimal|numeric|float|real|money|smallmoney)(?:\s*\(\s*\d+(?:\s*,\s*\d+)?\s*\))?$/,
    sqlite: /^(?:tinyint|smallint|mediumint|bigint|int|integer|int2|int8|unsigned big int|decimal|numeric|real|double(?: precision)?|float)(?:\s*\(\s*\d+(?:\s*,\s*\d+)?\s*\))?$/
  }
  return patterns[kind].test(type)
}

function utf8Hex(value: string): string {
  return Array.from(new TextEncoder().encode(value), byte => byte.toString(16).padStart(2, '0')).join('')
}

function binaryLiteral(kind: DatabaseKind, type: string, value: string): string | undefined {
  // 只有这些静态类型在当前驱动中确定返回 Buffer，再由宿主统一转为 base64。
  const reliable = kind === 'postgres' ? type === 'bytea'
    : kind === 'mysql' ? /^(?:(?:tiny|medium|long)?blob|(?:var)?binary(?:\s*\(\d+\))?)$/.test(type)
      : kind === 'mssql' ? /^(?:image|timestamp|rowversion|(?:var)?binary(?:\s*\((?:\d+|max)\))?)$/.test(type)
        : false
  if (!reliable) {
    // SQLite 的 BLOB 声明不能证明单元格的存储类型；BIT/自定义类型也不能猜编码。
    if (/binary|blob|bytea|image|bit\s*\(/i.test(type) || (kind === 'sqlite' && !type)) {
      throw new Error('字段的二进制或动态类型编码无法确认，请改用 JSON 或数据库原生导出。')
    }
    return undefined
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('二进制字段不是有效 base64，无法无损生成 INSERT SQL。')
  }
  const bytes = atob(value)
  if (btoa(bytes) !== value) throw new Error('二进制字段不是规范 base64，无法无损生成 INSERT SQL。')
  const hex = Array.from(bytes, byte => byte.charCodeAt(0).toString(16).padStart(2, '0')).join('')
  if (kind === 'postgres') return `pg_catalog.decode('${hex}', 'hex')`
  if (kind === 'mssql') return `0x${hex}`
  return `X'${hex}'`
}

function stringLiteral(kind: DatabaseKind, value: string): string {
  assertUnicode(value)
  const controls = /[\x00-\x1f\x7f-\x9f]/
  if (kind === 'mysql' && (value.includes('\\') || controls.test(value))) {
    // 避免 NO_BACKSLASH_ESCAPES 等 SQL_MODE 改变文本的含义。
    return `CONVERT(X'${utf8Hex(value)}' USING utf8mb4)`
  }
  if (kind === 'sqlite' && controls.test(value)) return `CAST(X'${utf8Hex(value)}' AS TEXT)`
  if (value.includes('\0')) throw new Error('目标方言无法可靠表示此 NUL 文本，请改用 JSON 或数据库原生导出。')
  const quoted = value.replace(/'/g, "''")
  if (kind === 'mssql') return `N'${quoted}'`
  if (kind === 'postgres' && (value.includes('\\') || controls.test(value))) {
    const escaped = quoted.replace(/\\/g, '\\\\').replace(/[\x01-\x1f\x7f-\x9f]/g, character => {
      // 使用 Unicode 转义，避免多字节控制字符被当成单个 UTF-8 字节。
      return '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0')
    })
    return `E'${escaped}'`
  }
  return `'${quoted}'`
}

function literal(kind: DatabaseKind, type: string, value: DbValue): string {
  if (value === null) return 'NULL'
  if (typeof value === 'number') return Object.is(value, -0) ? '-0' : String(value)
  if (typeof value === 'boolean') return kind === 'mssql' ? value ? '1' : '0' : value ? 'TRUE' : 'FALSE'
  const binary = binaryLiteral(kind, type, value)
  if (binary !== undefined) return binary
  if (numericType(kind, type) && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) return value
  return stringLiteral(kind, value)
}

/** 为选中行逐条生成 INSERT 快照模板；仅格式化，不执行 SQL；无法无损表示时抛错。 */
export function formatRowsInsertSql(
  kind: DatabaseKind,
  table: Pick<DbTable, 'schema' | 'name'>,
  columns: readonly ColumnType[],
  result: RowResult,
  rowIndexes: readonly number[]
): string {
  if (!['mysql', 'postgres', 'mssql', 'sqlite'].includes(kind)) throw new Error('不支持的数据库方言。')
  const rows = selectedRows(result, rowIndexes)
  if (kind === 'sqlite' && result.nonRoundTripColumns?.length) throw new Error('结果包含已转换的动态类型或不可靠精度，请改用 JSON 或数据库原生导出。')
  const metadata = new Map(columns.map(column => [column.name, normalizedType(kind, column.type)]))
  if (metadata.size !== columns.length || result.columns.some(name => !metadata.has(name))) {
    throw new Error('字段类型信息缺失或重复，请等待表结构加载后重试。')
  }
  const target = (table.schema ? quoteIdentifier(kind, table.schema) + '.' : '') + quoteIdentifier(kind, table.name)
  const names = result.columns.map(name => quoteIdentifier(kind, name)).join(', ')
  return rows.map(row => {
    const values = row.map((value, index) => literal(kind, metadata.get(result.columns[index])!, value)).join(', ')
    return `INSERT INTO ${target} (${names}) VALUES (${values});`
  }).join('\n')
}
