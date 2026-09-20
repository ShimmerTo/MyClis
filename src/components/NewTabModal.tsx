import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CliConfig, CliId, CliStatus, Note } from '@shared/types'
import { buildNotesPrompt, noteKindLabel, noteStamp, noteTitle, notesForDir } from '../notes'
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
  /** 全部便签（含其它目录），组件内部按当前选中目录过滤 */
  notes?: Note[]
  /** 「发送到 CLI」：打开时预勾选这条便签（调用方会把默认目录设成便签所在目录） */
  initialNoteId?: string
  onStart: (workDir: string, profileId: string, cli: CliId, initialPrompt?: string) => Promise<void>
  onClose: () => void
}

/** 新建标签：选工作目录 + 主 CLI，确认后按浏览器新标签的方式打开一个主会话 */
export function NewTabModal(props: Props): JSX.Element {
  const [workDir, setWorkDir] = useState(props.defaultWorkDir || props.workDirs[0] || '')
  const [profileId, setProfileId] = useState(props.defaultProfileId)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [checked, setChecked] = useState<Set<string>>(
    () => new Set(props.initialNoteId ? [props.initialNoteId] : [])
  )
  const panel = useRef<HTMLDivElement>(null)

  // 换目录就清空勾选：上一个目录的便签不该跟着注入到新目录的会话里。
  // 只认「后续切换」—— 挂载时的首轮 effect 不能清，否则「发送到 CLI」的预勾选会被抹掉。
  const prevDir = useRef(workDir)
  useEffect(() => {
    if (prevDir.current === workDir) return
    prevDir.current = workDir
    setChecked(new Set())
  }, [workDir])

  const available = useMemo(
    () => (props.allowNotes ? notesForDir(props.notes ?? [], workDir) : []),
    [props.allowNotes, props.notes, workDir]
  )

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
  const ready = !!workDir && cliInstalled && !busy

  const start = async (): Promise<void> => {
    if (!profile) {
      setErr('请选择主 CLI')
      return
    }
    setBusy(true)
    setErr('')
    try {
      const picked = available.filter((note) => checked.has(note.id))
      const { text, omitted } = buildNotesPrompt(picked)
      if (omitted > 0) toast(`便签内容过长，已省略 ${omitted} 条`)
      await props.onStart(workDir, profile.id, profile.cli, text || undefined)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
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
          <span className="hint">{props.workDirs.length} 个目录</span>
        </div>

        <div className="picker-body">
          <section className="section">
            <div className="section-head">
              <h2>工作目录</h2>
              <span className="hint">主终端在该目录运行</span>
            </div>
            {props.workDirs.length === 0 ? (
              <div className="empty">还没有工作目录 —— 到左侧「运行」页添加至少 1 个。</div>
            ) : (
              <div className="pick-grid">
                {props.workDirs.map((d) => (
                  <button
                    key={d}
                    type="button"
                    className={`pick-card ${workDir === d ? 'on' : ''}`}
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
                  {available.length} 条可选 · 已选 {checked.size}
                </span>
              </div>
              {available.length === 0 ? (
                <div className="empty">该工作目录还没有便签 —— 在终端/对话详情/产出/变更窗口里右键「加入便签」。</div>
              ) : (
                <div className="notes-pick">
                  {available.map((note) => {
                    const on = checked.has(note.id)
                    return (
                      <label key={note.id} className={`notes-pick-row ${on ? 'on' : ''}`} title={note.content}>
                        <input
                          type="checkbox"
                          checked={on}
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
