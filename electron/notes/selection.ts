import { app, BrowserWindow, screen } from 'electron'
import { execFile, spawn } from 'child_process'
import type { ChildProcess, ChildProcessWithoutNullStreams } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { ThemeKind } from '../../shared/types'

interface SelectionSource { window: string; processId: number; x: number; y: number; startX: number; startY: number; local?: true }
interface PendingSelection extends SelectionSource { text: string; token: string }

const MAX_TEXT = 100 * 1024
const WIDTH = 96
const HEIGHT = 30

// 浮窗由主进程用 data URL 渲染，读不到渲染层的 CSS 变量，只能按当前皮肤各留一份：
// 取值与 src/theme/theme.css 的 --accent / --accent-text 保持一致，深色边框与悬停色由 color-mix 推。
const POPUP_COLORS: Record<ThemeKind, { accent: string; accentText: string }> = {
  light: { accent: '#3f7d52', accentText: '#ffffff' },
  paper: { accent: '#2f6feb', accentText: '#ffffff' },
  dark: { accent: '#5b8def', accentText: '#ffffff' }
}

/** 生成划词浮窗正文：配色跟随当前皮肤，点击由主进程拦截 myclis-selection 链接。 */
export function buildPopupHtml(token: string, theme: ThemeKind): string {
  const colors = POPUP_COLORS[theme] ?? POPUP_COLORS.paper
  return `<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>存到便签</title><style>html,body{margin:0;background:transparent;font:12px 'Microsoft YaHei',sans-serif}:root{--accent:${colors.accent};--accent-text:${colors.accentText}}a{box-sizing:border-box;display:flex;align-items:center;justify-content:center;width:${WIDTH}px;height:${HEIGHT}px;background:var(--accent);color:var(--accent-text);border:1px solid color-mix(in srgb,var(--accent) 82%,#000);border-radius:6px;text-decoration:none;user-select:none}a:hover{background:color-mix(in srgb,var(--accent) 86%,#000)}</style><a href="myclis-selection://save/${token}">存到便签</a></html>`
}

function helperPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'app.asar.unpacked', 'out', 'main', 'notes-selection.exe')
    : join(app.getAppPath(), 'out', 'main', 'notes-selection.exe')
}

function nativeEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATH']
    .filter(key => typeof process.env[key] === 'string').map(key => [key, process.env[key]]))
}

function selectionSource(value: Record<string, unknown>): SelectionSource | null {
  if (typeof value.window !== 'string' || !/^[1-9]\d{0,19}$/.test(value.window) ||
    !Number.isInteger(value.processId) || Number(value.processId) <= 0 || Number(value.processId) > 0xffffffff || value.processId === process.pid ||
    !Number.isInteger(value.x) || Math.abs(Number(value.x)) > 100000 ||
    !Number.isInteger(value.y) || Math.abs(Number(value.y)) > 100000 ||
    !Number.isInteger(value.startX) || Math.abs(Number(value.startX)) > 100000 ||
    !Number.isInteger(value.startY) || Math.abs(Number(value.startY)) > 100000) return null
  return { window: value.window, processId: Number(value.processId), x: Number(value.x), y: Number(value.y), startX: Number(value.startX), startY: Number(value.startY) }
}

export class SelectionCapture {
  private watcher: ChildProcessWithoutNullStreams | null = null
  private reader: ChildProcess | null = null
  private window: BrowserWindow | null = null
  private pending: PendingSelection | null = null
  private delayedRead: ReturnType<typeof setTimeout> | undefined
  private expiry: ReturnType<typeof setTimeout> | undefined
  private cancelStart: (() => void) | undefined
  private starting: Promise<void> | null = null
  private generation = 0
  private revision = 0
  private ready = false
  private saving = false

  constructor(private saveText: (text: string) => void, private failed: () => void, private readLocal?: () => Promise<string>, private theme: () => ThemeKind = () => 'paper') {}

  get enabled(): boolean { return this.ready }

  cancelLocal(): void {
    if (this.pending?.local) this.dismiss()
  }

  selectLocal(text: string, x: number, y: number): void {
    if (!this.ready || !this.readLocal) return
    this.dismiss()
    if (!text.trim() || text.length > MAX_TEXT) return
    const point = screen.dipToScreenPoint({ x, y })
    this.present({ window: 'local', processId: process.pid, x: point.x, y: point.y, startX: point.x, startY: point.y, local: true }, text)
  }

  start(): Promise<void> {
    if (this.ready) return Promise.resolve()
    if (this.starting) return this.starting
    if (process.platform !== 'win32' || !existsSync(helperPath())) {
      return Promise.reject(new Error('划词收集组件不可用，请重新构建或安装完整的 Windows 版本。'))
    }
    const generation = ++this.generation
    const watcher = spawn(helperPath(), ['watch', String(process.pid)], { windowsHide: true, env: nativeEnv(), stdio: ['pipe', 'pipe', 'pipe'] })
    this.watcher = watcher
    let buffer = ''
    const start = new Promise<void>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => fail(), 5000)
      const finish = (error?: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.cancelStart = undefined
        if (error) reject(error)
        else resolve()
      }
      const fail = (): void => {
        if (generation !== this.generation) return
        const wasReady = this.ready
        finish(new Error('划词收集组件启动失败或已停止，请重新开启；无需管理员权限。'))
        this.stop()
        if (wasReady) this.failed()
      }
      this.cancelStart = () => finish(new Error('划词收集已取消'))
      watcher.once('error', fail)
      watcher.once('exit', fail)
      watcher.stdin.on('error', fail)
      watcher.stderr.resume()
      watcher.stdout.setEncoding('utf8')
      watcher.stdout.on('data', (chunk: string) => {
        if (generation !== this.generation) return
        buffer += chunk
        if (buffer.length > 64 * 1024) { fail(); return }
        let newline: number
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).trim()
          buffer = buffer.slice(newline + 1)
          if (!line) continue
          let value: Record<string, unknown>
          try {
            const parsed: unknown = JSON.parse(line)
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { fail(); return }
            value = parsed as Record<string, unknown>
          } catch { fail(); return }
          if (value.type === 'ready') {
            this.ready = true
            finish()
          } else if (this.ready && value.type === 'dismiss') {
            // 本地选区由页面手势和主窗口失焦取消，避免原生管道迟到消息清掉新选区。
            if (!this.pending?.local && value.window !== this.popupHandle()) this.dismiss()
          } else if (this.ready && value.type === 'selection' && !this.pending?.local) {
            const source = selectionSource(value)
            if (source) this.select(source)
          }
        }
      })
    })
    this.starting = start
    void start.finally(() => { if (this.starting === start) this.starting = null }).catch(() => undefined)
    return start
  }

  stop(): void {
    ++this.generation
    this.ready = false
    this.cancelStart?.()
    this.cancelStart = undefined
    this.starting = null
    this.dismiss()
    const watcher = this.watcher
    this.watcher = null
    if (watcher) { watcher.stdin.end(); watcher.kill() }
    this.window?.destroy()
    this.window = null
  }

  private popupHandle(): string | undefined {
    if (!this.window || this.window.isDestroyed()) return undefined
    const handle = this.window.getNativeWindowHandle()
    return handle.length >= 8 ? handle.readBigUInt64LE().toString() : String(handle.readUInt32LE())
  }

  private dismiss(): void {
    ++this.revision
    clearTimeout(this.delayedRead)
    clearTimeout(this.expiry)
    this.delayedRead = undefined
    this.expiry = undefined
    this.pending = null
    this.saving = false
    const reader = this.reader
    this.reader = null
    reader?.kill()
    if (this.window && !this.window.isDestroyed()) this.window.hide()
  }

  private read(source: SelectionSource, done: (text: string) => void): void {
    const revision = this.revision
    if (source.local) {
      void this.readLocal!().then(text => {
        if (revision === this.revision && this.ready) done(text.length <= MAX_TEXT ? text : '')
      }).catch(() => {
        if (revision === this.revision && this.ready) done('')
      })
      return
    }
    this.reader = execFile(helperPath(), ['read', source.window, String(source.processId), String(source.x), String(source.y), String(source.startX), String(source.startY)],
      { windowsHide: true, env: nativeEnv(), timeout: 1800, maxBuffer: 1024 * 1024, encoding: 'utf8' }, (error, stdout) => {
        if (revision !== this.revision || !this.ready) return
        this.reader = null
        if (error) {
          console.warn('划词选区读取失败或超时，已忽略本次选区')
          done('')
          return
        }
        try {
          const value: unknown = JSON.parse(stdout)
          const text = value && typeof value === 'object' ? (value as { text?: unknown }).text : undefined
          done(typeof text === 'string' && text.length <= MAX_TEXT ? text : '')
        } catch {
          console.warn('划词选区返回格式无效，已忽略本次选区')
          done('')
        }
      })
  }

  private select(source: SelectionSource): void {
    this.dismiss()
    const revision = this.revision
    this.delayedRead = setTimeout(() => {
      this.delayedRead = undefined
      if (revision !== this.revision || !this.ready) return
      this.read(source, text => this.present(source, text))
    }, 120)
  }

  private present(source: SelectionSource, text: string): void {
    if (!text.trim()) return
    const revision = this.revision
    const pending = { ...source, text, token: randomUUID() }
    this.pending = pending
    this.expiry = setTimeout(() => this.dismiss(), 8000)
    void this.show(pending).catch(() => {
      if (revision !== this.revision) return
      console.error('显示划词保存按钮失败')
      this.stop()
      this.failed()
    })
  }

  private async show(pending: PendingSelection): Promise<void> {
    if (!this.window || this.window.isDestroyed()) {
      const win = new BrowserWindow({
        width: WIDTH, height: HEIGHT, show: false, frame: false, focusable: false, alwaysOnTop: true,
        resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
        skipTaskbar: true, transparent: true, hasShadow: false,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false, backgroundThrottling: false }
      })
      this.window = win
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      win.webContents.on('will-navigate', (event, url) => {
        event.preventDefault()
        if (this.pending && url === `myclis-selection://save/${this.pending.token}`) this.confirm(this.pending)
      })
      win.once('closed', () => { if (this.window === win) { this.window = null; this.dismiss() } })
    }
    const win = this.window
    const point = screen.screenToDipPoint({ x: pending.x, y: pending.y })
    const area = screen.getDisplayNearestPoint(point).workArea
    win.setBounds({
      x: Math.round(Math.max(area.x, Math.min(point.x + 12, area.x + area.width - WIDTH))),
      y: Math.round(Math.max(area.y, Math.min(point.y + 12, area.y + area.height - HEIGHT))), width: WIDTH, height: HEIGHT
    })
    await win.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(buildPopupHtml(pending.token, this.theme()))}`)
    if (this.pending?.token === pending.token && this.ready && !win.isDestroyed()) win.showInactive()
  }

  private confirm(pending: PendingSelection): void {
    if (this.saving || !this.ready || this.pending?.token !== pending.token) return
    this.saving = true
    // 靠近屏幕边缘时浮窗可能覆盖原选区点，重读前隐藏但不改变源窗口焦点。
    this.window?.hide()
    this.read(pending, text => {
      if (this.pending?.token !== pending.token) return
      this.dismiss()
      if (text && text === pending.text) this.saveText(text)
    })
  }
}
