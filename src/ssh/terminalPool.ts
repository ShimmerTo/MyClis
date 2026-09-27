import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { SshTerminalData } from '../../packages/ssh/src/contracts'
import { reportSshError, sshApi, sshError } from './store'
import '@xterm/xterm/css/xterm.css'

interface Entry {
  id: string
  term: Terminal
  fit: FitAddon
  host: HTMLDivElement
  disposed: boolean
  lease?: symbol
  queue: Promise<void>
  attached: boolean
  seq: number
  stopStream?: () => void
  stopView?: () => void
  stopExit: () => void
  stopInput: () => void
  stopPaste: () => void
}
const pool = new Map<string, Entry>()
const MAX_PENDING_BYTES = 1024 * 1024

function theme() {
  const css = getComputedStyle(document.documentElement)
  return {
    background: css.getPropertyValue('--term-bg').trim() || css.getPropertyValue('--bg-input').trim() || '#252528',
    foreground: css.getPropertyValue('--text').trim() || '#e6e6e8',
    cursor: css.getPropertyValue('--text').trim() || '#e6e6e8',
    selectionBackground: css.getPropertyValue('--term-selection').trim() || '#52658588'
  }
}

function enqueue(entry: Entry, operation: () => Promise<void>): void {
  entry.queue = entry.queue.then(operation).catch((error: unknown) => reportSshError(sshError(error)))
}

function create(id: string): Entry {
  const host = document.createElement('div')
  host.className = 'ssh-xterm-host'
  const term = new Terminal({
    fontFamily: 'Cascadia Code, Consolas, monospace', fontSize: 13,
    cursorBlink: true, scrollback: 4000, disableStdin: true, theme: theme()
  })
  const fit = new FitAddon()
  let entry: Entry | undefined
  try {
    term.loadAddon(fit)
    term.open(host)
    const input = term.onData((data) => {
      if (!entry?.attached || !entry.lease || entry.disposed) return
      void sshApi().terminalWrite({ id, data }).catch((error: unknown) => reportSshError(sshError(error)))
    })
    const onPaste = (event: ClipboardEvent): void => {
      event.preventDefault()
      event.stopImmediatePropagation()
      if (!entry?.attached || !entry.lease) return
      const text = event.clipboardData?.getData('text/plain') ?? ''
      if (text) term.paste(text)
      else if (event.clipboardData?.files.length) reportSshError('SSH 终端仅支持纯文本粘贴，不上传图片或插入本机文件路径。')
    }
    host.addEventListener('paste', onPaste, true)
    entry = {
      id, term, fit, host, disposed: false, attached: false, seq: -1, queue: Promise.resolve(),
      stopInput: () => input.dispose(),
      stopPaste: () => host.removeEventListener('paste', onPaste, true),
      stopExit: sshApi().onTerminalExit((event) => { if (event.id === id) disposeSshTerminal(id) })
    }
    pool.set(id, entry)
    return entry
  } catch (error: unknown) {
    term.dispose()
    host.remove()
    throw error
  }
}

function apply(entry: Entry, event: SshTerminalData): void {
  if (entry.disposed || event.seq <= entry.seq) return
  entry.seq = event.seq
  entry.term.write(event.data)
}

async function attach(entry: Entry, lease: symbol): Promise<void> {
  if (entry.disposed || entry.lease !== lease) return
  let replayed = false
  let overflow = false
  let bytes = 0
  const buffered: SshTerminalData[] = []
  entry.stopStream = sshApi().onTerminalData((event) => {
    if (event.id !== entry.id || entry.disposed) return
    if (replayed) { apply(entry, event); return }
    bytes += event.data.length * 2
    if (bytes > MAX_PENDING_BYTES) { overflow = true; return }
    buffered.push(event)
  })
  try {
    const replay = await sshApi().terminalAttach(entry.id)
    entry.attached = true
    if (entry.disposed || entry.lease !== lease) return
    if (overflow) throw new Error('SSH_REPLAY_OVERFLOW')
    // attach 是有界完整回放，不能追加到上一轮 xterm 内容造成重复。
    entry.term.reset()
    entry.seq = -1
    apply(entry, replay)
    buffered.sort((a, b) => a.seq - b.seq).forEach((event) => apply(entry, event))
    replayed = true
    entry.term.options.disableStdin = false
  } catch (error: unknown) {
    entry.term.options.disableStdin = true
    entry.stopStream?.()
    entry.stopStream = undefined
    reportSshError(overflow ? '这个终端在初始化时涌出了太多内容，已经暂停输入。请先收起再打开，只显示最近的一段。' : sshError(error))
  }
}

/** 挂载现有远程 shell 的视图；绝不创建 shell、连接或注入命令。 */
export function mountSshTerminal(id: string, container: HTMLElement): () => void {
  const entry = pool.get(id) ?? create(id)
  if (entry.lease) throw new Error('SSH_TERMINAL_ALREADY_VISIBLE')
  const lease = Symbol(id)
  entry.lease = lease
  container.appendChild(entry.host)
  entry.term.options.theme = theme()
  let lastSize = ''
  let resizing = false
  let stopped = false
  const resize = async (): Promise<void> => {
    if (stopped || resizing || entry.disposed || !entry.attached || !container.isConnected || container.clientHeight < 20 || container.clientWidth < 20) return
    resizing = true
    try {
      entry.fit.fit()
      const size = `${entry.term.cols}:${entry.term.rows}`
      if (size === lastSize) return
      await sshApi().terminalResize({ id, cols: entry.term.cols, rows: entry.term.rows })
      lastSize = size
    } catch (error: unknown) {
      reportSshError(sshError(error))
    } finally { resizing = false }
  }
  const observer = new ResizeObserver(() => { void resize() })
  observer.observe(container)
  const themeObserver = new MutationObserver(() => { entry.term.options.theme = theme(); void resize() })
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  entry.stopView = () => { stopped = true; observer.disconnect(); themeObserver.disconnect() }
  enqueue(entry, async () => { await attach(entry, lease); if (entry.lease === lease) await resize() })
  return () => {
    if (entry.lease !== lease) return
    entry.lease = undefined
    entry.term.options.disableStdin = true
    entry.stopView?.()
    entry.stopView = undefined
    entry.host.remove()
    entry.stopStream?.()
    entry.stopStream = undefined
    enqueue(entry, async () => {
      if (entry.disposed || !entry.attached) return
      await sshApi().terminalDetach(id)
      entry.attached = false
    })
  }
}

/** 只有远程退出、明确关闭或快照移除时才销毁池内 xterm。 */
export function disposeSshTerminal(id: string): void {
  const entry = pool.get(id)
  if (!entry) return
  entry.disposed = true
  entry.lease = undefined
  entry.stopView?.()
  entry.stopStream?.()
  entry.stopExit()
  entry.stopInput()
  entry.stopPaste()
  entry.term.dispose()
  entry.host.remove()
  pool.delete(id)
}

/** 清理已断开/删除连接的终端，不影响隐藏中的存活 shell。 */
export function reconcileSshTerminals(ids: readonly string[]): void {
  const live = new Set(ids)
  for (const id of pool.keys()) if (!live.has(id)) disposeSshTerminal(id)
}
