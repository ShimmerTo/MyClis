import { createHash } from 'crypto'
import { join } from 'path'
import { DEFAULT_NOTES_DIR } from '../../shared/types'
import { getDataDirectory } from '../config/dataDirectory'

export function notesBaseDir(): string {
  return getDataDirectory()
}

export function notesPath(): string {
  return join(notesBaseDir(), 'notes.json')
}

export function notesAssetsDir(): string {
  return join(notesBaseDir(), 'notes-assets')
}

/** 拆分文件匹配：note- 前缀把旧版 notes.json 和各种 .bak/.tmp 都排除在外 */
export const NOTE_SPLIT_RE = /^note-.+\.json$/

/** 工作目录归一键：去尾部分隔符 + 忽略大小写，与渲染层 sameDir 口径一致 */
export const noteDirKey = (workDir: string): string => workDir.replace(/[\\/]+$/, '').toLowerCase()

/**
 * 拆分文件名主干：目录名（去掉 Windows 非法文件名字符）+ 归一键的 md5 前 8 位。
 * 只按目录名会串（C:\a\proj 与 D:\b\proj 同名），带 hash 才互不覆盖。
 */
export function noteFileStem(workDir: string): string {
  if (workDir === DEFAULT_NOTES_DIR) return 'note-default'
  const raw = noteDirKey(workDir).split(/[\\/]/).pop() || 'dir'
  const base = raw.replace(/[<>:"/\\|?*\u0000-\u001f.]/g, '-').slice(0, 40).replace(/-+$/, '') || 'dir'
  const hash = createHash('md5').update(noteDirKey(workDir), 'utf-8').digest('hex').slice(0, 8)
  return `note-${base}-${hash}`
}

/** 一个工作目录对应的两个文件：非已完成一个、已完成一个（相对存储根目录的文件名） */
export function noteSplitNames(stem: string): { open: string; done: string } {
  return { open: `${stem}.json`, done: `${stem}.done.json` }
}
