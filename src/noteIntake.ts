import { useCallback, useState } from 'react'
import type { ClipboardEvent as ReactClipboardEvent, DragEvent as ReactDragEvent } from 'react'
import { toast } from './components/ToastHost'

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(
    /^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/i,
    ''
  )
}

export interface NoteIntake {
  /** 有文件悬停在目标上，用于高亮 */
  dragging: boolean
  onDragOver: (event: ReactDragEvent<HTMLElement>) => void
  onDragLeave: (event: ReactDragEvent<HTMLElement>) => void
  onDrop: (event: ReactDragEvent<HTMLElement>) => void
  onPaste: (event: ReactClipboardEvent<HTMLElement>) => void
  /** 给「粘贴」按钮用：不依赖焦点 */
  paste: () => void
  busy: boolean
}

/**
 * 便签的「拖入文件」与「Ctrl+V 粘贴」。
 *
 * 粘贴一律走主进程读剪贴板，不读事件里的 clipboardData —— 资源管理器复制的文件走的是
 * CF_HDROP 自定义格式，浏览器侧拿不到，只有主进程能用 FileNameW 取出来；
 * 这样拖入与粘贴同一个文件也会产出同一种便签。
 */
export function useNoteIntake(workDir: string): NoteIntake {
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState(false)

  const addPaths = useCallback(
    async (paths: string[]): Promise<void> => {
      if (!workDir) {
        toast('没有可归属的工作目录')
        return
      }
      let ok = 0
      let firstError = ''
      for (const path of paths) {
        try {
          await window.clichilds.notesAdd({ workDir, kind: 'file', content: path })
          ok += 1
        } catch (error) {
          // 目录、不存在的路径都在这里被主进程挡下
          if (!firstError) firstError = errorText(error)
        }
      }
      if (ok > 0) toast(`已加入 ${ok} 条便签`)
      if (firstError) toast(firstError)
    },
    [workDir]
  )

  const addText = useCallback(
    async (text: string): Promise<void> => {
      if (!workDir) {
        toast('没有可归属的工作目录')
        return
      }
      try {
        const note = await window.clichilds.notesAdd({ workDir, kind: 'text', content: text })
        toast(`已加入便签：${note.title}`)
      } catch (error) {
        toast(errorText(error))
      }
    },
    [workDir]
  )

  const paste = useCallback((): void => {
    setBusy(true)
    void window.clichilds
      .notesPaste()
      .then(async (payload) => {
        if (payload.kind === 'files') await addPaths(payload.paths)
        else if (payload.kind === 'image') await addPaths([payload.path])
        else if (payload.kind === 'text') await addText(payload.text)
        else toast('剪贴板里没有可加入便签的内容')
      })
      .catch((error: unknown) => toast(errorText(error)))
      .finally(() => setBusy(false))
  }, [addPaths, addText])

  const onDragOver = useCallback((event: ReactDragEvent<HTMLElement>) => {
    // 不 preventDefault 的话 drop 根本不会触发
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    setDragging(true)
  }, [])

  const onDragLeave = useCallback((event: ReactDragEvent<HTMLElement>) => {
    // dragleave 在子元素之间移动时也会冒泡上来，只认真正离开容器的那次
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
    setDragging(false)
  }, [])

  const onDrop = useCallback(
    (event: ReactDragEvent<HTMLElement>) => {
      event.preventDefault()
      setDragging(false)
      const files = Array.from(event.dataTransfer?.files ?? [])
      if (files.length === 0) {
        toast('只支持本地文件')
        return
      }
      const paths: string[] = []
      let foreign = 0
      for (const file of files) {
        // 网页里拖来的图片没有本地路径，getPathForFile 返回空串
        const path = window.clichilds.getPathForFile(file)
        if (path) paths.push(path)
        else foreign += 1
      }
      if (foreign > 0) toast(`${foreign} 个不是本地文件，已跳过`)
      if (paths.length > 0) void addPaths(paths)
    },
    [addPaths]
  )

  const onPaste = useCallback(
    (event: ReactClipboardEvent<HTMLElement>) => {
      // 焦点在输入框/文本域里时把粘贴让回去 —— 否则在便签里改正文按 Ctrl+V
      // 会被这里拦下来，变成「又加了一条便签」
      const target = event.target as HTMLElement | null
      const tag = target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return
      event.preventDefault()
      paste()
    },
    [paste]
  )

  return { dragging, onDragOver, onDragLeave, onDrop, onPaste, paste, busy }
}
