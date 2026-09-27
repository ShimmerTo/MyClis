import { useState } from 'react'
import type { Note } from '@shared/types'
import { useHistory, useSessions } from '../store'
import { ipcErrorText } from '../notes'
import { showNoteSession } from '../noteSessionNavigation'
import { PHASE_LABEL } from '../display'
import { NoteItem } from './NoteItem'
import { toast } from './ToastHost'

export const NOTE_DRAG_TYPE = 'application/x-myclis-note'

export function NoteList(props: {
  notes: Note[]
  freshId?: string
  onSave: (id: string, patch: { title: string; content: string }) => Promise<void>
  onRemove: (id: string) => void
  onExecute?: (note: Note) => void
  /** 管理页批量选择；不传则保留浮窗原有布局 */
  checkedIds?: ReadonlySet<string>
  onToggleSelection?: (id: string) => void
}): JSX.Element {
  const sessions = useSessions()
  const history = useHistory()
  const [over, setOver] = useState('')
  const [sorting, setSorting] = useState(false)
  return <>{props.notes.map((note) => {
    const link = note.execution
    const session = link ? sessions.find((item) => item.role === 'main' && (item.workspaceSessionId ?? item.id) === link.workspaceSessionId) : undefined
    const record = link ? history.find((item) => (item.workspaceSessionId ?? item.sessionId) === link.workspaceSessionId) : undefined
    const state = session ? session.runtime.approval ? '等待审批' : PHASE_LABEL[session.runtime.phase] : record ? '已结束' : '记录不可用'
    return <div key={note.id} className={`note-sort-row ${over === note.id ? 'drop-target' : ''}`}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes(NOTE_DRAG_TYPE)) return
        event.preventDefault(); event.stopPropagation()
        event.dataTransfer.dropEffect = 'move'
        setOver(note.id)
      }}
      onDragLeave={() => setOver('')}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes(NOTE_DRAG_TYPE)) return
        event.preventDefault(); event.stopPropagation(); setOver('')
        const id = event.dataTransfer.getData(NOTE_DRAG_TYPE)
        const from = props.notes.findIndex((item) => item.id === id)
        if (from < 0 || id === note.id || sorting) return
        const ids = props.notes.map((item) => item.id)
        const to = ids.indexOf(note.id)
        ids.splice(from, 1); ids.splice(to, 0, id)
        setSorting(true)
        void window.clichilds.notesReorder({ workDir: note.workDir, ids })
          .catch((error: unknown) => toast(ipcErrorText(error))).finally(() => setSorting(false))
      }}>
      <NoteItem note={note} autoEdit={props.freshId === note.id}
        leading={<>
          {props.checkedIds && props.onToggleSelection && <input type="checkbox" className="note-select"
            aria-label={`选择便签：${note.title}`} title={note.status === 'todo' ? '选择便签' : '仅未处理便签可选择'}
            checked={note.status === 'todo' && props.checkedIds.has(note.id)} disabled={note.status !== 'todo'}
            onClick={(event) => event.stopPropagation()}
            onChange={() => { if (note.status === 'todo') props.onToggleSelection?.(note.id) }} />}
          <button type="button" className="note-drag" title="拖动排序" aria-label="拖动排序" draggable={!sorting}
            onDragStart={(event) => { event.dataTransfer.setData(NOTE_DRAG_TYPE, note.id); event.dataTransfer.effectAllowed = 'move' }}
            onDragEnd={() => setOver('')}>
            <svg width="12" height="16" viewBox="0 0 12 16" aria-hidden="true"><path d="M4 3v1m4-1v1M4 7v1m4-1v1M4 11v1m4-1v1" stroke="currentColor" strokeWidth="2" /></svg>
          </button>
        </>}
        onSave={(patch) => props.onSave(note.id, patch)} onRemove={() => props.onRemove(note.id)}
        onExecute={props.onExecute ? () => props.onExecute?.(note) : undefined}
        trailing={link ? <button type="button" className="note-execution" title={session ? '定位进行中的任务' : '定位历史会话并查看对话'}
          onClick={() => {
            if (!session && !record) { toast('关联会话记录已不可用'); return }
            showNoteSession(link.workspaceSessionId)
          }}>{session?.profileLabel ?? record?.profileLabel ?? link.cli} · {state}</button> : undefined} />
    </div>
  })}</>
}
