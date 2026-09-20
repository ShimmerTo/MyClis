import { useCallback, useEffect, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { createPortal } from 'react-dom'
import type { NoteKind } from '@shared/types'
import { dirBase } from '../notes'
import { toast } from './ToastHost'

/** 固定条目（变更文件行 / 产出产物行）：不依赖选区，右键就作用于这一条 */
export interface NoteMenuTarget {
  /** 展示名，只用于提示文案 */
  label: string
  kind: NoteKind
  /** 直接可用的内容（绝对路径或网址） */
  content?: string
  /** 需要主进程解析的仓库根相对路径（git 变更清单里的 path 就是这种） */
  relativePath?: string
}

export interface NoteMenuConfig {
  /** 便签归属的工作目录；没有就不允许「加入便签」 */
  workDir?: string
  /** 选中文本右键时「复制」项的文案；不传则不显示复制项 */
  selectionCopyLabel?: string
  /** 固定条目右键（与选区互斥） */
  target?: NoteMenuTarget
}

interface MenuState {
  x: number
  y: number
  text: string
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(
    /^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/i,
    ''
  )
}

async function copy(value: string): Promise<void> {
  if (!value) return
  try {
    await navigator.clipboard.writeText(value)
    toast('已复制')
  } catch {
    toast('复制失败')
  }
}

/**
 * 文本区域/条目行的右键菜单：给「复制」与「加入便签」。
 * 必须 portal 到 body 并定在 clientX/clientY —— 对话详情在 `.picker-panel` 里且限高，
 * 内联绝对定位会被裁掉；z-index 也必须高于 `.picker-overlay` 的 1000，
 * 否则在模态里右键会被遮罩吃掉点击，表现成「什么都没加上、详情窗反而被关掉」。
 */
export function useNoteMenu(config: NoteMenuConfig): {
  onContextMenu: (event: ReactMouseEvent<HTMLElement>) => void
  menu: JSX.Element | null
} {
  const [state, setState] = useState<MenuState | null>(null)
  const { workDir, target, selectionCopyLabel } = config

  const onContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      if (target) {
        event.preventDefault()
        setState({ x: event.clientX, y: event.clientY, text: '' })
        return
      }
      // 选区为空时不拦：把默认右键菜单还给用户
      const text = window.getSelection()?.toString() ?? ''
      if (!text.trim()) return
      event.preventDefault()
      setState({ x: event.clientX, y: event.clientY, text })
    },
    [target]
  )

  useEffect(() => {
    if (!state) return
    const close = (): void => setState(null)
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setState(null)
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('scroll', close, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [state])

  /** 菜单项要用的内容：固定条目优先，其次是快照下来的选区文本 */
  const valueOf = async (): Promise<string> => {
    if (!target) return state?.text ?? ''
    if (target.content) return target.content
    if (target.relativePath && workDir) {
      return window.clichilds.pathResolve({ workDir, path: target.relativePath })
    }
    return ''
  }

  const addNote = async (): Promise<void> => {
    if (!workDir) {
      toast('没有可归属的工作目录，无法加入便签')
      return
    }
    try {
      const content = await valueOf()
      if (!content.trim()) return
      const note = await window.clichilds.notesAdd({
        workDir,
        kind: target ? target.kind : 'text',
        content
      })
      // 带上目录名：子终端、reviewer 面板里加入的便签归属的是主会话的目录，不写清楚会以为放错了
      toast(`已加入便签（${dirBase(note.workDir)}）：${note.title}`)
    } catch (error) {
      toast(errorText(error))
    }
  }

  const copyValue = async (): Promise<void> => {
    try {
      await copy(await valueOf())
    } catch (error) {
      toast(errorText(error))
    }
  }

  const menu = state
    ? createPortal(
        <div
          className="notes-menu"
          style={{ left: state.x, top: state.y }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          {target ? (
            <button type="button" onClick={() => void copyValue()} disabled={!workDir && !target.content}>
              复制路径
            </button>
          ) : selectionCopyLabel ? (
            <button type="button" onClick={() => void copy(state.text)}>
              {selectionCopyLabel}
            </button>
          ) : null}
          <button type="button" onClick={() => void addNote()} disabled={!workDir}>
            加入便签
          </button>
        </div>,
        document.body
      )
    : null

  return { onContextMenu, menu }
}
