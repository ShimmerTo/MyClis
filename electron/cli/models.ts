/**
 * 「用某个模型实跑一次」的测试：靠 CLI 自己的非交互命令，命令形态由各适配器的 testArgs 决定。
 * 模型候选不由这里提供——可用模型清单是设置页手工维护的配置（AppConfig.cliModels）。
 */
import { spawn } from 'child_process'
import { tmpdir } from 'os'
import type { CliId, CliTestResult } from '../../shared/types'
import { toShellLine, windowsHide } from '../util'
import { getCliBin } from './detect'
import { getAdapter } from './registry'

const TEST_MAX_BUFFER = 8 * 1024 * 1024
/** 真实调用模型：慢的 provider 可能一两分钟 */
const TEST_TIMEOUT_MS = 180_000
/** 回显与错误摘要的展示上限 */
const TEXT_LIMIT = 200
/**
 * 有的 CLI 失败时退出码仍是 0，错误正文混在正常输出里（实测 codebuddy 对不存在的模型
 * 回的是 `400 model [x] service info not found`）。回显以 HTTP 状态码开头的一律当失败：
 * 宁可把「通过」判成「失败」，也不能把不可用的模型报成可用。
 */
const ERROR_REPLY = /^[45]\d\d\b/

interface RunResult {
  ok: boolean
  timedOut: boolean
  stdout: string
  stderr: string
}

/** 超时后连子孙进程一起收掉：只杀 shell 会留下一个还在跑的 CLI */
function killTree(pid: number | undefined): void {
  if (pid === undefined) return
  try {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide }).on('error', () => undefined)
  } catch {
    // 进程已经退出或 taskkill 不可用时忽略
  }
}

/**
 * 按 cmd 的引号规则拼成一行交给 shell 跑。
 * stdin 必须给 NUL：管道形式的 stdin 会让 codex / pi 以为还要读追加输入而一直等下去。
 */
function run(line: string, timeout: number, maxBuffer: number): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(line, {
      shell: true,
      windowsHide,
      cwd: tmpdir(),
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let overflow = false
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child.pid)
    }, timeout)
    const collect = (chunk: Buffer, into: 'out' | 'err'): void => {
      // 超出上限就不再累积，只留一句截断说明
      if (stdout.length + stderr.length + chunk.length > maxBuffer) {
        overflow = true
        return
      }
      if (into === 'out') stdout += chunk.toString('utf8')
      else stderr += chunk.toString('utf8')
    }
    child.stdout?.on('data', (chunk: Buffer) => collect(chunk, 'out'))
    child.stderr?.on('data', (chunk: Buffer) => collect(chunk, 'err'))
    child.on('error', (e: Error) => {
      clearTimeout(timer)
      resolve({ ok: false, timedOut, stdout, stderr: `${stderr}${e.message}` })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (overflow) stderr = `${stderr}\n输出超过 ${Math.round(maxBuffer / 1024 / 1024)}MB，已截断`
      resolve({ ok: code === 0 && !timedOut, timedOut, stdout, stderr })
    })
  })
}

function clip(text: string, limit = TEXT_LIMIT): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}

/** 取最后一行非空输出：各 CLI 的收尾提示（token 统计、hook 日志）都在答案之前 */
function tailLine(text: string): string {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  return lines.length > 0 ? lines[lines.length - 1] : ''
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? ''
}

/**
 * 用指定模型跑一次非交互最小测试。跑在系统临时目录里、不带任何权限参数，
 * 只判断「这个模型能不能正常回一句话」，不碰用户的工作目录。
 */
export async function testCliModel(req: { cli: CliId; model: string }): Promise<CliTestResult> {
  const adapter = getAdapter(req.cli)
  if (!adapter) return { ok: false, elapsedMs: 0, error: `未知 CLI：${req.cli}` }
  if (!adapter.testArgs) return { ok: false, elapsedMs: 0, error: `${adapter.label} 不支持非交互测试` }
  const bin = await getCliBin(req.cli)
  if (!bin) return { ok: false, elapsedMs: 0, error: `未检测到 ${adapter.label}` }

  const model = req.model.trim()
  const line = toShellLine(adapter.testArgs(bin, model), 'cmd')
  const started = Date.now()
  const res = await run(line, TEST_TIMEOUT_MS, TEST_MAX_BUFFER)
  const elapsedMs = Date.now() - started

  if (res.timedOut) {
    return { ok: false, elapsedMs, error: `超过 ${Math.round(TEST_TIMEOUT_MS / 1000)} 秒没有返回` }
  }
  if (!res.ok) {
    const reason = firstLine(res.stderr) || firstLine(res.stdout) || '命令退出码非 0'
    return { ok: false, elapsedMs, error: clip(reason) }
  }
  const reply = tailLine(res.stdout)
  if (!reply) {
    // 失败原因可能在 stderr（实测 codebuddy 对不存在的模型：退出码 0 + stderr 里一句 400）
    const reason = firstLine(res.stderr)
    return { ok: false, elapsedMs, error: clip(reason || '命令成功但没有输出，模型可能没有生效') }
  }
  if (ERROR_REPLY.test(reply)) return { ok: false, elapsedMs, error: clip(reply) }
  return { ok: true, elapsedMs, reply: clip(reply) }
}
