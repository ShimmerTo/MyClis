import { closeSync, openSync, readdirSync, readSync, statSync } from 'fs'
import { join } from 'path'
import type { ChatEntry } from '../../shared/types'
import type { CliAdapter } from '../cli/types'

export interface SessionFile {
  file: string
  mtime: number
  bytes: number
}

const ID_IN_NAME = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

/** 文件名里的原生 id（四家都把 uuid 原样写进文件名） */
export function sessionIdOfFile(adapter: CliAdapter, file: string): string | undefined {
  const base = file.slice(Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\')) + 1)
  const id = base.match(ID_IN_NAME)?.[0]
  return id && adapter.sessionFileMatch(id).test(base) ? id : undefined
}

/**
 * 在 sessionRoot 下递归收集 transcript。
 * 目录名对 cwd 的编码规则三家各不相同，所以只按深度和文件名筛，绝不从 cwd 反推目录名。
 */
export function walkSessionFiles(
  adapter: CliAdapter,
  minMtime = 0,
  maxFiles = 4000
): { files: SessionFile[]; missing: boolean } {
  const root = adapter.sessionRoot()
  const maxDepth = adapter.sessionScanDepth ?? 2
  const files: SessionFile[] = []
  const step = (dir: string, depth: number): void => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) return
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (depth < maxDepth) step(full, depth + 1)
        continue
      }
      if (!entry.name.endsWith('.jsonl')) continue
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.mtimeMs < minMtime) continue
      files.push({ file: full, mtime: st.mtimeMs, bytes: st.size })
    }
  }
  step(root, 0)
  return { files, missing: !safeIsDir(root) }
}

/** 头部行里第一条真实用户消息 = 这条会话的问题描述；启动握手和工具结果不算 */
export function initialQueryOf(adapter: CliAdapter, lines: string[]): string | undefined {
  const entries: ChatEntry[] = []
  for (const raw of lines) {
    try {
      adapter.parseTranscript?.(JSON.parse(raw) as Record<string, unknown>, entries)
    } catch {
      // 半行/坏行跳过
    }
  }
  return entries.find((entry) => entry.kind === 'user' && entry.text.trim())?.text.trim().slice(0, 2000)
}

/**
 * 文件尾部最后一条用户消息。层1 投递确认要看尾而不是头：
 * resume 出来的会话头部是历史消息，只有尾部才是这次刚提交的那条。
 */
export function lastUserMessageOf(adapter: CliAdapter, file: string): string | undefined {
  const size = sizeOf(file)
  if (size <= 0) return undefined
  const budget = Math.min(Math.max(size, 64 * 1024), 1024 * 1024)
  const chunk = readChunk(file, Math.max(0, size - budget), budget)
  const entries: ChatEntry[] = []
  for (const raw of chunk.lines) {
    try {
      adapter.parseTranscript?.(JSON.parse(raw) as Record<string, unknown>, entries)
    } catch {
      // 半行/坏行跳过
    }
  }
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]
    if (entry.kind === 'user' && entry.text.trim()) return entry.text.trim().slice(0, 4000)
  }
  return undefined
}

export function safeIsDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** 按原生 id 定位 transcript（同一 id 只会有一份，取最新的） */
export function locateSessionFile(
  adapter: CliAdapter,
  sessionId: string,
  minMtime = 0
): SessionFile | undefined {
  return walkSessionFiles(adapter, minMtime).files
    .filter((f) => sessionIdOfFile(adapter, f.file) === sessionId)
    .sort((a, b) => b.mtime - a.mtime)[0]
}

/**
 * 只读文件头部，用于回填列表时拿 cwd/开始时间；绝不整文件读进内存。
 * codex 把 session_meta 连同基础指令塞在第一行，实测单行 40KB+，所以要按需放大。
 */
export function readHeadLines(file: string): string[] {
  let budget = 64 * 1024
  const CAP = 1024 * 1024
  for (;;) {
    const chunk = readChunk(file, 0, budget)
    if (chunk.lines.length > 0 || chunk.bytes < budget || budget >= CAP) return chunk.lines
    budget *= 4
  }
}

export interface Chunk {
  lines: string[]
  /** 从中间开始读时，第一段可能不是完整行 */
  droppedHead: boolean
  bytes: number
}

/** 从 offset 起读 maxBytes 字节；用于「只读尾部」这种大文件场景 */
export function readChunk(file: string, offset: number, maxBytes: number): Chunk {
  let fd = -1
  try {
    fd = openSync(file, 'r')
    const buffer = Buffer.alloc(maxBytes)
    const read = readSync(fd, buffer, 0, maxBytes, offset)
    const text = buffer.subarray(0, read).toString('utf-8')
    const parts = text.split('\n')
    const eof = offset + read >= sizeOf(file)
    const tail = eof ? parts.length : parts.length - 1
    const lines = parts.slice(offset > 0 ? 1 : 0, tail).filter(Boolean)
    return { lines, droppedHead: offset > 0, bytes: read }
  } catch {
    return { lines: [], droppedHead: false, bytes: 0 }
  } finally {
    if (fd >= 0) closeSync(fd)
  }
}

/** 文件大小；层1 确认轮询靠它判断 transcript 有没有长大，避免每次都重新解析 */
export function sizeOf(file: string): number {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}
