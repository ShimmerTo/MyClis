import { app, BrowserWindow, Menu, nativeImage, Tray } from 'electron'
import { join } from 'path'
import { getTerminalManager, registerIpc } from './ipc'
import { registerNotesScheme } from './notes/assets'
import { loadConfig } from './config/store'
import { TITLEBAR_OVERLAY_HEIGHT, type ThemeKind } from '../shared/types'

Menu.setApplicationMenu(null)
// 自定义协议必须赶在 app ready 之前登记为特权 scheme（bypassCSP / stream 等）
registerNotesScheme()
// Windows 系统通知需要 AUMID 与安装包 appId 对齐，否则 toast 不显示或归到 electron
app.setAppUserModelId('com.myclis.app')

let win: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false

/**
 * 窗口/任务栏图标：与托盘图标同一套设计（build/icon.ico 是它的多尺寸版，打包时内嵌进 exe）。
 * dev 下任务栏取的是窗口图标，所以这里必须显式给；打包后 exe 内嵌图标同源，两边一致。
 */
const APP_ICON = join(app.getAppPath(), 'build', 'icon.png')

/** 与 theme.css 的各皮肤 --bg 对齐，避免启动瞬间闪错底色 */
const THEME_BG: Record<ThemeKind, string> = { paper: '#f5f6f8', light: '#e9efe0', dark: '#1b1c1f' }

/**
 * 与 theme.css 各皮肤的 --bg-panel / --text-dim 对齐：
 * 窗口原生按钮区（Window Controls Overlay）的颜色必须与自绘标题栏底色一致，否则右侧会出现接缝。
 * 运行中由渲染层 applyTheme() 通过 ui:titlebar 推最新值。
 */
const THEME_TITLEBAR: Record<ThemeKind, { color: string; symbolColor: string }> = {
  paper: { color: '#ffffff', symbolColor: '#676e78' },
  light: { color: '#f4f7ec', symbolColor: '#62705a' },
  dark: { color: '#252528', symbolColor: '#9a9ba1' }
}

function createWindow(): void {
  const theme = loadConfig().theme
  const titlebar = THEME_TITLEBAR[theme] ?? THEME_TITLEBAR.paper
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: THEME_BG[theme] ?? THEME_BG.paper,
    title: 'MyClis',
    icon: APP_ICON,
    // 无系统标题栏：标题栏区域交给渲染层自绘（执行页就是标签栏），
    // 右侧最小化/最大化/关闭仍用系统原生按钮（Window Controls Overlay）。
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: titlebar.color, symbolColor: titlebar.symbolColor, height: TITLEBAR_OVERLAY_HEIGHT },
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Chromium 内置 PDF 查看器是个插件：不开这个，iframe 里的 pdf 会空白或直接下载。
      // 便签的文件预览靠它（另一条前提是 CSP 放行 clichilds-note:）。
      plugins: true,
      // 最小化/被遮挡时也要继续刷新终端与计时，否则 rAF 与 setInterval 一起被冻住
      backgroundThrottling: false
    }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
    // dev 模式允许 F12 开关 DevTools；应用菜单为 null，Electron 默认快捷键不可用
    win.webContents.on('before-input-event', (_e, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') {
        win?.webContents.toggleDevTools()
      }
    })
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // 兜底：只允许停在渲染层自己的地址与便签的自定义协议上。拖放或链接一旦触发导航，
  // 整个界面会被目标文件顶掉，而本应用没有地址栏与菜单可以退回来。
  win.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    if (devUrl && url.startsWith(devUrl)) return
    if (url.startsWith('clichilds-note:')) return
    event.preventDefault()
  })

  win.on('close', (event) => {
    if (isQuitting) return
    // 设置页可配：隐藏到托盘继续跑（默认），或直接退出应用
    if (loadConfig().closeToTray) {
      event.preventDefault()
      win?.hide()
      return
    }
    isQuitting = true
  })
  win.on('closed', () => {
    win = null
  })
}

function showWindow(): void {
  if (!win) createWindow()
  if (win?.isMinimized()) win.restore()
  win?.show()
  win?.focus()
}

function updateTrayMenu(): void {
  if (!tray) return
  let count = 0
  try {
    count = getTerminalManager().sessions().filter((item) => item.role === 'main').length
  } catch {
    // IPC 尚未初始化
  }
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 MyClis', click: showWindow },
    { label: `进行中的会话：${count}`, enabled: false },
    { type: 'separator' },
    { label: '退出', click: () => { isQuitting = true; app.quit() } }
  ]))
}

/**
 * 托盘图标：32x32 PNG（圆润圆角黑底 + 白 Mclis），是应用 Logo 的原始设计 ——
 * build/icon.ico / build/icon.png 是它的多尺寸版（scripts/gen-icon.cjs 一并重绘），窗口与任务栏图标同源。
 * 之前用 SVG data URL 走 createFromDataURL，而 nativeImage 只认 PNG/JPEG，
 * SVG 会被解成空图 —— 托盘项建出来了但图标是全透明，看起来就是「关闭后托盘没有图标」。
 * 这里直接内联 PNG base64，不依赖磁盘资源文件，打包后也不会丢。
 */
const TRAY_ICON_PNG =
  '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'

function createTray(): void {
  if (tray) return
  tray = new Tray(nativeImage.createFromDataURL(`data:image/png;base64,${TRAY_ICON_PNG}`))
  tray.setToolTip('MyClis')
  tray.on('click', showWindow)
  tray.on('double-click', showWindow)
  updateTrayMenu()
  setInterval(updateTrayMenu, 2000).unref()
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) app.quit()
else app.on('second-instance', showWindow)

app.whenReady().then(() => {
  if (!gotLock) return
  registerIpc(() => win)
  createWindow()
  createTray()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  // 托盘模式：窗口关了也继续跑，靠托盘菜单退出；
  // 直接关闭模式：close 里已置 isQuitting，这里把进程一并收掉。
  if (isQuitting) app.quit()
})

app.on('before-quit', () => {
  isQuitting = true
})
