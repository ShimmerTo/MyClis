import { openSync, closeSync, readSync, statSync } from 'fs'
import type { TokenUsage } from '../../shared/types'
import type { CliAdapter, UsageSample } from '../cli/types'
import { locateSessionFile } from '../sessions/sessionFiles'
import { tryParse } from '../cli/transcript'

/** 跟随 CLI 原生 JSONL，并通过 adapter hook 归一 token/cost。 */
export class UsageWatcher {
  private timer: NodeJS.Timeout
  private file = ''
  private offset = 0
  private carry = Buffer.alloc(0)
  private seen = new Set<string>()
  private usage: TokenUsage = { input: 0, output: 0, total: 0, exact: false, updatedAt: Date.now() }
  private locatingAt = 0
  private model?: string

  constructor(
    private adapter: CliAdapter,
    private nativeSessionId: string,
    private onUsage: (usage: TokenUsage, model?: string) => void
  ) {
    this.timer = setInterval(() => this.tick(), 750)
    this.tick()
  }

  stop(): void {
    clearInterval(this.timer)
  }

  private tick(): void {
    if (!this.adapter.parseUsage) return
    if (!this.file) {
      if (Date.now() - this.locatingAt < 1800) return
      this.locatingAt = Date.now()
      this.file = locateSessionFile(this.adapter, this.nativeSessionId)?.file ?? ''
      if (!this.file) return
    }
    let size = 0
    try {
      size = statSync(this.file).size
    } catch {
      this.file = ''
      return
    }
    if (size < this.offset) {
      this.offset = 0
      this.carry = Buffer.alloc(0)
      this.seen.clear()
      this.usage = { input: 0, output: 0, total: 0, exact: false, updatedAt: Date.now() }
    }
    if (size === this.offset) return
    const take = Math.min(size - this.offset, 1024 * 1024)
    const buf = Buffer.alloc(take)
    let fd = -1
    try {
      fd = openSync(this.file, 'r')
      const read = readSync(fd, buf, 0, take, this.offset)
      this.offset += read
      this.consume(buf.subarray(0, read))
    } catch {
      // 下一轮继续；usage 展示不能影响 PTY。
    } finally {
      if (fd >= 0) closeSync(fd)
    }
  }

  private consume(chunk: Buffer): void {
    const data = Buffer.concat([this.carry, chunk])
    let start = 0
    let changed = false
    for (let i = 0; i < data.length; i += 1) {
      if (data[i] !== 10) continue
      const raw = data.subarray(start, i).toString('utf-8').replace(/\r$/, '')
      start = i + 1
      const line = tryParse(raw)
      const sample = line && this.adapter.parseUsage?.(line)
      if (sample && this.apply(sample)) changed = true
    }
    this.carry = data.subarray(start)
    if (changed) this.onUsage({ ...this.usage }, this.model)
  }

  private apply(sample: UsageSample): boolean {
    let changed = false
    if (sample.model && sample.model !== this.model) {
      this.model = sample.model
      changed = true
    }
    if (sample.key) {
      if (this.seen.has(sample.key)) return changed
      this.seen.add(sample.key)
      if (this.seen.size > 10000) this.seen = new Set([...this.seen].slice(-5000))
    }
    if (sample.cumulative) {
      this.usage.input = sample.input
      this.usage.output = sample.output
      this.usage.cachedInput = sample.cachedInput
      this.usage.reasoning = sample.reasoning
      this.usage.total = sample.total
      this.usage.exact = sample.exact
    } else {
      this.usage.input += sample.input
      this.usage.output += sample.output
      this.usage.cachedInput = (this.usage.cachedInput ?? 0) + (sample.cachedInput ?? 0)
      this.usage.reasoning = (this.usage.reasoning ?? 0) + (sample.reasoning ?? 0)
      this.usage.total += sample.total
      this.usage.cost = (this.usage.cost ?? 0) + (sample.cost ?? 0)
      this.usage.credit = (this.usage.credit ?? 0) + (sample.credit ?? 0)
      this.usage.exact = this.usage.exact || sample.exact
    }
    this.usage.updatedAt = Date.now()
    return true
  }
}
