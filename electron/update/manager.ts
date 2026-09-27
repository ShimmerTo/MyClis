import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { get } from 'node:https'
import { dirname, join } from 'node:path'
import type { UpdateConfig, UpdateInfo, UpdatePhase, UpdateState } from '../../shared/types'
import { CHECK_TIMEOUT_MS, USER_AGENT, compareVersion, fetchLatestRelease, parseLatestRelease } from './checker'

/** 后台检测的间隔：手动点「检查更新」不受它限制 */
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
/** 安装包几十 MB，给足时间但不能无限等 */
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000
/** GitHub 的下载地址会跳一次到对象存储，留够余量即可 */
const MAX_REDIRECTS = 5
/** 同一个安装包最多拉起这么多次；装不出来就放弃，别每次启动都弹一次安装器 */
export const MAX_INSTALL_ATTEMPTS = 2
const READY_FILE = 'update-ready.json'
const CACHE_FILE = 'update-cache.json'
const UPDATES_DIR = 'updates'

interface ReadyRecord {
  version: string
  tag: string
  file: string
  size: number
  digest?: string
  /** 有没有做 sha256 校验；没有摘要文件时只校验文件大小 */
  verified: boolean
  attempts: number
  downloadedAt: number
}

/** 流式写盘并回报进度；临时文件由调用方负责改名 */
function downloadFile(url: string, target: string, onProgress: (ratio: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    mkdirSync(dirname(target), { recursive: true })
    let redirects = 0
    let settled = false
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      reject(error)
    }
    const next = (current: string): void => {
      let parsed: URL
      try {
        parsed = new URL(current)
      } catch {
        fail(new Error('下载地址无效'))
        return
      }
      if (parsed.protocol !== 'https:') {
        fail(new Error('下载地址必须是 https'))
        return
      }
      const req = get(parsed, { timeout: DOWNLOAD_TIMEOUT_MS, headers: { 'user-agent': USER_AGENT } }, (res) => {
        const status = res.statusCode ?? 0
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume()
          if ((redirects += 1) > MAX_REDIRECTS) {
            fail(new Error('下载地址重定向次数过多'))
            return
          }
          next(new URL(res.headers.location, current).toString())
          return
        }
        if (status !== 200) {
          res.resume()
          fail(new Error(`下载失败：HTTP ${status}`))
          return
        }
        const total = Number(res.headers['content-length'] ?? 0)
        let received = 0
        const file = createWriteStream(target)
        res.on('data', (chunk: Buffer) => {
          received += chunk.length
          if (total > 0) onProgress(Math.min(1, received / total))
        })
        res.on('error', fail)
        res.on('aborted', () => fail(new Error('下载被中断')))
        file.on('error', fail)
        file.on('close', () => {
          if (total > 0 && received !== total) {
            fail(new Error('下载不完整，请重试'))
            return
          }
          if (settled) return
          settled = true
          resolve()
        })
        res.pipe(file)
      })
      req.on('timeout', () => req.destroy(new Error('下载超时')))
      req.on('error', fail)
    }
    next(url)
  })
}

/** 小于 1KB 的摘要文件内容；失败返回 null（没有摘要文件不算错误） */
function fetchDigest(url: string): Promise<string | null> {
  return new Promise((resolve) => {
    const done = (value: string | null): void => resolve(value)
    try {
      new URL(url)
    } catch {
      done(null)
      return
    }
    const req = get(url, { timeout: CHECK_TIMEOUT_MS, headers: { 'user-agent': USER_AGENT } }, (res) => {
      const chunks: Buffer[] = []
      let length = 0
      res.on('data', (chunk: Buffer) => {
        if (length + chunk.length > 4096) {
          res.destroy()
          done(null)
          return
        }
        length += chunk.length
        chunks.push(chunk)
      })
      res.on('end', () => {
        if (res.statusCode !== 200) return done(null)
        const text = Buffer.concat(chunks).toString('utf8')
        done(/^[0-9a-f]{64}/i.exec(text.trim())?.[0]?.toLowerCase() ?? null)
      })
      res.on('error', () => done(null))
    })
    req.on('timeout', () => req.destroy())
    req.on('error', () => done(null))
    req.end()
  })
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

export interface UpdateManagerOptions {
  /** 数据目录（安装包与记录都落在它下面的 updates/ 里） */
  root: () => string
  /** 当前运行版本的 app.getVersion() */
  currentVersion: string
  /** 未打包（开发版）不检测也不安装 */
  packaged: boolean
  emit: (state: UpdateState) => void
  config: () => UpdateConfig
  quit: () => void
}

/**
 * 更新的检测 / 下载 / 下次启动安装。
 * 状态一律以磁盘上的记录为准：重启后不需要重新联网也能知道有没有待装的版本，
 * 也不会因为内存缓存过期而误判成「有新版」。
 */
export class UpdateManager {
  private phase: UpdatePhase = 'idle'
  private latest?: UpdateInfo
  private downloadedVersion?: string
  private progress = 0
  private error?: string
  private checkedAt = 0
  private task?: Promise<void>
  private stopped = false

  constructor(private opts: UpdateManagerOptions) {
    const ready = this.readReady()
    if (ready && compareVersion(ready.version, opts.currentVersion) > 0) {
      this.downloadedVersion = ready.version
      this.phase = 'ready'
    }
  }

  private dir(): string {
    return join(this.opts.root(), UPDATES_DIR)
  }

  private state(): UpdateState {
    return {
      currentVersion: this.opts.currentVersion,
      packaged: this.opts.packaged,
      phase: this.phase,
      latest: this.latest,
      downloadedVersion: this.downloadedVersion,
      progress: this.progress,
      error: this.error,
      config: this.opts.config()
    }
  }

  private emit(): void {
    if (!this.stopped) this.opts.emit(this.state())
  }

  private setState(patch: Partial<Pick<UpdateState, 'phase' | 'latest' | 'downloadedVersion' | 'progress' | 'error'>>): void {
    if (patch.phase !== undefined) this.phase = patch.phase
    if (patch.latest !== undefined) this.latest = patch.latest
    if (patch.downloadedVersion !== undefined) this.downloadedVersion = patch.downloadedVersion
    if (patch.progress !== undefined) this.progress = patch.progress
    if (patch.error !== undefined) this.error = patch.error
    this.emit()
  }

  stateSnapshot(): UpdateState {
    return this.state()
  }

  /** 启动时的后台检测：出错一律静默，不影响正常使用 */
  async checkOnStartup(): Promise<void> {
    if (!this.opts.packaged) return
    try {
      await this.check(false)
    } catch (error) {
      console.error('启动时检查更新失败', error)
    }
  }

  /** force = 手动点击：跳过间隔限制，失败要抛错给调用方提示 */
  async check(force: boolean): Promise<UpdateState> {
    if (!this.opts.packaged) throw new Error('开发版不检查更新')
    if (!force && this.latest && Date.now() - this.checkedAt < CHECK_INTERVAL_MS) return this.state()
    const cached = force ? undefined : this.readCache()
    if (!force && cached) {
      this.latest = cached.info
      this.checkedAt = cached.at
      this.applyLatest()
      return this.state()
    }
    let info: UpdateInfo | null = null
    try {
      info = parseLatestRelease(await fetchLatestRelease(CHECK_TIMEOUT_MS), this.opts.currentVersion)
    } catch (error) {
      this.setState({ phase: 'failed', error: error instanceof Error ? error.message : '检查更新失败' })
      throw error
    }
    this.latest = info ?? undefined
    this.checkedAt = Date.now()
    this.writeCache()
    this.applyLatest()
    return this.state()
  }

  private applyLatest(): void {
    const ready = this.readReady()
    if (ready && compareVersion(ready.version, this.opts.currentVersion) > 0) {
      this.setState({ phase: 'ready', downloadedVersion: ready.version, progress: 1, error: undefined })
      return
    }
    if (this.latest) {
      this.setState({ phase: this.latest.version === this.downloadedVersion ? 'ready' : 'available', error: undefined })
      if (this.opts.config().autoDownload) void this.download().catch(() => undefined)
      return
    }
    this.setState({ phase: 'idle', downloadedVersion: undefined, error: undefined })
  }

  async download(): Promise<UpdateState> {
    const info = this.latest
    if (!info) throw new Error('还没有检测到新版本')
    if (this.phase === 'ready' && this.downloadedVersion === info.version) return this.state()
    if (!this.task) {
      this.setState({ phase: 'downloading', progress: 0, error: undefined })
      // 任务自己先吃掉一次异常：状态已经推给界面了，没人 await 时也不至于变成未处理的 rejection
      this.task = this.runDownload(info).catch((error: unknown) => {
        this.setState({ phase: 'failed', progress: 0, error: error instanceof Error ? error.message : '下载更新失败' })
        throw error
      }).finally(() => {
        this.task = undefined
      })
    }
    try {
      await this.task
    } catch (error) {
      throw error instanceof Error ? error : new Error('下载更新失败')
    }
    return this.state()
  }

  private async runDownload(info: UpdateInfo): Promise<void> {
    const target = join(this.dir(), `myclis-setup-${info.version}.exe`)
    const part = `${target}.part`
    try {
      rmSync(part, { force: true })
      if (!existsSync(target) || statSync(target).size !== info.asset.size) {
        mkdirSync(this.dir(), { recursive: true })
        await downloadFile(info.asset.url, part, (ratio) => this.setState({ phase: 'downloading', progress: ratio }))
        renameSync(part, target)
      }
      const size = statSync(target).size
      if (info.asset.size > 0 && size !== info.asset.size) throw new Error('下载不完整，请重试')
      const digest = info.asset.digestUrl ? await fetchDigest(info.asset.digestUrl) : null
      if (digest) {
        // 有摘要就按摘要来：装一半的安装包会把用户卡在灰屏上，宁可重下
        if ((await sha256File(target)) !== digest) {
          rmSync(target, { force: true })
          throw new Error('安装包校验失败，已删除下载的文件')
        }
      }
      this.writeReady({
        version: info.version,
        tag: info.tag,
        file: target,
        size,
        digest: digest ?? undefined,
        verified: !!digest,
        attempts: 0,
        downloadedAt: Date.now()
      })
      this.setState({ phase: 'ready', downloadedVersion: info.version, progress: 1, error: undefined })
    } catch (error) {
      rmSync(part, { force: true })
      throw error instanceof Error ? error : new Error('下载更新失败')
    }
  }

  /**
   * 启动时处理已经下载好的安装包。
   * 返回 true 表示已经拉起安装程序并要求退出应用，调用方不要再往下建窗口。
   */
  installPending(): boolean {
    const ready = this.readReady()
    if (!ready || !this.opts.packaged) return false
    // 装完之后 version 会等于（甚至低于）当前版本，这时候这条记录就该没了
    if (compareVersion(ready.version, this.opts.currentVersion) <= 0) {
      this.clearReady()
      return false
    }
    let size = 0
    try {
      size = statSync(ready.file).size
    } catch {
      this.clearReady()
      return false
    }
    if (!existsSync(ready.file) || (ready.size > 0 && size !== ready.size) || ready.attempts >= MAX_INSTALL_ATTEMPTS) {
      this.clearReady()
      return false
    }
    this.writeReady({ ...ready, attempts: ready.attempts + 1 })
    this.launchInstaller(ready.file)
    this.opts.quit()
    return true
  }

  /** 手动点「立即安装」：已经有下载好的安装包才会走到这里 */
  install(): void {
    const ready = this.readReady()
    if (!ready || compareVersion(ready.version, this.opts.currentVersion) <= 0) {
      throw new Error('没有待安装的新版本')
    }
    if (!existsSync(ready.file)) throw new Error('安装包已被删除，请重新下载')
    this.launchInstaller(ready.file)
  }

  private launchInstaller(file: string): void {
    try {
      const child = spawn(file, ['/S'], { detached: true, stdio: 'ignore' })
      child.on('error', (error: unknown) => console.error('拉起安装包失败', error))
      child.unref()
    } catch (error) {
      console.error('拉起安装包失败', error)
    }
  }

  /** 退出前人走的路：正在下载的任务不再推状态 */
  dispose(): void {
    this.stopped = true
  }

  private readReady(): ReadyRecord | undefined {
    const file = join(this.dir(), READY_FILE)
    if (!existsSync(file)) return undefined
    try {
      const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
      const record = value as ReadyRecord
      if (!record || typeof record.version !== 'string' || typeof record.file !== 'string') return undefined
      if (!record.version.trim()) return undefined
      return record
    } catch {
      return undefined
    }
  }

  private writeReady(record: ReadyRecord): void {
    try {
      mkdirSync(this.dir(), { recursive: true })
      writeFileSync(join(this.dir(), READY_FILE), JSON.stringify(record, null, 2), 'utf8')
    } catch (error) {
      console.error('写待安装包记录失败', error)
    }
  }

  private clearReady(): void {
    const ready = this.readReady()
    rmSync(join(this.dir(), READY_FILE), { force: true })
    if (ready) rmSync(ready.file, { force: true })
    if (this.downloadedVersion === ready?.version) this.setState({ phase: 'idle', downloadedVersion: undefined })
  }

  /** 最近一次检测结果落盘：限流时不开网络也能知道有没有新版 */
  private writeCache(): void {
    if (!this.latest) return
    try {
      mkdirSync(this.dir(), { recursive: true })
      writeFileSync(join(this.dir(), CACHE_FILE), JSON.stringify({ at: this.checkedAt, info: this.latest }, null, 2), 'utf8')
    } catch (error) {
      console.error('写更新缓存失败', error)
    }
  }

  private readCache(): { at: number; info: UpdateInfo } | undefined {
    const file = join(this.dir(), CACHE_FILE)
    if (!existsSync(file)) return undefined
    try {
      const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
      const record = value as { at?: unknown; info?: UpdateInfo }
      const at = typeof record.at === 'number' ? record.at : 0
      if (Date.now() - at > 7 * 24 * 60 * 60 * 1000) return undefined
      // 缓存里的版本已经不比当前版本新（重装/降级过），不能当作还有更新
      if (!record.info?.version || compareVersion(record.info.version, this.opts.currentVersion) <= 0) return undefined
      return { at, info: record.info }
    } catch {
      return undefined
    }
  }
}
