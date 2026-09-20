import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { CH } from '../../shared/types'
import type { HistoryChild, HistoryRecord, TerminalInfo } from '../../shared/types'

/** 只留最近这么多条主会话（子终端嵌在里面，一起淘汰） */
const KEEP = 300

function historyPath(): string {
  return join(app.getPath('userData'), 'clichilds', 'history.json')
}

type Emitter = (channel: string, payload: unknown) => void

/** 同一条原生会话的标识；没有原生 id 的记录各算各的 */
const nativeKey = (record: HistoryRecord): string =>
  record.nativeSessionId ? `${record.cli}|${record.nativeSessionId}` : ''

/**
 * 一条原生会话只留一条记录：resume 是接着同一条对话跑，不是新对话。
 * 列表最新的在前，所以保留先出现的那条，把重复记录的子终端并进去。
 */
function dedupe(records: HistoryRecord[]): HistoryRecord[] {
  const out: HistoryRecord[] = []
  const byNative = new Map<string, HistoryRecord>()
  for (const record of records) {
    const key = nativeKey(record)
    const kept = key ? byNative.get(key) : undefined
    if (!kept) {
      out.push(record)
      if (key) byNative.set(key, record)
      continue
    }
    for (const child of record.children) {
      if (!kept.children.some((c) => c.termId === child.termId)) kept.children.push(child)
    }
    if (record.startedAt < kept.startedAt) kept.startedAt = record.startedAt
  }
  return out
}

/**
 * 会话历史：跨重启记住「本应用启动过哪些 CLI 原生会话」。
 * 只在主进程里读写（渲染层一律不写），读-改-写之间不夹 await，所以不需要加锁。
 */
export class HistoryStore {
  private items: HistoryRecord[] = []
  private loaded = false

  constructor(private emit: Emitter) {}

  private ensure(): void {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = JSON.parse(readFileSync(historyPath(), 'utf-8')) as unknown
      if (Array.isArray(raw)) {
        this.items = dedupe(
          raw.filter((x): x is HistoryRecord => !!x && typeof x === 'object' && 'sessionId' in x)
        )
      }
    } catch {
      this.items = []
    }
  }

  /** 最新在前；dirMissing 是读时算出来的派生值，不落盘 */
  list(): HistoryRecord[] {
    this.ensure()
    return this.items.map((item) => ({ ...item, dirMissing: !existsSync(item.workDir) }))
  }

  find(sessionId: string): HistoryRecord | undefined {
    this.ensure()
    return this.items.find((item) => item.sessionId === sessionId)
  }

  recordStart(
    info: TerminalInfo,
    extra: { permissionMode?: string; resumedFrom?: string } = {}
  ): void {
    this.ensure()
    // 只有跑 CLI 的会话进历史；纯 shell 会话不该走到这里
    if (info.cli === 'shell') return
    if (this.find(info.id)) return
    // 原生 resume 沿用同一个 session id：接着旧记录跑，只把终端换掉，不再插一条新的
    const prior = info.nativeSessionId
      ? this.items.find((item) => item.cli === info.cli && item.nativeSessionId === info.nativeSessionId)
      : undefined
    if (prior) {
      this.items = this.items.filter((item) => item !== prior)
      this.items.unshift({
        ...prior,
        sessionId: info.id,
        profileId: info.profileId,
        profileLabel: info.profileLabel,
        model: info.model,
        permissionMode: extra.permissionMode ?? prior.permissionMode,
        workDir: info.workDir,
        shell: info.shell,
        // 起点仍是最初那次，终点清空表示这条对话又在跑
        endedAt: undefined
      })
    } else {
      this.items.unshift({
        sessionId: info.id,
        nativeSessionId: info.nativeSessionId,
        cli: info.cli,
        profileId: info.profileId,
        profileLabel: info.profileLabel,
        model: info.model,
        permissionMode: extra.permissionMode,
        workDir: info.workDir,
        shell: info.shell,
        startedAt: Date.now(),
        resumedFrom: extra.resumedFrom,
        children: []
      })
    }
    if (this.items.length > KEEP) this.items.length = KEEP
    this.flush()
  }

  recordChild(parentTermId: string, child: HistoryChild): void {
    this.ensure()
    const record = this.find(parentTermId)
    if (!record || record.children.some((c) => c.termId === child.termId)) return
    record.children.push(child)
    this.flush()
  }

  /** codex 这类没法预分配 id 的 CLI，事后补上 */
  recordNativeId(termId: string, nativeSessionId: string): void {
    this.ensure()
    let touched = false
    for (const record of this.items) {
      if (record.sessionId === termId && !record.nativeSessionId) {
        record.nativeSessionId = nativeSessionId
        touched = true
        break
      }
      const child = record.children.find((c) => c.termId === termId)
      if (child && !child.nativeSessionId) {
        child.nativeSessionId = nativeSessionId
        touched = true
        break
      }
    }
    if (touched) this.flush()
  }

  /** 终端退出：主终端记结束时间，子终端记在它自己的那条上 */
  recordExit(info: TerminalInfo): void {
    this.ensure()
    const endedAt = Date.now()
    if (info.role === 'main') {
      const record = this.find(info.id)
      if (!record || record.endedAt) return
      record.endedAt = endedAt
    } else {
      const record = info.parentTermId ? this.find(info.parentTermId) : undefined
      const child = record?.children.find((c) => c.termId === info.id)
      if (!child || child.endedAt) return
      child.endedAt = endedAt
    }
    this.flush()
  }

  recordDone(termId: string, resultFile?: string): void {
    this.ensure()
    for (const record of this.items) {
      const child = record.children.find((c) => c.termId === termId)
      if (!child) continue
      child.done = true
      if (resultFile) child.resultFile = resultFile
      this.flush()
      return
    }
  }

  remove(sessionId: string): void {
    this.ensure()
    const before = this.items.length
    this.items = this.items.filter((item) => item.sessionId !== sessionId)
    if (this.items.length !== before) this.flush()
  }

  private flush(): void {
    const p = historyPath()
    try {
      mkdirSync(join(p, '..'), { recursive: true })
      const tmp = `${p}.tmp`
      writeFileSync(tmp, JSON.stringify(this.items, null, 2), 'utf-8')
      renameSync(tmp, p)
    } catch (err) {
      console.error('写入会话历史失败', err)
    }
    this.emit(CH.historyChanged, this.list())
  }
}
