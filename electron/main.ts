import { app, BrowserWindow, dialog, Menu, nativeImage, Tray } from 'electron'
import { join } from 'path'
import { expandCodebuddyPortPool } from './cli/portpool'
import { getTerminalManager, getUpdateManager, registerIpc } from './ipc'
import { registerNotesScheme } from './notes/assets'
import { loadConfig } from './config/store'
import { dataDirectoryErrorMessage, initializeDataDirectory } from './config/dataDirectory'
import { TITLEBAR_OVERLAY_HEIGHT, type ThemeKind } from '../shared/types'

Menu.setApplicationMenu(null)
// 自定义协议必须赶在 app ready 之前登记为特权 scheme（bypassCSP / stream 等）
registerNotesScheme()
// Windows 系统通知需要 AUMID 与安装包 appId 对齐，否则 toast 不显示或归到 electron
app.setAppUserModelId('com.myclis.app')

let win: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false
let disposeIpc: (() => void) | undefined

/**
 * 窗口/任务栏/托盘图标共用 build/icon.png：与 exe 内嵌的 build/icon.ico 同一套设计
 * （scripts/gen-icon.cjs 一并重绘）。dev 下任务栏取的是窗口图标，所以这里必须显式给；
 * 打包后 exe 内嵌图标同源，两边一致。托盘之前用内联 base64，那份 PNG 的 IDAT 校验和已损坏，
 * Chromium 解码结果为空图 —— 托盘项建出来了但看不见图标，所以一律改从这份完整资源读取。
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
    event.preventDefault()
    app.quit()
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

function createTray(): void {
  if (tray) return
  tray = new Tray(nativeImage.createFromPath(APP_ICON).resize({ width: 16 }))
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
  let migrationWarning: string | undefined
  try {
    migrationWarning = initializeDataDirectory()
  } catch (error) {
    dialog.showErrorBox('数据目录不可用', dataDirectoryErrorMessage(error))
    app.quit()
    return
  }
  disposeIpc = registerIpc(() => win)
  // 已经下载好的安装包在本次启动就装掉：拉起 Installer 后立刻退出，
  // 不能再往下建窗口 —— 留在前台会挡住 Installer 覆盖程序文件。
  if (getUpdateManager()?.installPending()) return
  // 手动开的 codebuddy 撞端口同样表现为「进程活着、终端没有任何输出」，装了它就顺手
  // 把它的端口池补足。MyClis 起的终端每次现探测端口，不依赖这里。不阻塞建窗口。
  void expandCodebuddyPortPool().catch((error) => console.error('扩容 codebuddy 端口池失败', error))
  // 检查更新放在最后且不阻塞：失败一律静默，结果由使者推给设置页
  void getUpdateManager()?.checkOnStartup().catch((error: unknown) => console.error('检查更新失败', error))
  createWindow()
  createTray()
  if (migrationWarning) void dialog.showMessageBox({ type: 'warning', title: '数据目录迁移未完成', message: migrationWarning })
    .catch((error: unknown) => console.error('显示数据目录提醒失败', error))
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
  disposeIpc?.()
  disposeIpc = undefined
})
