import { useEffect, useMemo, useRef, useState } from 'react'
import type { ThemeKind } from '@shared/types'
import { AppShell, Chips } from '../components/AppShell'
import type { View } from '../components/AppShell'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { NoteItem } from '../components/NoteItem'
import { toast } from '../components/ToastHost'
import { buildNotesCopyText, bytesText, dirBase, notesForDir, notesShowDone, rememberNotesShowDone } from '../notes'
import { useNoteIntake } from '../noteIntake'
import { applyTheme, saveConfig, useNotes, useSettings } from '../store'

const dirKey = (p: string): string => p.replace(/[\\/]+$/, '').toLowerCase()

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(
    /^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/i,
    ''
  )
}

/** 待确认的清除操作：不带 workDir = 清全部，带上 = 清某个工作目录 */
interface PendingClear {
  workDir?: string
  count: number
  label: string
}

/**
 * 便签管理页：跨工作目录汇总，按目录分组。
 * 运行窗口的浮窗只显示当前目录，这里是唯一能一次看到全部便签的地方。
 */
export default function NotesPage({ onNav }: { onNav: (v: View) => void }): JSX.Element {
  const { cfg, setCfg } = useSettings()
  const notes = useNotes()
  const [query, setQuery] = useState('')
  const [showDone, setShowDone] = useState(notesShowDone)
  const [pending, setPending] = useState<PendingClear | null>(null)
  const [cleanup, setCleanup] = useState<{ removed: number; bytes: number } | null>(null)
  const [freshId, setFreshId] = useState('')
  const [targetDir, setTargetDir] = useState('')
  const page = useRef<HTMLDivElement>(null)
  /** 拖入/粘贴的落点：管理页跨多个目录，必须让用户明确选一个 */
  const intakeDir = targetDir || (cfg?.workDirs ?? []).find((d) => d.trim()) || ''
  const intake = useNoteIntake(intakeDir)

  // 进来就聚焦页面容器：Ctrl+V 的粘贴事件只会派发到获得焦点的元素上
  useEffect(() => {
    page.current?.focus()
  }, [])

  const matched = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return notes
    return notes.filter(
      (note) => note.title.toLowerCase().includes(q) || note.content.toLowerCase().includes(q)
    )
  }, [notes, query])

  /** 已完成的便签默认不显示，顶部勾选后展示（与浮窗共用同一个开关） */
  const visible = useMemo(
    () => (showDone ? matched : matched.filter((note) => note.status !== 'done')),
    [matched, showDone]
  )

  /**
   * 分组：配置里的工作目录在前，只存在于便签里的「孤儿目录」补在后面 ——
   * 目录从配置里删掉后便签还在，不列出来就等于永久看不见。
   * 空分组也保留（带上自己的「＋ 新建」），否则没法往一个还没有便签的目录里加东西。
   */
  const groups = useMemo(() => {
    const dirs = (cfg?.workDirs ?? []).filter((d) => d.trim())
    const seen = new Set(dirs.map(dirKey))
    const extras: string[] = []
    for (const note of notes) {
      const key = dirKey(note.workDir)
      if (seen.has(key)) continue
      seen.add(key)
      extras.push(note.workDir)
    }
    return [...dirs, ...extras].map((dir) => ({ dir, items: notesForDir(visible, dir) }))
  }, [cfg?.workDirs, visible, notes])

  /** 「＋ 新建」需要一个归属目录：优先第一个配置目录 */
  const defaultDir = (cfg?.workDirs ?? []).find((d) => d.trim()) ?? ''

  const save = (id: string, patch: { title: string; content: string }): void => {
    void window.clichilds
      .notesUpdate({ id, ...patch })
      .then(() => setFreshId(''))
      .catch((error: unknown) => toast(errorText(error)))
  }

  const create = (workDir: string): void => {
    if (!workDir) {
      toast('还没有工作目录，无法新建便签')
      return
    }
    void window.clichilds
      .notesAdd({ workDir, kind: 'text', content: '' })
      .then((note) => {
        setFreshId(note.id)
        toast('已新建便签，直接输入内容即可')
      })
      .catch((error: unknown) => toast(errorText(error)))
  }

  const copyAll = (items: typeof notes, label: string): void => {
    void navigator.clipboard
      .writeText(buildNotesCopyText(items))
      .then(() => toast(`已复制 ${items.length} 条便签（${label}）`))
      .catch(() => toast('复制失败'))
  }

  const doClear = (): void => {
    if (!pending) return
    void window.clichilds
      .notesClear(pending.workDir ? { workDir: pending.workDir } : undefined)
      .then(() => {
        toast(`已清除 ${pending.count} 条便签（原内容已备份为 notes.json.bak）`)
        setPending(null)
      })
      .catch((error: unknown) => toast(errorText(error)))
  }

  /** 先只统计：删图片不可逆，数量与体积得先让用户看到 */
  const scanCleanup = (): void => {
    void window.clichilds
      .notesCleanupAssets({ dryRun: true })
      .then((result) => {
        if (result.removed === 0) toast('没有可清理的图片')
        else setCleanup(result)
      })
      .catch((error: unknown) => toast(errorText(error)))
  }

  const doCleanup = (): void => {
    void window.clichilds
      .notesCleanupAssets({ dryRun: false })
      .then((result) => {
        toast(`已清理 ${result.removed} 个图片，释放 ${bytesText(result.bytes)}`)
        setCleanup(null)
      })
      .catch((error: unknown) => toast(errorText(error)))
  }

  return (
    <AppShell
      view="notes"
      onNav={onNav}
      theme={cfg?.theme ?? 'dark'}
      onTheme={(t: ThemeKind) => {
        applyTheme(t)
        if (!cfg) return
        const next = { ...cfg, theme: t }
        setCfg(next)
        void saveConfig(next).catch(() => undefined)
      }}
      title="便签"
      desc="跨工作目录汇总；运行窗口的浮窗只显示当前目录"
      chips={
        <Chips
          items={[
            { text: `便签 ${notes.length}`, ok: notes.length > 0 },
            { text: `目录 ${groups.length}`, ok: groups.length > 0 }
          ]}
        />
      }
    >
      <div
        className={`notes-page ${intake.dragging ? 'dragging' : ''}`}
        ref={page}
        tabIndex={-1}
        onDragOver={intake.onDragOver}
        onDragLeave={intake.onDragLeave}
        onDrop={intake.onDrop}
        onPaste={intake.onPaste}
      >
        <div className="notes-toolbar">
          <input
            className="note-input notes-search"
            value={query}
            placeholder="搜索标题或内容"
            onChange={(e) => setQuery(e.target.value)}
          />
          <label className="notes-showdone" title="已完成的便签默认隐藏，勾选后显示（浮窗共用这个开关）">
            <input
              type="checkbox"
              checked={showDone}
              onChange={(e) => {
                setShowDone(e.target.checked)
                rememberNotesShowDone(e.target.checked)
              }}
            />
            显示已完成
          </label>
          <span className="hint">
            {query.trim() ? `命中 ${visible.length} / ${notes.length} 条` : `${notes.length} 条`}
          </span>
          {!showDone && notes.length > visible.length ? (
            <span className="hint">已完成 {notes.length - visible.length} 条已隐藏</span>
          ) : null}
          <span className="spacer" />
          {groups.length > 1 ? (
            <label className="notes-target">
              拖入/粘贴到
              <select value={intakeDir} onChange={(e) => setTargetDir(e.target.value)}>
                {groups.map((group) => (
                  <option key={group.dir} value={group.dir}>
                    {dirBase(group.dir)}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <button
            type="button"
            disabled={intake.busy || !intakeDir}
            onClick={intake.paste}
            title="粘贴剪贴板里的文件、图片或文本（也可以直接在页面里按 Ctrl+V）"
          >
            粘贴
          </button>
          <button type="button" onClick={() => create(defaultDir)} title="在第一个工作目录下新建一条空便签">
            ＋ 新建
          </button>
          <button
            type="button"
            disabled={notes.length === 0}
            onClick={() => copyAll(notes, '全部')}
            title="复制全部便签的标题与正文"
          >
            复制所有
          </button>
          <button
            type="button"
            onClick={scanCleanup}
            title="删除便签资产目录里已无便签引用、且超过 7 天的图片（不碰用户自有文件）"
          >
            清理无引用图片
          </button>
          <button
            type="button"
            className="danger"
            disabled={notes.length === 0}
            onClick={() => setPending({ count: notes.length, label: '全部工作目录' })}
            title="清除全部工作目录的便签"
          >
            清除所有
          </button>
        </div>

        {pending ? (
          <ConfirmDialog
            title={pending.workDir ? '清除该目录的便签' : '清除全部便签'}
            confirmText="确认清除"
            onCancel={() => setPending(null)}
            onConfirm={doClear}
          >
            将删除 {pending.label} 下的 {pending.count} 条便签，不可撤销（原内容会自动备份成
            notes.json.bak）。
          </ConfirmDialog>
        ) : null}

        {cleanup ? (
          <div className="notes-confirm">
            <span>
              将删除 {cleanup.removed} 个已无便签引用的图片，共 {bytesText(cleanup.bytes)}
              。已被注入到 CLI 会话或被复制到别处的路径可能因此失效。
            </span>
            <span className="spacer" />
            <button type="button" onClick={() => setCleanup(null)}>
              取消
            </button>
            <button type="button" className="danger" onClick={doCleanup}>
              确认清理
            </button>
          </div>
        ) : null}

        {groups.length === 0 ? (
          <div className="empty">
            还没有便签，也没有配置工作目录。先在「运行」页添加工作目录，再到终端里右键加入便签；
            也可以把文件拖到这里、或按 Ctrl+V 粘贴。
          </div>
        ) : (
          groups.map((group) => (
            <section className="notes-group" key={group.dir}>
              <div className="notes-group-head">
                <h2 title={group.dir}>{dirBase(group.dir)}</h2>
                <span className="hint" title={group.dir}>
                  {group.dir}
                </span>
                <span className="spacer" />
                <span className="hint">{group.items.length} 条</span>
                <button
                  type="button"
                  disabled={group.items.length === 0}
                  onClick={() => copyAll(group.items, dirBase(group.dir))}
                  title="复制该目录下全部便签"
                >
                  复制所有
                </button>
                <button
                  type="button"
                  disabled={group.items.length === 0}
                  onClick={() => create(group.dir)}
                  title="在该目录下新建一条空便签"
                >
                  ＋ 新建
                </button>
                <button
                  type="button"
                  className="danger"
                  disabled={group.items.length === 0}
                  onClick={() =>
                    setPending({ workDir: group.dir, count: group.items.length, label: dirBase(group.dir) })
                  }
                  title="清除该目录下的便签"
                >
                  清除
                </button>
              </div>
              {group.items.length === 0 ? (
                <p className="hint" style={{ padding: '4px 10px' }}>
                  该目录暂无便签
                </p>
              ) : (
                group.items.map((note) => (
                  <NoteItem
                    key={note.id}
                    note={note}
                    autoEdit={note.id === freshId}
                    onSave={(patch) => save(note.id, patch)}
                    onRemove={() =>
                      void window.clichilds
                        .notesRemove(note.id)
                        .catch((error: unknown) => toast(errorText(error)))
                    }
                  />
                ))
              )}
            </section>
          ))
        )}
      </div>
    </AppShell>
  )
}
