import { randomUUID } from 'crypto'
import { Terminal } from '@xterm/headless'
import type { ChildApproval, CliId } from '../../shared/types'

interface Menu {
  prompt: string
  options: ChildApproval['options']
  selected: number
}

export function detectApproval(cli: CliId, screen: string): Menu | undefined {
  if (!['codebuddy', 'qoder', 'codex'].includes(cli)) return undefined
  const lines = screen.split('\n').map((line) => line.trim().replace(/^[│┃]\s?|\s?[│┃]$/g, '').trim())
  let question = -1
  lines.forEach((line, i) => {
    if (/^(?:Do you want to (?:proceed|allow)|Would you like to (?:run|allow)|Allow .*\?|Permission required|是否(?:允许|批准|继续)|要(?:允许|执行|继续).*\?)/i.test(line)) question = i
  })
  if (question < 0) return undefined
  const tail = lines.slice(question + 1)
  const frame = (line: string): boolean => !line || /^[╰╯└┘─━┌┐╭╮]+$/.test(line)
  // 菜单下方的快捷键提示只当噪音：codebuddy 是 Enter to confirm · Esc to reject，
  // qoder 是 select · Esc to deny · ↑↓ to navigate，codex 是 ? for shortcuts
  const hint = (line: string): boolean =>
    /esc|enter|回车|confirm|select|navigate|确认|选择|取消|拒绝|↑↓|for shortcuts/i.test(line)
  const options: Menu['options'] = []
  let selected = -1
  let end = -1
  for (let i = 0; i < tail.length; i++) {
    const line = tail[i]
    if (frame(line)) continue
    // 选项编号两种版式：codebuddy 的「❯ 1. Yes」与 qoder 的「→ (1) Allow」，选中标记在编号之前
    const match = /^([❯›>●→])?\s*(?:\(([1-9])\)|([1-9])\s*[.)、])\s+(.+)$/.exec(line)
    if (match) {
      const value = match[2] ?? match[3]
      // 编号必须从 1 连续递增：滚动后残缺的菜单、正文里的编号列表都不能算菜单
      if (Number(value) !== options.length + 1) return undefined
      if (match[1]) {
        if (selected !== -1) return undefined
        selected = options.length
      }
      options.push({ value, label: match[4] })
      end = i
      continue
    }
    if (end < 0) continue
    if (i === end + 1 && !hint(line) && !/^[A-Z]/.test(line)) {
      // 窗口变窄时选项文案会折行，紧跟其后的非提示行并入上一项（句首大写视为新内容）
      options[options.length - 1].label += ` ${line}`
      end = i
      continue
    }
    break
  }
  if (selected < 0 || options.length < 2 || options.length > 9) return undefined
  // 菜单必须还留在屏幕底部：选项块之后只允许框线与快捷键提示，出了正文说明菜单已经结束
  if (tail.slice(end + 1).some((line) => !frame(line) && !hint(line))) return undefined
  if (!options.some((option) => /^(?:yes|allow|approve|是|允许|同意)/i.test(option.label))) return undefined
  if (!options.some((option) => /^(?:no\b|deny|reject|cancel|否|拒绝|取消)/i.test(option.label))) return undefined
  return { prompt: lines.slice(0, question + 1).join('\n').trim().slice(-6000), options, selected }
}

export class ApprovalScreen {
  private terminal: Terminal
  private pending = 0
  private revision = 0
  private disposed = false
  private timer?: NodeJS.Timeout
  private menu?: Menu
  private approval?: ChildApproval
  private consumed?: string

  constructor(private cli: CliId, private changed: () => void) {
    this.terminal = new Terminal({ cols: 120, rows: 30, scrollback: 0, allowProposedApi: true })
  }

  write(data: string): void {
    this.pending++
    const revision = this.revision
    if (this.timer) clearTimeout(this.timer)
    this.terminal.write(data, () => {
      if (this.disposed) return
      this.pending--
      if (this.pending || revision !== this.revision) return
      this.timer = setTimeout(() => {
        this.timer = undefined
        if (this.pending || this.disposed) return
        const buffer = this.terminal.buffer.active
        const lines = Array.from({ length: this.terminal.rows }, (_, i) =>
          buffer.getLine(buffer.baseY + i)?.translateToString(true) ?? '')
        const menu = detectApproval(this.cli, lines.join('\n'))
        const key = menu ? JSON.stringify([menu.prompt, menu.options]) : undefined
        const prior = this.menu ? JSON.stringify([this.menu.prompt, this.menu.options]) : undefined
        if (!menu) this.consumed = undefined
        this.menu = menu
        this.approval = menu && key !== this.consumed
          ? { id: key === prior && this.approval ? this.approval.id : randomUUID(), prompt: menu.prompt, options: menu.options }
          : undefined
        this.changed()
      }, 500)
    })
  }

  current(): ChildApproval | undefined {
    return this.pending || this.timer ? undefined : this.approval
  }

  blocksAutoInput(): boolean {
    return !!(this.pending || this.timer || this.menu)
  }

  choose(approvalId: string, value: string): string {
    const approval = this.current()
    const menu = this.menu
    if (!approval || !menu || approval.id !== approvalId) throw new Error('审批提示已变化，请重新读取子 CLI 状态')
    const index = approval.options.findIndex((option) => option.value === value)
    if (index < 0) throw new Error('只能选择当前审批菜单中列出的选项')
    const delta = index - menu.selected
    this.consumed = JSON.stringify([menu.prompt, menu.options])
    this.approval = undefined
    return (delta < 0 ? '\x1b[A' : '\x1b[B').repeat(Math.abs(delta)) + '\r'
  }

  invalidate(): void {
    this.revision++
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.approval = undefined
    this.menu = undefined
    this.consumed = undefined
  }

  resize(cols: number, rows: number): void {
    this.invalidate()
    this.terminal.resize(cols, rows)
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    this.terminal.dispose()
  }
}
