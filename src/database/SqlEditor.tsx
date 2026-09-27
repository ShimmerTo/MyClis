import { useEffect, useRef, useState } from 'react'
import { Compartment, EditorState, Prec } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, placeholder } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { acceptCompletion, autocompletion, closeCompletion, completionKeymap, startCompletion } from '@codemirror/autocomplete'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { sql } from '@codemirror/lang-sql'
import { tags } from '@lezer/highlight'
import type { DbProfile, DbTable, DbTableCatalog } from '@shared/database'
import { createSqlCompletionSource, createSqlKeywordSource, sqlDialects } from './sqlCompletion'
import { dbError } from './store'

const highlighting = HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--accent)', fontWeight: '600' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--ok)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--warn)' },
  { tag: tags.comment, color: 'var(--text-dim)', fontStyle: 'italic' },
  { tag: [tags.typeName, tags.standard(tags.name)], color: 'var(--accent)' }
])

export default function SqlEditor(props: {
  profile: DbProfile
  catalog?: DbTableCatalog
  currentTable?: DbTable
  value: string
  disabled: boolean
  onChange: (value: string) => void
  onExecute: () => void
}): JSX.Element {
  const host = useRef<HTMLDivElement>(null), view = useRef<EditorView>()
  const latest = useRef(props)
  latest.current = props
  const completion = useRef(new Compartment()), editable = useRef(new Compartment())
  const [metadataError, setMetadataError] = useState('')
  const { profile, catalog, currentTable, value, disabled } = props
  useEffect(() => {
    const editor = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: latest.current.value,
        extensions: [
          lineNumbers(), history(), sql({ dialect: sqlDialects[profile.kind] }), syntaxHighlighting(highlighting),
          placeholder('输入 SQL，支持关键字、表名和字段补全'), EditorView.lineWrapping,
          EditorView.contentAttributes.of({ id: 'db-sql-editor', role: 'textbox', 'aria-label': 'SQL 编辑器', 'aria-multiline': 'true', 'aria-describedby': 'db-sql-help', spellcheck: 'false' }),
          completion.current.of([]), editable.current.of([]),
          Prec.highest(keymap.of([
            { key: 'Mod-Enter', run: () => { if (!latest.current.disabled) latest.current.onExecute(); return true } },
            { key: 'Ctrl-Space', run: startCompletion },
            { key: 'Tab', run: acceptCompletion },
            ...completionKeymap
          ])),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          EditorState.transactionFilter.of(transaction => transaction.newDoc.length <= 32768 ? transaction : []),
          EditorView.updateListener.of(update => { if (update.docChanged) latest.current.onChange(update.state.doc.toString()) })
        ]
      })
    })
    view.current = editor
    return () => { view.current = undefined; editor.destroy() }
  }, [profile.id, profile.kind])
  useEffect(() => {
    const editor = view.current
    if (!editor) return
    let alive = true
    setMetadataError('')
    const source = createSqlCompletionSource({
      kind: profile.kind, tables: catalog?.tables ?? [], currentTable,
      loadDetail: table => window.clichilds.database.tableDetail({ connectionId: profile.id, schema: table.schema, name: table.name, includeDdl: false }),
      onError: cause => { if (alive) setMetadataError(dbError(cause)) }
    })
    editor.dispatch({ effects: completion.current.reconfigure(autocompletion({
      override: [createSqlKeywordSource(profile.kind), source],
      activateOnTyping: true, defaultKeymap: false, maxRenderedOptions: 40
    })) })
    return () => { alive = false }
  }, [profile.id, profile.kind, catalog, currentTable])
  useEffect(() => {
    const editor = view.current
    if (!editor) return
    if (disabled) closeCompletion(editor)
    editor.dispatch({ effects: editable.current.reconfigure([EditorState.readOnly.of(disabled), EditorView.editable.of(!disabled)]) })
  }, [disabled])
  useEffect(() => {
    const editor = view.current
    if (editor && editor.state.doc.toString() !== value) editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } })
  }, [value])
  return <>
    <div className={`db-sql-editor ${disabled ? 'is-disabled' : ''}`} ref={host} />
    <p className="hint" id="db-sql-help">输入时自动提示 · Ctrl+Space 手动提示 · ↑↓ 选择 · Tab / Enter 补全 · Esc 关闭</p>
    {metadataError && <p className="hint" role="status">部分字段提示不可用：{metadataError}；仍可输入 SQL，强制刷新表信息后重试。</p>}
  </>
}
