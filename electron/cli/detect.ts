import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { dirname, join } from 'path'
import { windowsHide } from '../util'
import type { CliStatus } from '../../shared/types'
import { adapters } from './registry'
import type { CliAdapter } from './types'
import { versionNumber, withLatestVersion } from './management'

/** 缓存：id -> 解析出的可执行路径（detectAll 后填充；launch 前确保已 detect） */
const resolved = new Map<string, string | null>()

function extRank(p: string): number {
  const e = p.toLowerCase()
  if (e.endsWith('.exe')) return 0
  if (e.endsWith('.cmd') || e.endsWith('.bat')) return 1
  return 2 // 无扩展名的 bash shim：powershell/cmd 下不可执行
}

function probe(cmd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('where.exe', [cmd], { windowsHide }, (err, stdout) => {
      if (err) return resolve(null)
      const hits = stdout
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => s && existsSync(s))
      if (hits.length === 0) return resolve(null)
      hits.sort((a, b) => extRank(a) - extRank(b))
      resolve(hits[0])
    })
  })
}

function version(bin: string): Promise<{ version?: string; error?: string }> {
  return new Promise((resolve) => {
    const quoted = /\s/.test(bin) ? `"${bin}"` : bin
    execFile(
      'cmd.exe',
      ['/d', '/s', '/c', `${quoted} --version`],
      { windowsHide, timeout: 15000 },
      (err, stdout, stderr) => {
        if (err) {
          const missingCodex = /Missing optional dependency (@openai\/codex-win32-(?:x64|arm64))\b/.exec(`${stdout}\n${stderr}`)
          console.error('CLI 版本检测失败', { bin, code: err.code, killed: err.killed, missingDependency: missingCodex?.[1] })
          let error = '--version 执行失败，请在系统终端运行该命令检查安装及启动环境'
          if (missingCodex) error = `Codex 的 Windows 运行文件缺失（${missingCodex[1]}），请重新安装 Codex 后再检测`
          else if (err.killed) error = '--version 执行超时，请检查 CLI 能否正常启动后重新检测'
          resolve({ error })
          return
        }
        const line = `${stdout}\n${stderr}`
          .split(/\r?\n/)
          .map((s) => s.trim())
          .find((s) => s)
        resolve({ version: line || undefined })
      }
    )
  })
}

/** 解析适配器对应二进制：PATH 候选 -> 已知绝对路径 */
async function resolveBin(a: CliAdapter): Promise<string | null> {
  for (const c of a.candidates) {
    const hit = await probe(c)
    if (hit) return hit
  }
  for (const p of a.knownExes()) {
    if (existsSync(p)) return p
  }
  return null
}

export async function detectAll(): Promise<CliStatus[]> {
  const results = await Promise.all(
    adapters.map(async (a): Promise<CliStatus> => {
      const bin = await resolveBin(a)
      resolved.set(a.id, bin)
      // 能力只看适配器声明：装没装都要如实告诉渲染层，未安装时按钮另有禁用逻辑
      const capabilities = { canTestModel: Boolean(a.testArgs) }
      if (!bin) {
        return { id: a.id, label: a.label, installed: false, permissionOptions: a.permissionOptions, ...capabilities }
      }
      const probeResult = await version(bin)
      const ver = probeResult.version
      const knownVersion = versionNumber(ver)
      const diagnostics: string[] = []
      if (probeResult.error) diagnostics.push(probeResult.error)
      else if (!ver) diagnostics.push('--version 未返回任何版本信息，请检查 CLI 安装后重新检测')
      else if (!knownVersion) diagnostics.push('--version 已返回，但版本号无法识别；请核查 CLI 安装及 PATH')
      if (a.id === 'codebuddy') {
        const adjacentNode = join(dirname(bin), 'node.exe')
        const packageRoot = join(dirname(bin), 'node_modules', '@tencent-ai', 'codebuddy-code')
        const entrypoint = join(packageRoot, 'bin', 'codebuddy')
        const pathNode = await probe('node')
        // 只留真正会被执行的两条：包入口 + 跑它的 node。脚本与包目录已在卡片上方显示为 path
        const node = existsSync(adjacentNode) ? adjacentNode : (pathNode ?? '未找到')
        diagnostics.push(`CodeBuddy 入口：${existsSync(entrypoint) ? entrypoint : '未找到'} · Node：${node}`)
      }
      return {
        id: a.id,
        label: a.label,
        installed: true,
        path: bin,
        version: ver,
        permissionOptions: a.permissionOptions,
        health: probeResult.error ? 'broken' : knownVersion ? 'ok' : 'warning',
        diagnostics: diagnostics.length > 0 ? diagnostics : undefined,
        ...capabilities
      }
    })
  )
  return Promise.all(results.map(withLatestVersion))
}

/** 取已解析的二进制路径；若未检测过则现场解析 */
export async function getCliBin(id: string): Promise<string | null> {
  if (resolved.has(id)) return resolved.get(id) ?? null
  const a = adapters.find((x) => x.id === id)
  if (!a) return null
  const bin = await resolveBin(a)
  resolved.set(id, bin)
  return bin
}
