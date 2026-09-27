import { useEffect } from 'react'
import { LOCAL_NOTE_SELECTION_EVENT } from '@shared/types'
import { terminalSelectionAt } from './terminalPool'

function selectedText(target: Element | null): string {
  if (!target?.isConnected) return ''
  if (target.closest('.xterm')) return terminalSelectionAt(target)
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    if (target instanceof HTMLInputElement && target.type === 'password') return ''
    return target.value.slice(target.selectionStart ?? 0, target.selectionEnd ?? 0)
  }
  const selection = window.getSelection()
  if (!selection?.rangeCount || !selection.containsNode(target, true)) return ''
  return selection.toString()
}

export function useLocalNoteSelection(): void {
  useEffect(() => {
    let enabled = false
    let alive = true
    let revision = 0
    let target: Element | null = null
    let downTarget: Element | null = null
    const off = window.clichilds.onNotesCaptureState(value => {
      revision++
      enabled = value
      if (!value) target = downTarget = null
    })
    void window.clichilds.configGet().then(cfg => {
      if (alive && revision === 0) enabled = cfg.notes.selectionCaptureEnabled
    }).catch(error => console.error('读取划词收集状态失败', error))
    const cancel = (): void => {
      target = downTarget = null
      if (enabled) window.clichilds.notesSelection({ text: '', x: 0, y: 0 })
    }
    const onMouseDown = (event: MouseEvent): void => {
      cancel()
      if (enabled && event.button === 0 && event.target instanceof Element) downTarget = event.target
    }
    const onMouseUp = (event: MouseEvent): void => {
      if (!enabled || event.button !== 0) return
      target = downTarget
      downTarget = null
      const text = selectedText(target)
      if (text.length > 100 * 1024) return
      window.clichilds.notesSelection({ text, x: event.screenX, y: event.screenY })
    }
    const inspect = (event: Event): void => {
      const detail = (event as CustomEvent<{ text: string }>).detail
      if (detail && enabled) detail.text = selectedText(target)
    }
    window.addEventListener('mousedown', onMouseDown, true)
    window.addEventListener('mouseup', onMouseUp)
    window.addEventListener('wheel', cancel, { capture: true, passive: true })
    window.addEventListener('blur', cancel)
    document.addEventListener(LOCAL_NOTE_SELECTION_EVENT, inspect)
    return () => {
      alive = false
      off()
      window.removeEventListener('mousedown', onMouseDown, true)
      window.removeEventListener('mouseup', onMouseUp)
      window.removeEventListener('wheel', cancel, true)
      window.removeEventListener('blur', cancel)
      document.removeEventListener(LOCAL_NOTE_SELECTION_EVENT, inspect)
    }
  }, [])
}
