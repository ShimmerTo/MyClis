import { app, dialog, Menu, Notification } from 'electron'
import type { BrowserWindow, ContextMenuParams, Event, MenuItemConstructorOptions } from 'electron'
import { CH, DEFAULT_NOTES_DIR, LOCAL_NOTE_SELECTION_EVENT } from '../../shared/types'
import type { AppConfig, NoteSelectionInput } from '../../shared/types'
import { loadConfig, saveConfig } from '../config/store'
import type { NotesStore } from './store'
import { SelectionCapture } from './selection'

export function registerNoteCapture(notes: NotesStore, getWin: () => BrowserWindow | null): {
  config: () => Promise<AppConfig>
  save: (config: AppConfig) => Promise<AppConfig>
  selectLocal: (input: NoteSelectionInput) => void
  dispose: () => void
} {
  let disposed = false
  const detach = new Set<() => void>()

  const warn = (message: string): void => {
    void dialog.showMessageBox({ type: 'warning', title: '便签收集', message })
      .catch((error: unknown) => console.error('显示便签收集提醒失败', error))
  }
  const notify = (): void => {
    try {
      if (Notification.isSupported()) new Notification({ title: 'MyClis', body: '已存储到默认便签', silent: true }).show()
    } catch (error) {
      console.error('显示便签保存通知失败', error)
    }
  }
  const capture = (text: string): void => {
    if (disposed || !text.trim()) return
    try {
      notes.add({ workDir: DEFAULT_NOTES_DIR, kind: 'text', content: text })
    } catch (error) {
      console.error('收集文字到便签失败', error)
      warn('保存便签失败，请检查全局数据目录权限与磁盘空间。')
      return
    }
    notify()
  }
  const sendState = (enabled: boolean): void => {
    const win = getWin()
    if (win && !win.isDestroyed()) win.webContents.send(CH.notesCaptureState, enabled)
  }
  const readLocal = async (): Promise<string> => {
    const win = getWin()
    if (!win || win.isDestroyed() || !win.isFocused()) return ''
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const result: unknown = await Promise.race([
        win.webContents.executeJavaScript(`(() => { const detail = {text: ''}; document.dispatchEvent(new CustomEvent(${JSON.stringify(LOCAL_NOTE_SELECTION_EVENT)}, {detail})); return detail.text; })()`),
        new Promise<string>(resolve => { timer = setTimeout(() => resolve(''), 700) })
      ])
      if (disposed || win !== getWin() || win.isDestroyed() || !win.isFocused()) return ''
      return typeof result === 'string' && result.length <= 100 * 1024 ? result : ''
    } finally { clearTimeout(timer) }
  }
  const selection = new SelectionCapture(capture, () => {
    if (!disposed) {
      sendState(false)
      warn('划词收集组件已停止，未保存任何选区；请在设置中关闭后重新开启。应用内右键收集仍可使用。')
    }
  }, readLocal, () => loadConfig().theme)
  const setEnabled = async (value: boolean): Promise<void> => {
    if (disposed) throw new Error('便签收集已停止')
    if (value) await selection.start()
    else selection.stop()
    if (disposed) throw new Error('便签收集已停止')
    sendState(selection.enabled)
  }

  const attach = (_event: Event, win: BrowserWindow): void => {
    const contents = win.webContents
    const onMenu = (event: Event, params: ContextMenuParams): void => {
      if (disposed || win !== getWin() || params.formControlType === 'input-password' || !params.selectionText.trim()) return
      event.preventDefault()
      const text = params.selectionText
      const items: MenuItemConstructorOptions[] = params.isEditable ? [
        { role: 'cut', label: '剪切', enabled: params.editFlags.canCut },
        { role: 'copy', label: '复制', enabled: params.editFlags.canCopy },
        { role: 'paste', label: '粘贴', enabled: params.editFlags.canPaste },
        { type: 'separator' }
      ] : [{ role: 'copy', label: '复制' }, { type: 'separator' }]
      items.push({ label: '存储到便签', click: () => capture(text) })
      Menu.buildFromTemplate(items).popup({ window: win })
    }
    const cancelLocal = (): void => {
      if (win === getWin()) selection.cancelLocal()
    }
    const cleanup = (): void => {
      cancelLocal()
      contents.removeListener('context-menu', onMenu)
      win.removeListener('blur', cancelLocal)
      win.removeListener('closed', cleanup)
      detach.delete(cleanup)
    }
    contents.on('context-menu', onMenu)
    win.on('blur', cancelLocal)
    win.once('closed', cleanup)
    detach.add(cleanup)
  }
  app.on('browser-window-created', attach)
  const current = getWin()
  if (current) attach({} as Event, current)
  const startup = setEnabled(loadConfig().notes.selectionCaptureEnabled).catch((error: unknown) => {
    console.error('启动时启用划词收集失败', error)
    if (!disposed) warn('本次划词收集未开启，请在设置中重新开启或安装完整版本。')
  })
  let queue: Promise<unknown> = startup

  return {
    selectLocal: input => {
      const win = getWin()
      if (disposed || !selection.enabled || !win || win.isDestroyed() || !win.isFocused()) return
      if (!input || typeof input.text !== 'string' || input.text.length > 100 * 1024 ||
        !Number.isInteger(input.x) || Math.abs(input.x) > 100000 || !Number.isInteger(input.y) || Math.abs(input.y) > 100000) return
      selection.selectLocal(input.text, input.x, input.y)
    },
    config: async () => {
      await startup
      const cfg = loadConfig()
      return { ...cfg, notes: { ...cfg.notes, selectionCaptureEnabled: selection.enabled } }
    },
    save: (cfg) => {
      const pending = queue.then(async () => {
        const previous = selection.enabled
        await setEnabled(cfg.notes.selectionCaptureEnabled)
        try {
          return saveConfig(cfg)
        } catch (error) {
          console.error('保存划词收集设置失败', error)
          try {
            await setEnabled(previous)
          } catch (restoreError) {
            console.error('恢复划词收集失败', restoreError)
            if (!disposed) warn('设置未保存，且划词收集未能恢复，请在设置中重新开启。')
          }
          throw new Error('保存设置失败，请检查全局数据目录权限与磁盘空间。')
        }
      })
      queue = pending.catch(() => undefined)
      return pending
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      selection.stop()
      app.removeListener('browser-window-created', attach)
      for (const cleanup of detach) cleanup()
    }
  }
}
