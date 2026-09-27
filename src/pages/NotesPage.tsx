import { useEffect, useMemo, useState } from 'react'
import { DEFAULT_NOTES_DIR } from '@shared/types'
import type { Note, ThemeKind } from '@shared/types'
import { AppShell, Chips } from '../components/AppShell'
import type { View } from '../components/AppShell'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { NewTabModal } from '../components/NewTabModal'
import { NoteList, NOTE_DRAG_TYPE } from '../components/NoteList'
import { toast } from '../components/ToastHost'
import { buildNotesCopyText, bytesText, dirBase, ipcErrorText, notesForDir, notesShowDone, rememberNotesShowDone, sameDir } from '../notes'
import { useNoteIntake } from '../noteIntake'
import { applyTheme, saveConfig, useNotes, useSettings } from '../store'

interface PendingClear { workDir?: string; count: number; label: string }

function ActionIcon({ kind }: { kind: 'copy' | 'add' | 'clear' }): JSX.Element {
  return <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
    {kind === 'copy' ? <><rect x="5" y="5" width="8" height="9" rx="1" /><path d="M10 5V2H2v9h3" /></> :
      kind === 'add' ? <path d="M8 2v12M2 8h12" /> : <><path d="M2 4h12M6 4V2h4v2M4 4l1 10h6l1-10M7 6v6M9 6v6" /></>}
  </svg>
}

function NoteActions(props: { create: () => void; copy: () => void; clear: () => void }): JSX.Element {
  return <span className="notes-group-actions">
    <button type="button" className="note-act" title="复制所有" aria-label="复制所有" onClick={props.copy}><ActionIcon kind="copy" /></button>
    <button type="button" className="note-act" title="新建便签" aria-label="新建便签" onClick={props.create}><ActionIcon kind="add" /></button>
    <button type="button" className="note-act danger" title="清除便签" aria-label="清除便签" onClick={props.clear}><ActionIcon kind="clear" /></button>
  </span>
}

function NoteGroup(props: {
  dir: string; items: Note[]; all: Note[]; freshId: string
  create: () => void; copy: () => void; clear: () => void
  save: (id: string, patch: { title: string; content: string }) => Promise<void>
  execute: (note: Note) => void
  checkedIds: ReadonlySet<string>; onToggleSelection: (id: string) => void
}): JSX.Element {
  const intake = useNoteIntake(props.dir)
  const pathHint = sameDir(props.dir, DEFAULT_NOTES_DIR) ? '存储于全局数据目录' : props.dir
  return <section className={`notes-group ${intake.dragging ? 'dragging' : ''}`} tabIndex={0}
    onDragOver={(event) => { if (!event.dataTransfer.types.includes(NOTE_DRAG_TYPE)) intake.onDragOver(event) }}
    onDragLeave={intake.onDragLeave}
    onDrop={(event) => {
      event.preventDefault(); event.stopPropagation()
      if (!event.dataTransfer.types.includes(NOTE_DRAG_TYPE)) intake.onDrop(event)
    }}
    onPaste={intake.onPaste}>
    <div className="notes-group-head">
      <h2 title={pathHint}>{dirBase(props.dir)}</h2>
      <span className="hint notes-group-path" title={pathHint}>{pathHint}</span>
      <span className="spacer" />
      <span className="hint">{props.items.length}/{props.all.length} 条</span>
      <NoteActions create={props.create} copy={props.copy} clear={props.clear} />
    </div>
    {props.items.length === 0 ? <p className="hint notes-group-empty">{props.all.length ? '没有符合筛选条件的便签' : '暂无便签，可新建或将文件拖入此区域'}</p> :
      <NoteList notes={props.items} freshId={props.freshId} onSave={props.save} onExecute={props.execute}
        checkedIds={props.checkedIds} onToggleSelection={props.onToggleSelection}
        onRemove={(id) => void window.clichilds.notesRemove(id).catch((error: unknown) => toast(ipcErrorText(error)))} />}
  </section>
}

export default function NotesPage({ onNav }: { onNav: (v: View) => void }): JSX.Element {
  const { cfg, setCfg, clis } = useSettings()
  const notes = useNotes()
  const [query, setQuery] = useState('')
  const [showDone, setShowDone] = useState(notesShowDone)
  const [pending, setPending] = useState<PendingClear | null>(null)
  const [cleanup, setCleanup] = useState<{ removed: number; bytes: number } | null>(null)
  const [freshId, setFreshId] = useState('')
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [execute, setExecute] = useState<string[] | null>(null)
  const groups = useMemo(() => {
    const dirs = [DEFAULT_NOTES_DIR]
    for (const dir of [...(cfg?.workDirs ?? []), ...notes.map((note) => note.workDir)]) {
      if (dir.trim() && !dirs.some((item) => sameDir(item, dir))) dirs.push(dir)
    }
    const q = query.trim().toLowerCase()
    return dirs.map((dir) => {
      const all = notesForDir(notes, dir)
      return { dir, all, items: all.filter((note) => note.id === freshId || ((showDone || note.status !== 'done') &&
        (!q || `${note.title} ${note.content}`.toLowerCase().includes(q)))) }
    })
  }, [cfg?.workDirs, notes, query, showDone, freshId])
  const workDirs = groups.map((group) => group.dir).filter((dir) => !sameDir(dir, DEFAULT_NOTES_DIR))
  const visibleTodos = useMemo(() => groups.flatMap((group) => group.items.filter((note) => note.status === 'todo')), [groups])
  const visibleTodoIds = useMemo(() => new Set(visibleTodos.map((note) => note.id)), [visibleTodos])
  const checkedIds = useMemo(() => new Set([...selected].filter((id) => visibleTodoIds.has(id))), [selected, visibleTodoIds])
  const firstExecuteNote = visibleTodos.find((note) => note.id === execute?.[0])

  // 视图变化立即收窄有效选择，并移除旧 ID，避免取消筛选后隐式恢复勾选。
  useEffect(() => {
    setSelected((old) => {
      const next = new Set([...old].filter((id) => visibleTodoIds.has(id)))
      return next.size === old.size ? old : next
    })
  }, [visibleTodoIds])

  const toggleSelection = (id: string): void => {
    if (!visibleTodoIds.has(id)) return
    setSelected((old) => {
      const next = new Set(old)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const executeNote = (note: Note): void => {
    if (!visibleTodoIds.has(note.id)) { toast('只能发送当前可见的未处理便签'); return }
    setExecute([note.id])
  }
  const save = async (id: string, patch: { title: string; content: string }): Promise<void> => {
    await window.clichilds.notesUpdate({ id, ...patch })
    setFreshId('')
  }
  const create = (workDir = DEFAULT_NOTES_DIR): void => {
    void window.clichilds.notesAdd({ workDir, kind: 'text', content: '' })
      .then((note) => setFreshId(note.id)).catch((error: unknown) => toast(ipcErrorText(error)))
  }
  const copy = (items: Note[]): void => {
    if (!items.length) { toast('没有可复制的便签'); return }
    void navigator.clipboard.writeText(buildNotesCopyText(items))
      .then(() => toast(`已复制 ${items.length} 条便签`)).catch(() => toast('复制失败'))
  }
  const clear = (items: Note[], workDir?: string): void => {
    if (!items.length) { toast('没有可清除的便签'); return }
    setPending({ workDir, count: items.length, label: workDir ? dirBase(workDir) : '全部工作目录' })
  }
  const scanCleanup = (): void => {
    void window.clichilds.notesCleanupAssets({ dryRun: true }).then((result) => {
      if (result.removed === 0) toast('没有可清理的图片')
      else setCleanup(result)
    }).catch((error: unknown) => toast(ipcErrorText(error)))
  }

  return <AppShell view="notes" onNav={onNav} theme={cfg?.theme ?? 'dark'}
    onTheme={(theme: ThemeKind) => {
      applyTheme(theme)
      if (!cfg) return
      const next = { ...cfg, theme }; setCfg(next)
      void saveConfig(next).catch((error: unknown) => toast(ipcErrorText(error)))
    }} title="便签" desc="" chips={<Chips items={[{ text: `便签 ${notes.length}`, ok: notes.length > 0 }, { text: `目录 ${groups.length}`, ok: groups.length > 0 }]} />}>
    <div className="notes-page">
      <div className="notes-toolbar">
        <input className="note-input notes-search" value={query} placeholder="搜索标题或内容" onChange={(event) => setQuery(event.target.value)} />
        <label className="notes-showdone"><input type="checkbox" checked={showDone} onChange={(event) => { setShowDone(event.target.checked); rememberNotesShowDone(event.target.checked) }} />显示已完成</label>
        <button type="button" disabled={visibleTodos.length === 0 || checkedIds.size === visibleTodos.length}
          onClick={() => setSelected(new Set(visibleTodoIds))}>全选当前可见未处理</button>
        <button type="button" disabled={checkedIds.size === 0} onClick={() => setSelected(new Set())}>取消选择</button>
        <button type="button" className="primary" disabled={checkedIds.size === 0 || !cfg}
          onClick={() => setExecute(visibleTodos.filter((note) => checkedIds.has(note.id)).map((note) => note.id))}>已选 {checkedIds.size} 条 · 发送 CLI</button>
        <span className="spacer" />
        <button type="button" onClick={scanCleanup}>清理无引用图片</button>
        <NoteActions create={() => create()} copy={() => copy(notes)} clear={() => clear(notes)} />
      </div>
      {pending && <ConfirmDialog title="清除便签" confirmText="确认清除" onCancel={() => setPending(null)} onConfirm={() => {
        void window.clichilds.notesClear(pending.workDir ? { workDir: pending.workDir } : undefined).then(() => {
          setPending(null); toast('已清除便签，原内容已备份')
        }).catch((error: unknown) => toast(ipcErrorText(error)))
      }}>将清除 {pending.label} 下全部 {pending.count} 条便签（包含隐藏项），原内容备份为 notes.json.bak。</ConfirmDialog>}
      {cleanup && <ConfirmDialog title="清理无引用图片" confirmText="确认清理" onCancel={() => setCleanup(null)} onConfirm={() => {
        void window.clichilds.notesCleanupAssets({ dryRun: false }).then((result) => {
          setCleanup(null); toast(`已清理 ${result.removed} 个图片，释放 ${bytesText(result.bytes)}`)
        }).catch((error: unknown) => toast(ipcErrorText(error)))
      }}>将删除 {cleanup.removed} 个无便签引用且超过 7 天的图片，共 {bytesText(cleanup.bytes)}。已复制到其它地方的路径可能失效。</ConfirmDialog>}
      {groups.map((group) =>
        <NoteGroup key={group.dir} {...group} freshId={freshId} create={() => create(group.dir)}
          checkedIds={checkedIds} onToggleSelection={toggleSelection}
          copy={() => copy(group.all)} clear={() => clear(group.all, group.dir)} save={save} execute={executeNote} />)}
    </div>
    {execute && cfg && <NewTabModal title="执行便签" submitLabel="启动" workDirs={workDirs}
      hint="将所选便签合并为一条任务，在选定工作目录运行；便签保留原归属"
      profiles={cfg.cliConfigs} clis={clis}
      defaultWorkDir={firstExecuteNote && !sameDir(firstExecuteNote.workDir, DEFAULT_NOTES_DIR) ? firstExecuteNote.workDir :
        workDirs.find((dir) => sameDir(dir, cfg.launch.workDir)) ?? workDirs[0] ?? ''}
      defaultProfileId={firstExecuteNote?.execution?.profileId ?? cfg.launch.mainCliId}
      notes={visibleTodos} allowNotes allowCrossDirNotes initialNoteIds={execute}
      onClose={() => setExecute(null)} onStart={async (workDir, profileId, _cli, initialPrompt, noteIds) => {
        if (!noteIds?.length || noteIds.some((id) => !execute.includes(id) || !visibleTodoIds.has(id))) {
          throw new Error('所选便签已变化，请重新选择当前可见的未处理便签')
        }
        if (!workDirs.some((dir) => sameDir(dir, workDir))) throw new Error('请选择真实工作目录')
        await window.clichilds.sessionStart({ workDir, profileId, initialPrompt, noteIds, allowCrossDirNotes: true })
        setSelected(new Set()); setExecute(null); toast('CLI 已启动')
      }} />}
  </AppShell>
}
