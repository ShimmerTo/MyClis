import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { ThemeKind } from '@shared/types'
import { dirBase } from './notes'
import { toast } from './components/ToastHost'
import '@xterm/xterm/css/xterm.css'

const FALLBACK: Record<ThemeKind, { background: string; foreground: string; selectionBackground: string }> = {
  paper: { background: '#ffffff', foreground: '#1f2328', selectionBackground: '#cfe3ff' },
  light: { background: '#eaf1e1', foreground: '#26301f', selectionBackground: '#c9deb4' },
  dark: { background: '#1b1c1f', foreground: '#e6e6e8', selectionBackground: '#3a4a63' }
}

/** 终端配色跟随皮肤变量（改一处三份皮肤同时生效） */
function cssTheme(): (typeof FALLBACK)['dark'] {
  const kind = (document.documentElement.dataset.theme ?? 'dark') as ThemeKind
  const fb = FALLBACK[kind] ?? FALLBACK.dark
  const cs = getComputedStyle(document.documentElement)
  const v = (name: string, fallback: string): string => cs.getPropertyValue(name).trim() || fallback
  return {
    background: v('--term-bg', fb.background),
    foreground: v('--text', fb.foreground),
    selectionBackground: v('--term-selection', fb.selectionBackground)
  }
}

async function copyText(text: string): Promise<void> {
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.focus()
    ta.setSelectionRange(0, text.length)
    ;(document as unknown as { execCommand: (cmd: string) => boolean }).execCommand('copy')
    ta.remove()
  }
}

interface Pooled {
  id: string
  term: Terminal
  fit: FitAddon
  host: HTMLDivElement
  /** 最近一次成功发给主进程的 pty 尺寸：没变化就不重发 */
  sent?: { cols: number; rows: number }
  dispose: () => void
}

/**
 * 终端实例池：xterm 不随 React 组件销毁，切页/切会话只把它的 DOM 搬进搬出。
 * 这样返回同一个终端时滚动回看、正在跑的输出都还在，只有会话真的退出才销毁。
 */
const pool = new Map<string, Pooled>()
/**
 * 搬走时的视口位置。host 离开文档后浏览器会把 `.xterm-viewport` 的 scrollTop 归零，
 * xterm 会当成「用户滚到顶部」，再搬回来就停在最老的一屏——所以离开前记下、回来后还原。
 */
const scrollMemo = new Map<string, { line: number; atBottom: boolean }>()

let exitHooked = false

function hookExit(): void {
  if (exitHooked) return
  exitHooked = true
  window.clichilds.onTermExit((p) => disposeTerminal(p.id))
}

function fitNow(entry: Pooled): void {
  if (!entry.host.isConnected || entry.host.clientWidth < 20 || entry.host.clientHeight < 20) return
  try {
    entry.fit.fit()
  } catch {
    return
  }
  // ResizeObserver 与挂载后的 rAF 会对同一尺寸各触发一次；ConPTY 收到 resize 即使尺寸相同
  // 也可能要求 CLI 整屏重画。这里把重复通知挡掉，避免无意义的闪屏。
  const { cols, rows } = entry.term
  if (entry.sent && entry.sent.cols === cols && entry.sent.rows === rows) return
  entry.sent = { cols, rows }
  window.clichilds.termResize(entry.id, cols, rows)
}

function create(termId: string): Pooled {
  const host = document.createElement('div')
  host.className = 'terminal-host'
  const term = new Terminal({
    fontFamily: 'Cascadia Code, Consolas, "Courier New", monospace',
    fontSize: 13,
    cursorBlink: true,
    scrollback: 8000,
    rightClickSelectsWord: true,
    theme: cssTheme()
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.open(host)

  const onData = term.onData((data) => window.clichilds.termWrite(termId, data))
  const offData = window.clichilds.onTermData((p) => {
    if (p.id === termId) term.write(p.data)
  })
  // 先接上实时流，再补回放断连期间的输出（顺序反了会丢或重复）
  window.clichilds
    .termAttach(termId)
    .then((buf) => {
      if (buf) term.write(buf)
    })
    .catch(() => undefined)

  const insertPaste = async (text: string): Promise<void> => {
    // 剪贴板是截图时：主进程落盘 PNG，把绝对路径粘进终端；否则按原样粘文本
    try {
      const imgPath = await window.clichilds.pasteImage()
      if (imgPath) {
        term.paste(/\s/.test(imgPath) ? `"${imgPath}"` : imgPath)
        return
      }
    } catch {
      // 主进程异常时退回文本粘贴
    }
    if (text) term.paste(text)
  }

  // 右键菜单「粘贴」没有 DOM 事件可用，只能自己读剪贴板
  const pasteFromClipboard = async (): Promise<void> => {
    let text = ''
    try {
      text = await navigator.clipboard.readText()
    } catch {
      // 读不到文本时只处理截图
    }
    await insertPaste(text)
  }

  // 粘贴统一由原生 paste 事件接管：xterm 的 custom key handler 返回 false 只表示
  // 「我不处理」，不会阻止浏览器默认动作——它自己挂在 textarea 上的监听还会再插一遍，
  // 于是同一段文本粘出两份。这里在 host 捕获阶段先一步按下事件（preventDefault +
  // stopImmediatePropagation 双保险），文本也从事件里同步取；开头再看一眼 defaultPrevented，
  // 保证即便出现重复监听，同一次粘贴也只插入一份。
  const onPaste = (e: ClipboardEvent): void => {
    if (e.defaultPrevented) return
    e.preventDefault()
    e.stopImmediatePropagation()
    void insertPaste(e.clipboardData?.getData('text/plain') ?? '')
  }
  host.addEventListener('paste', onPaste, true)

  /**
   * 回看状态（视口不在最新一屏）下接管方向键与回车。
   * 事故复盘：qoder 的弹窗里 ↑/↓ = 移动选中项。用户滚上去读方案、再按 ↓ 想「滚下来」时，
   * 方向键进了弹窗，选中项悄悄变成第 2 项（以 Goal 执行），回车就提交了一个没看见的选项。
   * 所以视口不在底部时：方向键只滚本地回看（同主流终端），一次按住期间也不放手——
   * 滚到底后继续按住的方向键不会漏进弹窗；回车则先跳回最新画面并提示，再按一次才发出。
   */
  let arrowHold = false
  term.attachCustomKeyEventHandler((e) => {
    if (!e.ctrlKey && !e.altKey && !e.metaKey) {
      if (e.type === 'keyup') {
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') arrowHold = false
        return true
      }
      if (e.type === 'keydown' && !e.isComposing) {
        const buffer = term.buffer.active
        const offBottom = buffer.viewportY < buffer.baseY
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          // 带 Shift 的是 CLI 自己的滚动键（qoder: Shift+↑/↓），不在这里拦
          if (arrowHold || (!e.shiftKey && offBottom)) {
            arrowHold = true
            e.preventDefault()
            e.stopImmediatePropagation()
            term.scrollLines(e.key === 'ArrowUp' ? -1 : 1)
            return false
          }
          return true
        }
        if (e.key === 'Enter' && !e.shiftKey && offBottom) {
          e.preventDefault()
          e.stopImmediatePropagation()
          term.scrollToBottom()
          toast('已回到最新画面：滚动回看时回车不会直接发出，看清后再按一次')
          return false
        }
      }
    }
    if (e.type !== 'keydown' || !e.ctrlKey || e.altKey) return true
    const k = e.key.toLowerCase()
    // 自己接管的键要 preventDefault，否则浏览器默认的 copy/paste 会和这里叠加成两份
    // 唯一的例外是粘贴：插入交给上面的 paste 监听，这里只拦下发给 CLI 的 ^V
    if (((k === 'c' && term.hasSelection()) || (k === 'insert' && !e.shiftKey))) {
      e.preventDefault()
      e.stopImmediatePropagation()
      void copyText(term.getSelection())
      return false
    }
    if (k === 'c' && e.shiftKey) {
      e.preventDefault()
      e.stopImmediatePropagation()
      void copyText(term.getSelection())
      return false
    }
    if (k === 'v' || (k === 'insert' && e.shiftKey)) {
      return false
    }
    if (k === 'a' && e.shiftKey) {
      e.preventDefault()
      e.stopImmediatePropagation()
      term.selectAll()
      return false
    }
    return true
  })

  // 焦点丢掉时会漏掉 keyup，按住状态在这里兜底清零，否则方向键会一直被当成回看滚动
  const onBlur = (): void => {
    arrowHold = false
  }
  term.textarea?.addEventListener('blur', onBlur)

  /**
   * Ctrl+滚轮直接调本终端字号：上滚 +1、下滚 -1，区间与右键菜单的「字号放大/缩小」一致（10–24）。
   * 注册在滚轮失灵修复之前并掐断事件：失灵修复只管「向下滚」，Ctrl 组合先在这里消化掉，
   * 两者不会同一次滚动里都触发。preventDefault 同时挡掉浏览器的整页视觉缩放。
   */
  const onWheelZoom = (e: WheelEvent): void => {
    if (!e.ctrlKey || e.deltaY === 0) return
    e.preventDefault()
    e.stopImmediatePropagation()
    const size = term.options.fontSize ?? 13
    const next = Math.min(24, Math.max(10, size + (e.deltaY < 0 ? 1 : -1)))
    if (next === size) return
    term.options.fontSize = next
    fitNow(entry)
  }
  host.addEventListener('wheel', onWheelZoom, { capture: true, passive: false })

  /**
   * 滚轮修复：DOM 滚动条已顶到最大、但 xterm 内部视口还没到底时，滚轮下滑会彻底失灵。
   * xterm 的 handleWheel 走 DOM scrollTop：write 被浏览器钳在最大值上就不会产生 scroll 事件，
   * 内部 ydisp 一动不动；而这层错位没有自愈时机（静态画面没有 syncScrollArea 触发器），
   * 于是滚轮「往下滚不动」，只能靠右侧「滚动到最底部」按钮（它走内部 API，绕开 DOM）。
   * 事故复盘：qoder 弹窗里用户滚上去读方案，滚轮再也回不到最新一屏。
   * 这里在捕获阶段只接管这一种情形（主缓冲、无鼠标上报、向下、内部未到底、DOM 已到底）：
   * 走和按钮同一条路（内部 scrollToBottom + 钉视口），其余滚轮行为一律不碰。
   */
  const onWheelStuck = (e: WheelEvent): void => {
    if (e.deltaY <= 0 || e.shiftKey) return
    const buffer = term.buffer.active
    if (buffer.type !== 'normal' || buffer.viewportY >= buffer.baseY) return
    if (term.modes.mouseTrackingMode !== 'none') return
    const vp = viewportOf(entry)
    if (!vp) return
    if (vp.scrollTop < vp.scrollHeight - vp.clientHeight - 1) return
    e.preventDefault()
    e.stopImmediatePropagation()
    term.scrollToBottom()
    pinViewport(entry)
  }
  host.addEventListener('wheel', onWheelStuck, { capture: true, passive: false })

  // TUI（codex / qoder / codebuddy）会接管鼠标，此时按住 Shift 拖拽才走终端选择
  const onMouseUp = (): void => {
    const sel = term.getSelection()
    if (sel) void copyText(sel)
  }
  host.addEventListener('mouseup', onMouseUp)

  /**
   * 右键前的选区快照。xterm 开了 rightClickSelectsWord：右键点在选区外会把选区改写成
   * 光标下的一个词，而且它的 contextmenu 监听挂在子节点上、先于宿主监听执行。
   * 所以只能在 mousedown 的捕获阶段先把选区记下来，菜单动作只消费这份快照，
   * 否则「加入便签」会静默取到一段不是用户选的文本。
   */
  let rightClickSelection = ''
  const onMouseDown = (e: MouseEvent): void => {
    if (e.button === 2) rightClickSelection = term.getSelection()
  }
  host.addEventListener('mousedown', onMouseDown, true)

  const onContextMenu = (e: MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    // 原生右键菜单：终端复制一般要靠鼠标选中，这里同时给出键盘入口
    window.clichilds.showTermMenu({ id: termId, hasSelection: !!rightClickSelection.trim() })
  }
  host.addEventListener('contextmenu', onContextMenu)

  const offMenu = window.clichilds.onTermMenuAction((p) => {
    if (p.id !== termId) return
    term.focus()
    if (p.action === 'copy') void copyText(term.getSelection())
    if (p.action === 'paste') void pasteFromClipboard()
    if (p.action === 'selectAll') term.selectAll()
    if (p.action === 'clear') term.clear()
    if (p.action === 'addNote') {
      const text = rightClickSelection
      rightClickSelection = ''
      if (!text.trim() || !p.workDir) return
      void window.clichilds
        .notesAdd({ workDir: p.workDir, kind: 'text', content: text })
        .then((note) => toast(`已加入便签（${dirBase(note.workDir)}）：${note.title}`))
        .catch((e: unknown) => toast(e instanceof Error ? e.message : String(e)))
    }
    if (p.action === 'zoomIn' || p.action === 'zoomOut') {
      const size = term.options.fontSize ?? 13
      term.options.fontSize = Math.min(24, Math.max(10, size + (p.action === 'zoomIn' ? 1 : -1)))
      fitNow(entry)
    }
  })

  const ro = new ResizeObserver(() => fitNow(entry))
  ro.observe(host)

  const mo = new MutationObserver(() => {
    term.options.theme = cssTheme()
  })
  mo.observe(document.documentElement, { attributeFilter: ['data-theme'] })

  const entry: Pooled = { id: termId, term, fit, host, dispose: () => undefined }
  entry.dispose = () => {
    ro.disconnect()
    mo.disconnect()
    host.removeEventListener('mouseup', onMouseUp)
    host.removeEventListener('mousedown', onMouseDown, true)
    host.removeEventListener('contextmenu', onContextMenu)
    host.removeEventListener('paste', onPaste, true)
    host.removeEventListener('wheel', onWheelZoom, true)
    host.removeEventListener('wheel', onWheelStuck, true)
    term.textarea?.removeEventListener('blur', onBlur)
    onData.dispose()
    offData()
    offMenu()
    window.clichilds.termDetach(termId)
    term.dispose()
  }
  return entry
}

/** xterm 的滚动视口元素：DOM 上的 scrollTop 才是真正决定画面停在哪一屏的东西 */
function viewportOf(entry: Pooled): HTMLElement | null {
  return entry.host.querySelector<HTMLElement>('.xterm-viewport')
}

/**
 * 把视口钉到 memo 记录的位置。
 * xterm 的 scrollToBottom() / scrollToLine() 只改内部的 ydisp，且目标位置与 ydisp 相同时
 * scrollLines(0) 直接 return（空操作）；而宿主搬出文档时浏览器会把 .xterm-viewport 的
 * scrollTop 清零。两件事凑一起，本来停在最底部的终端搬回来反而停在最老的一屏，
 * 所以这里在 xterm 内部状态之外，把 DOM 的 scrollTop 也显式顶到对应位置。
 */
function pinViewport(entry: Pooled, memo?: { line: number; atBottom: boolean }): void {
  const vp = viewportOf(entry)
  if (!vp) return
  const lines = entry.term.buffer.active.length
  const bottom = Math.max(0, vp.scrollHeight - vp.clientHeight)
  // 行高没暴露，用「滚动区总高 ÷ 缓冲区行数」反推；误差只会让还原位置差几个像素
  const top =
    !memo || memo.atBottom || lines <= 0
      ? bottom
      : Math.round((memo.line * vp.scrollHeight) / lines)
  if (Math.abs(vp.scrollTop - top) < 1) return
  vp.scrollTop = top
}

/** 把该会话的终端搬进容器；实例还在就直接复用，等于原地保留画面 */
export function attachTerminal(termId: string, container: HTMLElement): void {
  hookExit()
  let entry = pool.get(termId)
  if (!entry) {
    entry = create(termId)
    pool.set(termId, entry)
  }
  const memo = scrollMemo.get(termId)
  scrollMemo.delete(termId)
  if (entry.host.parentElement !== container) container.appendChild(entry.host)
  requestAnimationFrame(() => {
    if (entry.host.parentElement !== container) return
    fitNow(entry)
    // 还原必须排在 fit 之后：行高与 scrollTop 都是在这一步重算的
    if (memo?.atBottom) entry.term.scrollToBottom()
    else if (memo) entry.term.scrollToLine(memo.line)
    pinViewport(entry, memo)
    entry.term.focus()
  })
}

/** 滚动条顶部浮出的图标：滚到最顶 */
export function scrollTerminalToTop(termId: string): void {
  const entry = pool.get(termId)
  if (!entry) return
  entry.term.scrollToTop()
  pinViewport(entry, { line: 0, atBottom: false })
  entry.term.focus()
}

/** 滚动条底部浮出的图标：滚到最底 */
export function scrollTerminalToBottom(termId: string): void {
  const entry = pool.get(termId)
  if (!entry) return
  entry.term.scrollToBottom()
  pinViewport(entry)
  entry.term.focus()
}

/** 让某个终端重新拿到键盘焦点：便签浮窗关闭后要把焦点还给终端，否则敲键盘没反应 */
export function focusTerminal(termId: string): void {
  pool.get(termId)?.term.focus()
}

/** 只是把 DOM 搬走，实例与主进程的实时流都不断 */
export function detachTerminal(termId: string): void {
  const entry = pool.get(termId)
  if (!entry) return
  const buffer = entry.term.buffer.active
  scrollMemo.set(termId, { line: buffer.viewportY, atBottom: buffer.viewportY >= buffer.baseY })
  entry.host.remove()
}

/** 会话真的退出时才销毁 */
export function disposeTerminal(termId: string): void {
  const entry = pool.get(termId)
  scrollMemo.delete(termId)
  if (!entry) return
  pool.delete(termId)
  entry.host.remove()
  entry.dispose()
}
