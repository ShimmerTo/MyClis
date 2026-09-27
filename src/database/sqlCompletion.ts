import type { EditorState } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'
import { ifNotIn, type Completion, type CompletionSource } from '@codemirror/autocomplete'
import { MSSQL, MySQL, PostgreSQL, SQLite, keywordCompletionSource, schemaCompletionSource, type SQLNamespace } from '@codemirror/lang-sql'
import { DB_METADATA_TTL, type DatabaseKind, type DbTable, type DbTableDetail } from '@shared/database'

export const sqlDialects = { mysql: MySQL, postgres: PostgreSQL, mssql: MSSQL, sqlite: SQLite }

export function createSqlKeywordSource(kind: DatabaseKind): CompletionSource {
  const source = keywordCompletionSource(sqlDialects[kind], true)
  return context => {
    const node = syntaxTree(context.state).resolveInner(context.pos, -1)
    return node.name === '.' || node.parent?.name === 'CompositeIdentifier' ? null : source(context)
  }
}

const key = (table: DbTable) => JSON.stringify([table.schema, table.name])
const namespaceKey = (name: string) => name.replace(/\./g, '\\.')
const unquote = (name: string) => {
  const closing = name[0] === '[' ? ']' : name[0]
  return ['"', '`', '['].includes(name[0]) && name.endsWith(closing)
    ? name.slice(1, -1).replaceAll(closing + closing, closing) : name
}
const quote = (kind: DatabaseKind, name: string) => {
  const opening = kind === 'mysql' ? '`' : kind === 'mssql' ? '[' : '"'
  const closing = opening === '[' ? ']' : opening
  return opening + name.replaceAll(closing, closing + closing) + closing
}

function referencedTables(state: EditorState, byName: Map<string, DbTable[]>): DbTable[] {
  const found = new Map<string, DbTable>()
  syntaxTree(state).iterate({ enter(node) {
    if (!['Identifier', 'QuotedIdentifier', 'CompositeIdentifier'].includes(node.name)) return
    const parts: string[] = []
    if (node.name === 'CompositeIdentifier') {
      for (let child = node.node.firstChild; child; child = child.nextSibling) {
        if (child.name.endsWith('Identifier')) parts.push(unquote(state.sliceDoc(child.from, child.to)))
      }
    } else parts.push(unquote(state.sliceDoc(node.from, node.to)))
    const matches = byName.get(parts.at(-1)?.toLocaleLowerCase() ?? '') ?? []
    for (const table of matches) {
      if (parts.length > 1 && table.schema.toLocaleLowerCase() !== parts.at(-2)?.toLocaleLowerCase()) continue
      found.set(key(table), table)
    }
    return false
  } })
  return [...found.values()]
}

export function createSqlCompletionSource(options: {
  kind: DatabaseKind
  tables: DbTable[]
  currentTable?: DbTable
  loadDetail: (table: DbTable) => Promise<DbTableDetail>
  onError: (cause: unknown) => void
}): CompletionSource {
  const { kind, tables, currentTable, loadDetail, onError } = options
  const details = new Map<string, DbTableDetail>()
  const failed = new Set<string>()
  const byName = new Map<string, DbTable[]>()
  for (const table of tables) {
    const name = table.name.toLocaleLowerCase()
    byName.set(name, [...byName.get(name) ?? [], table])
  }
  return ifNotIn(['String', 'LineComment', 'BlockComment'], async context => {
    const referenced = referencedTables(context.state, byName)
    const relevant = referenced.length ? referenced : currentTable ? [currentTable] : []
    for (const table of relevant) {
      if (context.aborted) return null
      const previous = details.get(key(table))
      if (failed.has(key(table)) || previous && Date.now() - previous.fetchedAt < DB_METADATA_TTL) continue
      try { details.set(key(table), await loadDetail(table)) }
      catch (cause) { failed.add(key(table)); if (!context.aborted) onError(cause) }
    }
    if (context.aborted) return null
    const schema: Record<string, SQLNamespace> = Object.create(null)
    const completion = (name: string, type: string, detail: string): Completion => ({ label: name, displayLabel: name, type, detail })
    for (const table of tables) {
      const namespace = namespaceKey(table.schema)
      if (!schema[namespace]) schema[namespace] = { self: completion(table.schema, 'namespace', 'Schema'), children: Object.create(null) }
      const group = schema[namespace] as { self: Completion; children: Record<string, SQLNamespace> }
      group.children[namespaceKey(table.name)] = {
        self: completion(table.name, 'type', `${table.schema} · ${table.kind}`),
        children: (details.get(key(table))?.columns ?? []).map(column => completion(column.name, 'property', `${column.type}${column.primaryKey ? ' · 主键' : ''}${column.comment ? ` · ${column.comment}` : ''}`))
      }
    }
    const primary = relevant[0]
    const defaultSchema = primary?.schema ?? ({ mysql: tables[0]?.schema, postgres: 'public', mssql: 'dbo', sqlite: 'main' })[kind]
    const result = await schemaCompletionSource({ dialect: sqlDialects[kind], schema, defaultSchema, defaultTable: primary?.name })(context)
    if (!result || context.aborted) return null
    // 元数据名称不一定是普通单词，统一转义插入，不能让补全改变 SQL 语句边界。
    return { ...result, options: result.options.map(option => ({ ...option, apply: quote(kind, option.displayLabel ?? option.label) })) }
  })
}
