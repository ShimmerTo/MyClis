import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { dirname, join } from 'path'
import { windowsHide } from '../util'
import type { CliStatus } from '../../shared/types'
import { adapters } from './registry'
import type { CliAdapter } from './types'

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

function version(bin: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const quoted = /\s/.test(bin) ? `"${bin}"` : bin
    execFile(
      'cmd.exe',
      ['/d', '/s', '/c', `${quoted} --version`],
      { windowsHide, timeout: 15000 },
      (err, stdout, stderr) => {
        if (err) return resolve(undefined)
        const line = `${stdout}${stderr}`
          .split(/\r?\n/)
          .map((s) => s.trim())
          .find((s) => s)
        resolve(line || undefined)
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
      const ver = await version(bin)
      const diagnostics = ver ? [] : [`${bin} 存在，但执行 --version 失败；启动环境可能不完整`]
      if (a.id === 'codebuddy') {
        const adjacentNode = join(dirname(bin), 'node.exe')
        const packageRoot = join(dirname(bin), 'node_modules', '@tencent-ai', 'codebuddy-code')
        const entrypoint = join(packageRoot, 'bin', 'codebuddy')
        const pathNode = await probe('node')
        diagnostics.push(`CodeBuddy 启动脚本：${bin}`)
        diagnostics.push(`CodeBuddy 包目录：${existsSync(packageRoot) ? packageRoot : '未找到'}`)
        diagnostics.push(`CodeBuddy 入口：${existsSync(entrypoint) ? entrypoint : '未找到'}`)
        diagnostics.push(`实际 Node：${existsSync(adjacentNode) ? adjacentNode : (pathNode ?? '未找到')}`)
      }
      return {
        id: a.id,
        label: a.label,
        installed: true,
        path: bin,
        version: ver,
        permissionOptions: a.permissionOptions,
        health: ver ? 'ok' : 'warning',
        diagnostics: diagnostics.length > 0 ? diagnostics : undefined,
        ...capabilities
      }
    })
  )
  return results
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
