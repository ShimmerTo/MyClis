import { app } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync,
  readFileSync, readdirSync, readSync, realpathSync, renameSync, rmdirSync, rmSync, writeFileSync
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

type DirectoryState = { currentDir?: string; pendingDir?: string; legacyBackupDir?: string }
class DirectoryError extends Error {}
let activeDir: string | undefined

function defaultDirectory(): string {
  return join(app.getPath('userData'), 'clichilds')
}

function statePath(): string {
  return join(app.getPath('userData'), 'data-directory.json')
}

function absoluteDirectory(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || !isAbsolute(value.trim()) ||
      (process.platform === 'win32' && !/^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/i.test(value.trim()))) {
    throw new DirectoryError('数据目录必须是完整的绝对路径')
  }
  return resolve(value.trim())
}

function canonicalDirectory(value: string): string {
  const path = absoluteDirectory(value)
  let ancestor = path
  while (true) {
    if (existsSync(ancestor) && lstatSync(ancestor).isSymbolicLink()) {
      throw new DirectoryError('数据目录及其父目录不能是链接，请选择真实目录')
    }
    const parent = dirname(ancestor)
    if (parent === ancestor) break
    ancestor = parent
  }
  if (existsSync(path)) return realpathSync.native(path)
  const parent = dirname(path)
  if (parent === path) throw new DirectoryError('数据目录所在的磁盘或共享位置不可访问')
  return join(canonicalDirectory(parent), basename(path))
}

function sameDirectory(a: string, b: string): boolean {
  return relative(a, b) === '' || a.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() === b.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

function containsDirectory(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return !rel || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`))
}

function readState(): DirectoryState {
  if (!existsSync(statePath())) {
    if (existsSync(join(app.getPath('userData'), 'data-directory.required'))) {
      throw new DirectoryError('数据目录定位文件丢失，请恢复 data-directory.json 后重启；不会读取旧副本')
    }
    return {}
  }
  const state: unknown = JSON.parse(readFileSync(statePath(), 'utf8'))
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new DirectoryError('数据目录定位文件损坏，请恢复该文件后重启')
  for (const key of ['currentDir', 'pendingDir', 'legacyBackupDir'] as const) {
    const value = (state as DirectoryState)[key]
    if (value !== undefined) absoluteDirectory(value)
  }
  return state as DirectoryState
}

function writeState(state: DirectoryState): void {
  const path = statePath()
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify(state, null, 2), { flag: 'wx' })
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
}

function readRawConfig(dir: string): Record<string, unknown> {
  const path = join(dir, 'config.json')
  if (!existsSync(path)) return {}
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DirectoryError('配置文件损坏，未迁移数据')
  return value as Record<string, unknown>
}

function legacyNotesDirectory(dir: string): string {
  const notes = readRawConfig(dir).notes as { storageDir?: unknown } | undefined
  return notes?.storageDir ? canonicalDirectory(absoluteDirectory(notes.storageDir)) : dir
}

function validateTarget(source: string, value: unknown): string {
  const target = canonicalDirectory(absoluteDirectory(value))
  if (sameDirectory(source, target)) return source
  const notes = legacyNotesDirectory(source)
  for (const original of [source, notes]) {
    if (containsDirectory(original, target) || containsDirectory(target, original)) {
      throw new DirectoryError('新数据目录不能与原数据目录或便签目录互相包含')
    }
  }
  if (containsDirectory(target, canonicalDirectory(app.getPath('userData')))) {
    throw new DirectoryError('不能使用应用的启动配置目录或它的父目录')
  }
  if (existsSync(target) && (!lstatSync(target).isDirectory() || readdirSync(target).length)) {
    throw new DirectoryError('目标目录非空，请选择一个空目录；不会覆盖已有文件')
  }
  return target
}

function fileHash(path: string): string {
  const hash = createHash('sha256')
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(1024 * 1024)
    let length: number
    while ((length = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, length))
    return hash.digest('hex')
  } finally {
    closeSync(fd)
  }
}

function copyVerified(source: string, target: string): void {
  const stat = lstatSync(source)
  if (stat.isSymbolicLink()) throw new DirectoryError('数据目录中包含链接，请先处理链接后再迁移')
  if (stat.isDirectory()) {
    mkdirSync(target, { recursive: true })
    for (const name of readdirSync(source)) copyVerified(join(source, name), join(target, name))
  } else if (stat.isFile()) {
    copyFileSync(source, target)
    if (fileHash(source) !== fileHash(target)) throw new DirectoryError('文件校验失败，未切换数据目录')
  } else {
    throw new DirectoryError('数据目录中包含不支持迁移的文件类型')
  }
}

const isNoteFile = (name: string): boolean => name === 'notes.json' || /^note-.+\.json$/.test(name)
const isNoteEntry = (name: string): boolean => isNoteFile(name) || name === 'notes-assets'

function prepareCopy(source: string, stage: string, target: string): void {
  if (existsSync(source)) copyVerified(source, stage)
  const notes = legacyNotesDirectory(source)
  if (!sameDirectory(source, notes)) {
    if (!existsSync(notes) || !lstatSync(notes).isDirectory()) throw new DirectoryError('原便签目录不可访问，未迁移数据')
    // 独立便签目录是唯一数据源，默认目录中的旧副本不能重新出现。
    for (const name of readdirSync(stage).filter(isNoteEntry)) rmSync(join(stage, name), { recursive: true, force: true })
    for (const name of readdirSync(notes).filter(isNoteEntry)) copyVerified(join(notes, name), join(stage, name))
  }
  const oldAssets = join(notes, 'notes-assets')
  for (const name of readdirSync(stage).filter(isNoteFile)) {
    const path = join(stage, name)
    const entries: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!Array.isArray(entries)) throw new DirectoryError('便签文件损坏，未迁移数据')
    for (const entry of entries) {
      if (!entry || entry.kind !== 'file' || typeof entry.content !== 'string') continue
      const rel = relative(oldAssets, entry.content)
      if (rel && containsDirectory(oldAssets, entry.content)) entry.content = join(target, 'notes-assets', rel)
    }
    writeFileSync(path, JSON.stringify(entries, null, 2))
  }
  const config = readRawConfig(stage)
  if (config.notes && typeof config.notes === 'object') delete (config.notes as { storageDir?: unknown }).storageDir
  writeFileSync(join(stage, 'config.json'), JSON.stringify(config, null, 2))
}

function createStage(target: string): string {
  mkdirSync(dirname(target), { recursive: true })
  return mkdtempSync(join(dirname(target), '.myclis-migration-'))
}

export function getDataDirectory(): string {
  return activeDir ?? defaultDirectory()
}

export function prepareDataDirectoryMigration(value: unknown): boolean {
  const source = canonicalDirectory(getDataDirectory())
  const target = validateTarget(source, value)
  if (sameDirectory(source, target)) return false
  if (readState().pendingDir) throw new DirectoryError('已有数据目录迁移等待重启，请勿重复提交')
  mkdirSync(source, { recursive: true })
  writeState({ currentDir: source, pendingDir: target })
  return true
}

export function cancelDataDirectoryMigration(): void {
  const state = readState()
  if (state.pendingDir) writeState({ currentDir: state.currentDir })
}

export function dataDirectoryErrorMessage(error: unknown): string {
  console.error('数据目录操作失败', error)
  return error instanceof DirectoryError ? error.message : '数据目录操作失败，请检查目录权限、磁盘空间和文件完整性；原数据已保留'
}

export function initializeDataDirectory(): string | undefined {
  let state = readState()
  let source = canonicalDirectory(state.currentDir ?? defaultDirectory())
  if (state.legacyBackupDir) {
    if (!existsSync(source)) renameSync(state.legacyBackupDir, source)
    state = { currentDir: state.currentDir, pendingDir: state.pendingDir }
    writeState(state)
  }
  if (state.currentDir && (!existsSync(source) || !lstatSync(source).isDirectory())) {
    throw new DirectoryError('已设置的数据目录不可访问，请恢复该目录后重启；不会自动切回旧副本')
  }
  let warning: string | undefined
  if (state.pendingDir) {
    let stage: string | undefined
    try {
      const target = validateTarget(source, state.pendingDir)
      if (!sameDirectory(source, target)) {
        stage = createStage(target)
        prepareCopy(source, stage, target)
        validateTarget(source, target)
        if (existsSync(target)) rmdirSync(target)
        renameSync(stage, target)
        stage = undefined
        writeFileSync(join(app.getPath('userData'), 'data-directory.required'), '1')
        writeState({ currentDir: target })
        source = target
      } else {
        writeState({ currentDir: source })
      }
    } catch (error) {
      warning = `${dataDirectoryErrorMessage(error)}。仍使用原数据目录。`
      try {
        writeState({ currentDir: state.currentDir })
      } catch (rollbackError) {
        console.error('清除数据目录迁移计划失败', rollbackError)
        warning += '迁移计划未能清除，请修复目录权限或磁盘空间后重新启动。'
      }
    } finally {
      if (stage) rmSync(stage, { recursive: true, force: true })
    }
  }
  const notes = legacyNotesDirectory(source)
  if (!sameDirectory(source, notes)) {
    const stage = createStage(source)
    const backup = `${source}.before-notes-${randomUUID()}`
    try {
      prepareCopy(source, stage, source)
      writeState({ currentDir: source, legacyBackupDir: backup })
      renameSync(source, backup)
      try {
        renameSync(stage, source)
      } catch (error) {
        renameSync(backup, source)
        throw error
      }
      writeState({ currentDir: source })
    } finally {
      rmSync(stage, { recursive: true, force: true })
    }
  }
  activeDir = source
  return warning
}
