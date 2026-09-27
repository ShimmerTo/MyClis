import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { DEFAULT_NOTES_DIR } from '@shared/types'
import type { CliConfig, CliId, CliStatus, Note } from '@shared/types'
import { buildNotesPrompt, dirBase, noteKindLabel, noteStamp, noteTitle, notesForDir, sameDir } from '../notes'
import { ProfileChoiceGrid } from './ProfileChoiceGrid'
import { toast } from './ToastHost'

interface Props {
  workDirs: string[]
  profiles: CliConfig[]
  clis: CliStatus[]
  /** 默认选中：一般是当前标签的目录与档案，方便「再开一个」 */
  defaultWorkDir: string
  defaultProfileId: string
  /** 文案可覆盖：「用其他 CLI 继续」复用同一个选择器 */
  title?: string
  hint?: string
  submitLabel?: string
  /**
   * 底部便签勾选区。只有「＋新会话」开启 —— 本弹窗被「用其他 CLI 继续」复用，
   * 那条路径自己拼交接提示词、不接受注入文本，挂上去会变成「勾了却没注入」的静默丢弃。
   */
  allowNotes?: boolean
  /** 全部便签；默认按执行目录过滤，跨目录模式仅接受初选 ID */
  notes?: Note[]
  /** 「发送到 CLI」：预勾选便签；传入即为执行模式，不允许空任务 */
  initialNoteIds?: string[]
  /** 管理页批量发送：仅可选初选 ID 中仍未处理的便签，换执行目录不清选 */
  allowCrossDirNotes?: boolean
  onStart: (workDir: string, profileId: string, cli: CliId, initialPrompt?: string, noteIds?: string[]) => Promise<void>
  onClose: () => void
}

/** 新建标签：选工作目录 + 主 CLI，确认后按浏览器新标签的方式打开一个主会话 */
export function NewTabModal(props: Props): JSX.Element {
  // 默认便签是逻辑分组，不能成为终端 cwd，包括调用方误传默认目录的情况。
  const workDirs = props.workDirs.filter((dir) => dir.trim() && !sameDir(dir, DEFAULT_NOTES_DIR))
  const [workDir, setWorkDir] = useState(() =>
    props.defaultWorkDir.trim() && !sameDir(props.defaultWorkDir, DEFAULT_NOTES_DIR) ? props.defaultWorkDir : workDirs[0] ?? '')
  const [profileId, setProfileId] = useState(() => {
    const available = props.profiles.filter((profile) => props.clis.some((cli) => cli.id === profile.cli && cli.installed))
    return available.find((profile) => profile.id === props.defaultProfileId)?.id ?? available[0]?.id ?? props.defaultProfileId
  })
  const [busy, setBusy] = useState(false)
  const starting = useRef(false)
  const [err, setErr] = useState('')
  const available = useMemo(() => {
    if (!props.allowNotes) return []
    if (props.allowCrossDirNotes) {
      const initialIds = new Set(props.initialNoteIds ?? [])
      return (props.notes ?? []).filter((note) => initialIds.has(note.id) && note.status === 'todo')
    }
    return notesForDir(props.notes ?? [], workDir).filter((note) => !props.initialNoteIds || note.status === 'todo')
  }, [props.allowNotes, props.allowCrossDirNotes, props.notes, props.initialNoteIds, workDir])
  const [checked, setChecked] = useState<Set<string>>(
    () => new Set(available.filter((note) => props.initialNoteIds?.includes(note.id)).map((note) => note.id))
  )
  const picked = available.filter((note) => checked.has(note.id))
  const panel = useRef<HTMLDivElement>(null)

  // 普通新会话仍按目录清选；管理页跨目录任务只更换执行位置，不改变便签归属。
  // 只认「后续切换」，挂载时不能清掉预勾选。
  const prevDir = useRef(workDir)
  useEffect(() => {
    if (prevDir.current === workDir) return
    prevDir.current = workDir
    if (!props.allowCrossDirNotes) setChecked(new Set())
  }, [workDir, props.allowCrossDirNotes])

  // 删除、状态变化或页面筛选都可能使初选 ID 失效；恢复可见时也不自动重新选中。
  useEffect(() => {
    const availableIds = new Set(available.map((note) => note.id))
    setChecked((old) => {
      const next = new Set([...old].filter((id) => availableIds.has(id)))
      return next.size === old.size ? old : next
    })
  }, [available])

  useEffect(() => {
    const opener = document.activeElement
    panel.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) props.onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      if (opener instanceof HTMLElement) opener.focus()
    }
  }, [busy])

  const profile = props.profiles.find((p) => p.id === profileId)
  const cliInstalled = !!profile && !!props.clis.find((c) => c.id === profile.cli)?.installed
  const executionMode = !!props.initialNoteIds || !!props.allowCrossDirNotes
  const ready = !!workDir.trim() && !sameDir(workDir, DEFAULT_NOTES_DIR) && cliInstalled && !busy && (!executionMode || picked.length > 0)

  const start = async (): Promise<void> => {
    if (starting.current) return
    if (!profile) {
      setErr('请选择主 CLI')
      return
    }
    if (executionMode && picked.length === 0) {
      setErr('请至少选择一条未处理便签')
      return
    }
    if (!ready) return
    starting.current = true
    setBusy(true)
    setErr('')
    try {
      const { text, omitted } = buildNotesPrompt(picked, !!props.initialNoteIds)
      const noteIds = picked.slice(0, picked.length - omitted).map((note) => note.id)
      if (executionMode && noteIds.length === 0) throw new Error('没有可发送的便签，请重新选择')
      if (omitted > 0) toast(`便签内容过长，已省略 ${omitted} 条`)
      await props.onStart(workDir, profile.id, profile.cli, text || undefined, noteIds)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      starting.current = false
      setBusy(false)
    }
  }

  return createPortal(
    <div
      className="picker-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) props.onClose()
      }}
    >
      <div className="picker-panel" ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-label={props.title ?? '新建标签'}>
        <div className="picker-head">
          <h2>{props.title ?? '新建标签'}</h2>
          <span className="hint">{props.hint ?? '选工作目录与主 CLI，在新标签里打开主终端'}</span>
          <span className="spacer" />
          <span className="hint">{workDirs.length} 个目录</span>
        </div>

        <div className="picker-body">
          <section className="section">
            <div className="section-head">
              <h2>工作目录</h2>
              <span className="hint">主终端在该目录运行</span>
            </div>
            {workDirs.length === 0 ? (
              <div className="empty">还没有工作目录 —— 到左侧「目录」页添加至少 1 个。</div>
            ) : (
              <div className="pick-grid">
                {workDirs.map((d) => (
                  <button
                    key={d}
                    type="button"
                    className={`pick-card ${workDir === d ? 'on' : ''}`}
                    disabled={busy}
                    onClick={() => setWorkDir(d)}
                    title={d}
                  >
                    <span className="pick-title">{d}</span>
                    <span className="pick-sub">{workDir === d ? '已选中' : '点击选择'}</span>
                  </button>
                ))}
              </div>
            )}
          </section>

          <section className="section">
            <div className="section-head">
              <h2>主 CLI</h2>
              <span className="hint">只选一个</span>
            </div>
            <ProfileChoiceGrid
              profiles={props.profiles}
              clis={props.clis}
              selectedIds={profileId ? [profileId] : []}
              onChange={(ids) => setProfileId(ids[0] ?? '')}
            />
          </section>

          {props.allowNotes ? (
            <section className="section">
              <div className="section-head">
                <h2>注入便签</h2>
                <span className="hint">勾选的便签会在会话就绪后作为第一条消息发出</span>
                <span className="spacer" />
                <span className="hint">
                  {available.length} 条可选 · 已选 {picked.length}
                </span>
              </div>
              {props.allowCrossDirNotes && <p className="hint">仅展示本次选中的未处理便签，原归属如下；切换执行目录不会清空选择。</p>}
              {available.length === 0 ? (
                <div className="empty">{props.allowCrossDirNotes ? '本次选择中已无可执行的便签，请取消后重新选择。' :
                  props.initialNoteIds ? '该工作目录没有未处理的便签。' : '该工作目录还没有便签 —— 在终端/对话详情/产出/变更窗口里右键「加入便签」。'}</div>
              ) : (
                <div className="notes-pick">
                  {available.map((note) => {
                    const on = checked.has(note.id)
                    return (
                      <label key={note.id} className={`notes-pick-row ${on ? 'on' : ''}`} title={note.content}>
                        <input
                          type="checkbox"
                          checked={on}
                          disabled={busy}
                          onChange={() =>
                            setChecked((old) => {
                              const next = new Set(old)
                              if (next.has(note.id)) next.delete(note.id)
                              else next.add(note.id)
                              return next
                            })
                          }
                        />
                        <span className="notes-pick-title">{noteTitle(note)}</span>
                        <span className={`note-kind ${note.kind}`}>{noteKindLabel(note.kind)}</span>
                        {executionMode && <span className="hint notes-group-path"
                          title={sameDir(note.workDir, DEFAULT_NOTES_DIR) ? '存储于全局数据目录' : note.workDir}>原归属：{dirBase(note.workDir)}</span>}
                        <span className="notes-pick-time">{noteStamp(note.createdAt)}</span>
                      </label>
                    )
                  })}
                </div>
              )}
            </section>
          ) : null}
        </div>

        <div className="picker-foot">
          {err ? <span className="error">{err}</span> : <span className="hint">确认后立即拉起新的主终端</span>}          <span className="spacer" />
          <button type="button" disabled={busy} onClick={props.onClose}>
            取消
          </button>
          <button type="button" className="primary" disabled={!ready} onClick={() => void start()}>
            {busy ? '启动中…' : (props.submitLabel ?? '打开标签')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
