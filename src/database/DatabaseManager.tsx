import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DbBrowseQuery, DbProfile, DbResult, DbTable, DbTableCatalog, DbTableDetail, DbUiRequest } from '@shared/database'
import { DB_METADATA_TTL, canUseRowKeyType } from '@shared/database'
import { formatLocalDate } from '../components/approval'
import { dbError, requestKey, showDatabaseRequest, stateLabels, useDatabase } from './store'
import { formatRowsInsertSql, formatRowsJson } from './rowClipboard'
import SqlEditor from './SqlEditor'

const active = (request?: Pick<DbUiRequest, 'state'>) => !!request && ['checking', 'pending_approval', 'executing'].includes(request.state)
const tableKey = (table: DbTable) => JSON.stringify([table.schema, table.name])

function isSystemSchema(kind: DbProfile['kind'], schema: string): boolean {
  const name = schema.toLowerCase()
  switch (kind) {
    case 'postgres': return name === 'information_schema' || name.startsWith('pg_')
    case 'mssql': return name === 'sys' || name === 'information_schema'
    case 'mysql': return ['information_schema', 'performance_schema', 'mysql', 'sys'].includes(name)
    case 'sqlite': return false
  }
}

function isSystemTable(kind: DbProfile['kind'], table: DbTable): boolean {
  return table.kind.startsWith('SYSTEM ') || (kind === 'sqlite' ? table.name.toLowerCase().startsWith('sqlite_') : isSystemSchema(kind, table.schema))
}

function usePanelRequest() {
  const { snapshot } = useDatabase()
  const [request, setRequest] = useState<DbUiRequest>()
  const [error, setError] = useState(''), [submitting, setSubmitting] = useState(false)
  const mounted = useRef(false), locked = useRef(false), latest = useRef<DbUiRequest>()
  const live = request && snapshot?.requests.find(item => requestKey(item) === requestKey(request))
  const current = request ? { ...request, ...live } : undefined
  latest.current = current
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      const pending = latest.current
      if (pending && ['checking', 'pending_approval'].includes(pending.state)) {
        void window.clichilds.database.requestCancel({ sessionId: pending.sessionId, requestId: pending.requestId }).catch(cause => console.error(dbError(cause)))
      }
    }
  }, [])
  const sessionId = current?.sessionId, requestId = current?.requestId, state = current?.state
  useEffect(() => {
    if (!sessionId || !requestId) return
    if (state === 'pending_approval') showDatabaseRequest(requestKey({ sessionId, requestId }))
    if (state !== 'succeeded') return
    let alive = true
    void window.clichilds.database.requestInspect({ sessionId, requestId }).then(value => { if (alive) setRequest(value) }).catch(cause => { if (alive) setError(dbError(cause)) })
    return () => { alive = false }
  }, [sessionId, requestId, state])
  const run = useCallback(async (operation: () => Promise<DbUiRequest>) => {
    if (locked.current || active(latest.current)) return
    locked.current = true; setSubmitting(true); setError(''); setRequest(undefined)
    try {
      const value = await operation()
      if (mounted.current) { latest.current = value; setRequest(value) }
      else if (['checking', 'pending_approval'].includes(value.state)) await window.clichilds.database.requestCancel({ sessionId: value.sessionId, requestId: value.requestId })
    } catch (cause) { if (mounted.current) setError(dbError(cause)); else console.error(dbError(cause)) }
    finally { locked.current = false; if (mounted.current) setSubmitting(false) }
  }, [])
  const cancel = async () => {
    if (!current) return
    try { await window.clichilds.database.requestCancel({ sessionId: current.sessionId, requestId: current.requestId }) }
    catch (cause) { setError(dbError(cause)) }
  }
  return { current, error, submitting, busy: submitting || active(current), run, cancel }
}

type PanelRequest = ReturnType<typeof usePanelRequest>

function RequestStatus({ execution }: { execution: PanelRequest }): JSX.Element {
  const { current, error, submitting, cancel } = execution
  return <>
    {error && <p className="error" role="alert">{error}</p>}
    {submitting && <p className="hint" role="status"><span className="db-spinner" />正在准备请求…</p>}
    {current && <div className="db-request-status" role="status">
      <span>{active(current) && <span className="db-spinner" />}{stateLabels[current.state]}</span>
      {current.state === 'pending_approval' && <button onClick={() => showDatabaseRequest(requestKey(current))}>查看并确认本次 SQL</button>}
      {active(current) && <button onClick={() => { void cancel() }}>取消请求</button>}
      {current.error && <span className="error">{current.error.message}</span>}
      {current.state === 'unknown' && <strong className="error">不要直接重试，请先核验数据库实际结果。</strong>}
      {current.result && <span className="hint">返回 {current.result.rows.length} 行 · 影响 {current.result.affectedRows} 行 · {current.result.durationMs} ms</span>}
    </div>}
    {current?.result?.truncated && <p className="error" role="status">结果达到行数或大小上限，展示不完整；可缩小查询范围或减少所选字段。</p>}
  </>
}

interface GridSelection {
  selected: ReadonlySet<number>
  onToggle: (index: number, checked: boolean) => void
  onToggleAll: (checked: boolean) => void
}

function DataGrid({ result, sort, onSort, disabled = false, selection }: {
  result: DbResult
  sort?: DbBrowseQuery['sort']
  onSort?: (column: string) => void
  disabled?: boolean
  selection?: GridSelection
}): JSX.Element {
  const allCheckbox = useRef<HTMLInputElement>(null)
  const count = selection?.selected.size ?? 0
  const allSelected = result.rows.length > 0 && count === result.rows.length
  const partlySelected = count > 0 && !allSelected
  useEffect(() => { if (allCheckbox.current) allCheckbox.current.indeterminate = partlySelected }, [partlySelected])
  if (!result.columns.length) return <p className="hint">该语句没有返回数据表格。</p>
  return <div className="db-data-grid" tabIndex={0} aria-label="数据结果表格">
    <table>
      <thead><tr>
        {selection && <th className="db-row-select" scope="col"><input ref={allCheckbox} type="checkbox" aria-label="全选当前页" aria-checked={partlySelected ? 'mixed' : allSelected} checked={allSelected} disabled={disabled || !result.rows.length} onChange={event => selection.onToggleAll(event.target.checked)} /></th>}
        {result.columns.map((column, index) => <th key={`${index}:${column}`} scope="col" aria-sort={onSort ? sort?.column === column ? sort.direction === 'asc' ? 'ascending' : 'descending' : 'none' : undefined}>
          {onSort ? <button disabled={disabled} title={`按 ${column} ${sort?.column === column && sort.direction === 'asc' ? '降序' : '升序'}排列`} onClick={() => onSort(column)}>{column}<span aria-hidden="true">{sort?.column === column ? sort.direction === 'asc' ? ' ↑' : ' ↓' : ' ↕'}</span></button> : column}
        </th>)}
      </tr></thead>
      <tbody>{result.rows.map((row, index) => <tr key={index}>
        {selection && <td className="db-row-select"><input type="checkbox" aria-label={`选择第 ${index + 1} 行`} checked={selection.selected.has(index)} disabled={disabled} onChange={event => selection.onToggle(index, event.target.checked)} /></td>}
        {row.map((cell, column) => <td key={column} title={cell === null ? 'NULL' : String(cell)}>{cell === null ? <span className="db-null">NULL</span> : typeof cell === 'boolean' ? String(cell) : cell}</td>)}
      </tr>)}</tbody>
    </table>
    {!result.rows.length && <div className="empty">没有符合条件的数据。</div>}
  </div>
}

function rowDeleteReason(kind: DbProfile['kind'], table: DbTable, detail: DbTableDetail | undefined, result: DbResult | undefined, indexes: readonly number[]): string {
  if (!['BASE TABLE', 'PARTITIONED TABLE', 'PARTITION'].includes(table.kind)) return '此对象不是可删除的普通表或分区；仍可复制数据。'
  if (!detail) return '表结构尚不可用，暂不能校验主键或删除；仍可复制 JSON。'
  if (!['BASE TABLE', 'PARTITIONED TABLE', 'PARTITION'].includes(detail.table.kind)) return '此对象类型不支持删除；仍可复制数据。'
  const keys = detail.columns.filter(column => column.primaryKey)
  if (!keys.length) return '此表没有主键，不能删除选中行；仍可复制数据。'
  if (keys.some(column => !canUseRowKeyType(kind, column.type))) return '主键类型无法可靠往返，不能删除；仍可复制数据。'
  if (!result) return '请等待表数据加载完成。'
  const positions = keys.map(key => result.columns.indexOf(key.name))
  if (positions.some((position, index) => position < 0 || result.columns.lastIndexOf(keys[index].name) !== position)) return '结果缺少完整且唯一的主键字段，不能删除。'
  if (positions.some(position => result.nonRoundTripColumns?.includes(position))) return '主键展示值已转换类型或精度，不能用于删除定位；仍可复制数据。'
  if (indexes.some(index => !result.rows[index] || positions.some(position => result.rows[index][position] == null))) return '选中行包含空主键或主键值缺失，不能删除；仍可复制数据。'
  return ''
}

// 加载中的原因只放按钮 title，不再占一行说明文案；未选中行由按钮禁用表达。
const transientDeleteReasons = new Set(['请等待表数据加载完成。'])

function TableData({ profile, table, detail, detailError }: { profile: DbProfile; table: DbTable; detail?: DbTableDetail; detailError?: string }): JSX.Element {  // 写请求独立于浏览请求，审批和执行期间不覆盖已展示的结果。
  const execution = usePanelRequest(), deletion = usePanelRequest()
  const [offsets, setOffsets] = useState([0]), [limit, setLimit] = useState(100)
  const [sort, setSort] = useState<DbBrowseQuery['sort']>(), [refresh, setRefresh] = useState(0)
  const [selection, setSelection] = useState<{ source: string; indexes: Set<number> }>()
  const [copying, setCopying] = useState(false), [copyFeedback, setCopyFeedback] = useState<{ error: boolean; text: string }>()
  const copyEpoch = useRef(0), copyLock = useRef(false)
  const browseRequest = useRef<{ key: string; requestId: string }>()
  const handledDelete = useRef<string>(), deletionSource = useRef<string>()
  const postDeleteRefresh = useRef<{ requestId?: string }>()
  const offset = offsets[offsets.length - 1]
  const browseKey = JSON.stringify([profile.id, table.schema, table.name, offset, limit, sort, refresh])
  const { run } = execution
  const clearSelection = useCallback(() => {
    setSelection(undefined); setCopyFeedback(undefined); copyEpoch.current++
  }, [])
  useEffect(() => () => { copyEpoch.current++ }, [])
  useEffect(() => {
    void run(() => {
      const requestId = crypto.randomUUID()
      browseRequest.current = { key: browseKey, requestId }
      if (postDeleteRefresh.current && !postDeleteRefresh.current.requestId) postDeleteRefresh.current.requestId = requestId
      return window.clichilds.database.browseTable({ requestId, connectionId: profile.id, schema: table.schema, name: table.name, offset, limit, sort })
    })
  }, [profile.id, table.schema, table.name, offset, limit, sort, browseKey, run])
  const current = execution.current
  // 查询参数和来源 requestId 都须匹配，翻页后的首帧也不能操作上一页的数据。
  const source = browseRequest.current?.key === browseKey && current?.requestId === browseRequest.current?.requestId && current?.state === 'succeeded' ? current : undefined
  const result = source?.result
  const sourceKey = source ? requestKey(source) : undefined
  const selectedIndexes = useMemo(() => result && selection && selection.source === sourceKey
    ? [...selection.indexes].filter(index => index >= 0 && index < result.rows.length).sort((a, b) => a - b) : [], [result, selection, sourceKey])
  const selected = useMemo(() => new Set(selectedIndexes), [selectedIndexes])
  const metadata = detail?.connectionId === profile.id && tableKey(detail.table) === tableKey(table) ? detail : undefined
  const succeededDelete = deletion.current?.state === 'succeeded' ? requestKey(deletion.current) : undefined
  const busy = execution.busy || deletion.busy || browseRequest.current?.key !== browseKey || (!!succeededDelete && handledDelete.current !== succeededDelete)
  const unverifiedDelete = deletion.current?.state === 'unknown' && deletionSource.current === sourceKey
  const deleteReason = unverifiedDelete ? '上次删除结果待核验，请先核验数据库并刷新数据，勿直接重试。'
    : detailError ? '表结构读取失败，无法校验主键；仍可复制 JSON。' : rowDeleteReason(profile.kind, table, metadata, result, selectedIndexes)

  useEffect(() => {
    if (!succeededDelete || handledDelete.current === succeededDelete) return
    handledDelete.current = succeededDelete
    clearSelection()
    postDeleteRefresh.current = {}
    setRefresh(value => value + 1)
  }, [succeededDelete, clearSelection])
  useEffect(() => {
    if (!current || current.requestId !== postDeleteRefresh.current?.requestId || active(current)) return
    if (current.state === 'succeeded' && !result) return // 等待 requestInspect 取回行数据。
    postDeleteRefresh.current = undefined
    if (current.state === 'succeeded' && result?.rows.length === 0 && offset > 0) {
      clearSelection()
      setOffsets(value => value.slice(0, -1))
    }
  }, [current?.requestId, current?.state, result, offset, clearSelection])

  const changeBrowse = (change: () => void) => {
    if (busy) return
    clearSelection(); change()
  }
  const updateSelection = (indexes: Set<number>) => {
    if (busy || !sourceKey || !result) return
    setCopyFeedback(undefined); copyEpoch.current++
    setSelection({ source: sourceKey, indexes })
  }
  const copyRows = async (format: 'json' | 'insert') => {
    if (busy || !result || !selectedIndexes.length || copyLock.current) return
    copyLock.current = true; setCopying(true); setCopyFeedback(undefined)
    const epoch = ++copyEpoch.current
    let formatted = false
    try {
      if (format === 'insert' && !metadata) throw new Error('表结构尚不可用，请等待字段类型加载。')
      const text = format === 'json' ? formatRowsJson(result, selectedIndexes) : formatRowsInsertSql(profile.kind, table, metadata!.columns, result, selectedIndexes)
      formatted = true
      await navigator.clipboard.writeText(text)
      if (epoch === copyEpoch.current) setCopyFeedback({ error: false, text: `已复制 ${selectedIndexes.length} 行${format === 'json' ? ' JSON' : ' INSERT SQL'}。` })
    } catch (cause) {
      if (epoch === copyEpoch.current) setCopyFeedback({ error: true, text: formatted ? '复制失败，请检查剪贴板权限后重试。' : `格式化失败：${dbError(cause)} 剪贴板未更改。` })
    } finally { copyLock.current = false; setCopying(false) }
  }
  const deleteRows = () => {
    if (busy || deleteReason || !source || !result || !selectedIndexes.length) return
    const sourceIdentity = { sessionId: source.sessionId, requestId: source.requestId }
    void deletion.run(() => {
      deletionSource.current = requestKey(sourceIdentity)
      return window.clichilds.database.deleteRows({ requestId: crypto.randomUUID(), source: sourceIdentity, rowIndexes: selectedIndexes })
    })
  }
  const canNext = !!result && result.rows.length > 0 && (result.rows.length === limit || result.truncated)
  return <div className="db-data-pane">
    <div className="db-manager-toolbar">
      {busy && <span className="db-spinner" role="status" aria-label="正在查询" />}
      <span className="spacer" />
      <button disabled={busy} onClick={() => changeBrowse(() => setRefresh(value => value + 1))}>刷新数据</button>
      <label>每页 <select aria-label="每页行数" value={limit} disabled={busy} onChange={event => changeBrowse(() => { setLimit(Number(event.target.value)); setOffsets([0]) })}><option value={50}>50</option><option value={100}>100</option><option value={200}>200</option><option value={500}>500</option></select> 行</label>
    </div>
    <div className="db-manager-toolbar db-row-actions" aria-label="选中行操作">
      <span className="hint" role="status">选中 {selectedIndexes.length} 行</span><span className="spacer" />
      <button disabled={busy || copying || !selectedIndexes.length} onClick={() => { void copyRows('json') }}>复制 JSON</button>
      <button disabled={busy || copying || !selectedIndexes.length || !metadata} title={!metadata ? '等待表结构加载后生成 INSERT SQL' : undefined} onClick={() => { void copyRows('insert') }}>复制 INSERT SQL</button>
      <button disabled={busy || !!deleteReason || !selectedIndexes.length} title={deleteReason} onClick={deleteRows}>删除选中行</button>
    </div>
    {copyFeedback && <p className={copyFeedback.error ? 'error db-row-feedback' : 'db-success db-row-feedback'} role={copyFeedback.error ? 'alert' : 'status'}>{copyFeedback.text}</p>}
    {deleteReason && !transientDeleteReasons.has(deleteReason) && <p className="hint db-row-feedback">{deleteReason}</p>}
    <RequestStatus execution={execution} />
    <RequestStatus execution={deletion} />
    {result && <DataGrid result={result} sort={sort} disabled={busy} onSort={column => changeBrowse(() => { setSort({ column, direction: sort?.column === column && sort.direction === 'asc' ? 'desc' : 'asc' }); setOffsets([0]) })} selection={{
      selected,
      onToggle: (index, checked) => { const indexes = new Set(selected); if (checked) indexes.add(index); else indexes.delete(index); updateSelection(indexes) },
      onToggleAll: checked => updateSelection(new Set(checked ? result.rows.map((_, index) => index) : []))
    }} />}
    <div className="db-manager-toolbar db-pagination">
      <span className="hint">第 {offsets.length} 页{result && result.rows.length > 0 ? ` · 第 ${offset + 1}–${offset + result.rows.length} 行` : ''}</span><span className="spacer" />
      <button disabled={busy || offsets.length === 1} onClick={() => changeBrowse(() => setOffsets(value => value.slice(0, -1)))}>上一页</button>
      <button disabled={busy || !canNext} onClick={() => changeBrowse(() => setOffsets(value => [...value, offset + result!.rows.length]))}>下一页</button>
    </div>
  </div>
}

function SqlConsole({ profile, catalog, currentTable, sql, onSqlChange }: {
  profile: DbProfile
  catalog?: DbTableCatalog
  currentTable?: DbTable
  sql: string
  onSqlChange: (value: string) => void
}): JSX.Element {
  const execution = usePanelRequest()
  const execute = () => {
    if (!sql.trim() || execution.busy) return
    void execution.run(() => window.clichilds.database.submitQuery({ requestId: crypto.randomUUID(), connectionId: profile.id, sql, params: [], reason: '本机管理面板：手动执行 SQL' }))
  }
  return <div className="db-sql-console">
    <label htmlFor="db-sql-editor">SQL 编辑器</label>
    <SqlEditor profile={profile} catalog={catalog} currentTable={currentTable} value={sql} disabled={execution.busy} onChange={onSqlChange} onExecute={execute} />
    <div className="db-manager-toolbar"><span className="hint">Ctrl+Enter 执行 · 结果最多 1000 行 / 256 KiB</span><span className="spacer" /><button className="primary" disabled={!sql.trim() || execution.busy} onClick={execute}>{execution.busy ? '处理中…' : '执行 SQL'}</button></div>
    <RequestStatus execution={execution} />
    {execution.current?.state === 'succeeded' && execution.current.result && <DataGrid result={execution.current.result} />}
  </div>
}

function TableDefinition({ detail, tab }: { detail: DbTableDetail; tab: 'structure' | 'ddl' }): JSX.Element {
  const [copied, setCopied] = useState(false), [copyError, setCopyError] = useState('')
  if (tab === 'ddl') return <div className="db-definition">
    <div className="db-manager-toolbar"><span className="hint">建表 / 对象定义</span><span className="spacer" /><button disabled={!detail.ddl} onClick={() => { void navigator.clipboard.writeText(detail.ddl).then(() => { setCopied(true); setCopyError('') }).catch(() => setCopyError('复制失败，请手动选择并复制。')) }}>{copied ? '已复制' : '复制 SQL'}</button></div>
    {copyError && <p className="error">{copyError}</p>}
    <pre tabIndex={0}>{detail.ddl || '此对象暂时无法提供定义。'}</pre>
  </div>
  return <div className="db-definition">
    {detail.table.comment && <p>{detail.table.comment}</p>}
    <div className="db-data-grid" tabIndex={0}><table><thead><tr><th>字段</th><th>类型</th><th>可空</th><th>主键</th><th>默认值</th><th>说明</th></tr></thead><tbody>{detail.columns.map(column => <tr key={column.name}><td>{column.name}</td><td>{column.type}</td><td>{column.nullable ? '是' : '否'}</td><td>{column.primaryKey ? '是' : ''}</td><td>{column.defaultValue ?? '—'}</td><td>{column.comment}</td></tr>)}</tbody></table></div>
  </div>
}

export default function DatabaseManager({ profile, onBack }: { profile: DbProfile; onBack: () => void }): JSX.Element {
  const [catalog, setCatalog] = useState<DbTableCatalog>(), [detail, setDetail] = useState<DbTableDetail>()
  const [error, setError] = useState(''), [detailError, setDetailError] = useState('')
  const [loading, setLoading] = useState(false), [detailLoading, setDetailLoading] = useState(false)
  const [search, setSearch] = useState(''), [selected, setSelected] = useState<string>()
  const [showSystemObjects, setShowSystemObjects] = useState(false)
  const [expandedSchemas, setExpandedSchemas] = useState(() => new Map<string, boolean>())
  // 搜索只临时展开匹配组，不覆盖用户在普通列表中的折叠选择。
  const [searchExpandedSchemas, setSearchExpandedSchemas] = useState(() => new Map<string, boolean>())
  const [sql, setSql] = useState('')
  const [tab, setTab] = useState<'data' | 'structure' | 'ddl' | 'sql'>('data')
  const alive = useRef(false), refreshLock = useRef(false)
  const load = useCallback(async (force = false) => {
    if (refreshLock.current) return
    refreshLock.current = true; setLoading(true); setError('')
    try {
      const value = await window.clichilds.database.listTables({ connectionId: profile.id, force })
      if (alive.current) {
        setCatalog(value)
        setSelected(old => value.tables.some(table => tableKey(table) === old) ? old : undefined)
      }
    } catch (cause) { if (alive.current) setError(dbError(cause)) }
    finally { refreshLock.current = false; if (alive.current) setLoading(false) }
  }, [profile.id])
  useEffect(() => {
    alive.current = true
    void load()
    return () => { alive.current = false }
  }, [load])
  useEffect(() => {
    const delay = catalog ? Math.max(1000, catalog.fetchedAt + DB_METADATA_TTL - Date.now()) : DB_METADATA_TTL
    const timer = window.setTimeout(() => { void load() }, error ? DB_METADATA_TTL : delay)
    return () => window.clearTimeout(timer)
  }, [catalog, error, load, loading])
  const selectedTable = catalog?.tables.find(table => tableKey(table) === selected)
  const includeDdl = tab === 'ddl'
  useEffect(() => {
    setDetail(undefined); setDetailError('')
    if (!selectedTable) { setDetailLoading(false); return }
    let current = true
    setDetailLoading(true)
    void window.clichilds.database.tableDetail({ connectionId: profile.id, schema: selectedTable.schema, name: selectedTable.name, includeDdl }).then(value => { if (current) setDetail(value) }).catch(cause => { if (current) setDetailError(dbError(cause)) }).finally(() => { if (current) setDetailLoading(false) })
    return () => { current = false }
  }, [profile.id, selectedTable, catalog?.fetchedAt, includeDdl])
  const query = search.trim().toLocaleLowerCase()
  const { groups, visibleCount, hiddenSystemCount } = useMemo(() => {
    // schema 和 name 始终使用独立字段，Map 可安全处理 __proto__ 等特殊名称。
    const bySchema = new Map<string, { schema: string; system: boolean; tables: DbTable[] }>()
    let visibleCount = 0, hiddenSystemCount = 0
    for (const table of catalog?.tables ?? []) {
      if (!showSystemObjects && isSystemTable(profile.kind, table)) {
        hiddenSystemCount++
        continue
      }
      if (query && ![table.schema, table.name, table.comment, `${table.schema}.${table.name}`].some(value => value.toLocaleLowerCase().includes(query))) continue
      let group = bySchema.get(table.schema)
      if (!group) {
        group = { schema: table.schema, system: isSystemSchema(profile.kind, table.schema), tables: [] }
        bySchema.set(table.schema, group)
      }
      group.tables.push(table)
      visibleCount++
    }
    // 业务 schema 放在系统 schema 之前，各组内部保留元数据原有顺序。
    const groups = [...bySchema.values()].sort((left, right) => Number(left.system) - Number(right.system))
    return { groups, visibleCount, hiddenSystemCount }
  }, [catalog, profile.kind, query, showSystemObjects])
  const toggleSchema = (schema: string, expanded: boolean) => {
    const update = query ? setSearchExpandedSchemas : setExpandedSchemas
    update(previous => new Map(previous).set(schema, !expanded))
  }
  return <section className="db-manager" aria-label={`${profile.name} 管理面板`}>
    <header className="db-manager-header">
      <button onClick={onBack}>返回连接</button><div><h2>{profile.name}</h2><p className="hint">{profile.kind} · {profile.kind === 'sqlite' ? profile.filename : `${profile.host}:${profile.port} / ${profile.database}`}</p></div><span className="spacer" />
      <div className="db-cache-status"><span className="hint">表信息每 5 分钟刷新{catalog ? ` · ${formatLocalDate(catalog.fetchedAt)}` : ''}</span><button disabled={loading} onClick={() => { void load(true) }}>{loading && <span className="db-spinner" />}{loading ? '刷新中…' : '强制刷新'}</button></div>
    </header>
    {error && <p className="error" role="alert">{error}{catalog && '；当前仍显示上次缓存的信息。'}</p>}
    <div className="db-manager-layout">
      <aside className="db-table-sidebar">
        <input type="search" aria-label="搜索表" placeholder="搜索表名、schema、说明" value={search} onChange={event => { setSearch(event.target.value); setSearchExpandedSchemas(new Map()) }} />
        <label className="db-check db-system-toggle"><input type="checkbox" checked={showSystemObjects} onChange={event => {
          const show = event.target.checked
          setShowSystemObjects(show)
          if (!show && selectedTable && isSystemTable(profile.kind, selectedTable)) setSelected(undefined)
        }} />显示系统对象</label>
        <p className="hint">{catalog ? `${visibleCount} / ${catalog.tables.length} 个表或视图 · 已隐藏 ${hiddenSystemCount} 个系统对象` : loading ? '正在读取表…' : '未读取到表信息'}</p>
        <nav aria-label="数据库表列表">
          {groups.map(group => {
            const expanded = query ? searchExpandedSchemas.get(group.schema) ?? true : expandedSchemas.get(group.schema) ?? false
            return <div className="db-schema-group" key={group.schema}>
              <button type="button" className="db-schema-toggle" aria-expanded={expanded} onClick={() => toggleSchema(group.schema, expanded)}>
                <span className="db-schema-chevron" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
                <strong title={group.schema}>{group.schema || '默认 schema'}</strong>
                {group.system && <span className="db-schema-badge">系统</span>}
                <span className="db-schema-count">{group.tables.length}</span>
              </button>
              {expanded && <div className="db-schema-tables">
                {group.tables.map(table => <button type="button" className={`db-table-item ${tableKey(table) === selected ? 'on' : ''}`} key={tableKey(table)} title={`${table.schema}.${table.name}\n${table.comment}`} onClick={() => { setSelected(tableKey(table)); if (tab === 'sql') setTab('data') }}><strong>{table.name}</strong></button>)}
              </div>}
            </div>
          })}
          {catalog && !visibleCount && <div className="empty">{query ? '没有匹配的表。' : '没有可见的表或视图。'}{hiddenSystemCount > 0 && ' 可勾选「显示系统对象」查看系统表。'}</div>}
        </nav>
      </aside>
      <div className="db-table-workspace">
        <div className="db-manager-tabs" role="tablist" aria-label="表管理视图">
          {(['data', 'structure', 'ddl', 'sql'] as const).map(value => <button role="tab" key={value} aria-selected={tab === value} className={tab === value ? 'on' : ''} onClick={() => setTab(value)}>{({ data: '表数据', structure: '表结构', ddl: '建表语句', sql: 'SQL 查询' })[value]}</button>)}
        </div>
        {tab === 'sql' ? <SqlConsole profile={profile} catalog={catalog} currentTable={selectedTable} sql={sql} onSqlChange={setSql} /> : !selectedTable ? <div className="empty">从左侧选择一张表查看数据和结构，或打开「SQL 查询」。</div> : <>
          <h3 className="db-selected-table">{selectedTable.schema}.{selectedTable.name}</h3>
          {tab === 'data' ? <TableData key={`${profile.id}:${tableKey(selectedTable)}`} profile={profile} table={selectedTable} detail={detailLoading || detailError ? undefined : detail} detailError={detailError} /> : detailLoading ? <p className="hint"><span className="db-spinner" />正在读取表结构…</p> : detailError ? <p className="error" role="alert">{detailError}</p> : detail ? <TableDefinition key={`${tableKey(selectedTable)}:${detail.fetchedAt}:${tab}`} detail={detail} tab={tab} /> : null}
        </>}
      </div>
    </div>
  </section>
}
