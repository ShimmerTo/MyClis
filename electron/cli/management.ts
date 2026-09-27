import { execFile } from 'child_process'
import { homedir } from 'os'
import { isAbsolute } from 'path'
import type { CliId, CliStatus } from '../../shared/types'

const packages: Record<CliId, string> = {
  codex: '@openai/codex', qoder: '@qoder-ai/qodercli',
  codebuddy: '@tencent-ai/codebuddy-code', pi: '@mariozechner/pi-coding-agent'
}
const cache = new Map<CliId, { until: number; promise: Promise<string> }>()
const busy = new Set<CliId>()

/** 提取 CLI 版本输出中的版本号；未知输出不冒充可比较的版本。 */
export function versionNumber(value?: string): string | undefined {
  return value?.match(/\b\d+\.\d+\.\d+(?:-[\w.-]+)?\b/)?.[0]
}

/** 仅在两侧均有版本号时比较，未知版本由调用方明确提示。 */
export function newerVersion(latest?: string, installed?: string): boolean {
  const next = versionNumber(latest)
  const current = versionNumber(installed)
  if (!next || !current) return false
  const a = next.split(/[.-]/).slice(0, 3).map(Number)
  const b = current.split(/[.-]/).slice(0, 3).map(Number)
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]
  return current.includes('-') && !next.includes('-')
}

const UNKNOWN_VERSION = '当前 CLI 版本无法识别，未执行升级；请检查 --version 输出及 PATH 后重新检测'
const UNSUPPORTED_QODER = '当前原生 Qoder CLI 的帮助未确认支持 update，未执行升级；请按官方说明手动处理'

function nativeQoderPath(status: CliStatus): string | undefined {
  return status.id === 'qoder' && status.path && isAbsolute(status.path) && /\.exe$/i.test(status.path)
    ? status.path : undefined
}

/** 本机 Qoder 1.1.60 的 --help 明确列出 update；每次操作仍核对实际二进制的帮助。 */
function supportsQoderUpdate(file: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(file, ['--help'], { cwd: homedir(), windowsHide: true, timeout: 15000, maxBuffer: 512 * 1024 }, (error, stdout) => {
      if (error) {
        console.error('读取 Qoder 升级能力失败', { code: error.code, killed: error.killed })
        resolve(false)
        return
      }
      const commands = stdout.split(/^Commands:\s*$/m)[1] ?? ''
      resolve(/^\s+update(?:\s+\[options\])?\s+Update to the latest version\s*$/mi.test(commands))
    })
  })
}

function latestVersion(cli: CliId): Promise<string> {
  const hit = cache.get(cli)
  if (hit && hit.until > Date.now()) return hit.promise
  const promise = (async () => {
    const response = await fetch(`https://registry.npmjs.org/${packages[cli]}/latest`, { signal: AbortSignal.timeout(8000) })
    if (!response.ok) throw new Error(`Version registry HTTP ${response.status}`)
    const text = await response.text()
    if (text.length > 1024 * 1024) throw new Error('Version metadata too large')
    const data = JSON.parse(text) as { name?: string; version?: string }
    if (data.name !== packages[cli] || !data.version || !/^\d+\.\d+\.\d+$/.test(data.version)) throw new Error('Invalid version metadata')
    return data.version
  })()
  cache.set(cli, { until: Date.now() + 5 * 60_000, promise })
  void promise.catch(() => {
    if (cache.get(cli)?.promise === promise) cache.delete(cli)
  })
  return promise
}

/** 只查询版本和能力，不在检测阶段安装或升级。 */
export async function withLatestVersion(status: CliStatus): Promise<CliStatus> {
  const unknown = status.installed && !versionNumber(status.version)
  const versionError = status.health === 'broken'
    ? 'CLI 无法启动，未执行升级；请按下方提示修复安装后重新检测'
    : UNKNOWN_VERSION
  try {
    const latest = await latestVersion(status.id)
    let updateAvailable = status.installed && newerVersion(latest, status.version)
    let updateError = unknown ? versionError : undefined
    const native = nativeQoderPath(status)
    if (updateAvailable && native && !await supportsQoderUpdate(native)) {
      updateAvailable = false
      updateError = UNSUPPORTED_QODER
    }
    return { ...status, latestVersion: latest, updateAvailable, updateError }
  } catch (error) {
    console.error(`查询 ${status.id} 最新版本失败`, error)
    return { ...status, updateAvailable: false, updateError: unknown ? versionError : '无法查询最新版本，请稍后重新检测' }
  }
}

/** 仅响应显式点击；包名和命令由后端白名单构造，不接受渲染层命令或路径。 */
export async function manageCli(
  request: { cli: CliId; action: 'install' | 'upgrade' },
  detect: () => Promise<CliStatus[]>
): Promise<CliStatus> {
  if (!request || !Object.hasOwn(packages, request.cli) || !['install', 'upgrade'].includes(request.action)) throw new Error('不支持的 CLI 安装操作')
  const { cli, action } = request
  if (busy.has(cli)) throw new Error('该 CLI 正在安装或升级')
  busy.add(cli)
  try {
    const before = (await detect()).find((item) => item.id === cli)
    if (!before) throw new Error('未获得 CLI 检测结果，请重新检测')
    if (action === 'install' && before.installed) throw new Error('该 CLI 已安装，请重新检测后选择升级')
    if (action === 'upgrade' && !before.installed) throw new Error('该 CLI 尚未安装')
    if (before.health === 'broken') throw new Error('CLI 无法启动，未执行升级；请先修复安装后重新检测')
    const current = versionNumber(before.version)
    if (before.installed && !current) throw new Error(UNKNOWN_VERSION)
    let target: string
    try {
      target = await latestVersion(cli)
    } catch (error) {
      console.error(`查询 ${cli} 安装目标版本失败`, error)
      throw new Error('无法确认目标版本，未执行安装或升级；请稍后重新检测')
    }
    if (before.installed && !newerVersion(target, current)) return before
    const native = nativeQoderPath(before)
    if (native && !await supportsQoderUpdate(native)) throw new Error(UNSUPPORTED_QODER)
    const file = native ?? 'cmd.exe'
    const args = native ? ['update'] : ['/d', '/s', '/c', `npm.cmd install --global ${packages[cli]}@${target}`]
    await new Promise<void>((resolve, reject) => {
      execFile(file, args, { cwd: homedir(), windowsHide: true, timeout: 300_000, maxBuffer: 2 * 1024 * 1024 }, (error) => {
        if (error) {
          console.error(`${cli} 安装升级失败`, { code: error.code, killed: error.killed })
          reject(new Error('安装或升级失败，请检查 Node.js/npm、网络和安装目录权限；现有终端未被关闭'))
        } else resolve()
      })
    })
    cache.delete(cli)
    const after = (await detect()).find((item) => item.id === cli)
    const installed = versionNumber(after?.version)
    if (!after?.installed || !installed) {
      throw new Error('安装命令已结束，但无法识别安装后的 CLI 版本；请检查 --version 输出及 PATH，不要重复安装')
    }
    if ((before.installed && !newerVersion(installed, current)) || (!native && newerVersion(target, installed))) {
      throw new Error('安装命令已结束，但未检测到目标新版本；请检查 PATH 是否仍指向旧安装')
    }
    return after
  } finally {
    busy.delete(cli)
  }
}
