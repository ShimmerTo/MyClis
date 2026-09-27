import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { createServer } from 'net'
import type { AddressInfo } from 'net'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { getCliBin } from './detect'

/* ---------------------------------------------------------------------------
 * 一、给 MyClis 起的 codebuddy 终端发端口（SERVER__PORT）
 * 一旦设了 SERVER__PORT，codebuddy 就不再读自己的池文件，所以这里必须保证端口是空的：
 * 撞端口的表现是「进程活着、终端没有任何输出」。端口每次现探测，不留固定区间。
 * ------------------------------------------------------------------------- */

/** 记住最近发出去的端口：系统刚释放的端口可能被立刻再分配一次，并发拉起时要避开 */
const recent: number[] = []

/** 只记最近这么多条，够覆盖一批子 CLI 同时拉起 */
const RECENT_MAX = 64

/** 撞上近期端口时最多重探测几次 */
const RETRY = 8

/** 让系统自己挑一个空闲端口：绑得上就说明此刻没人用，随即释放给 CLI */
function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      server.close(() => resolve(port))
    })
  })
}

/**
 * 取一个当前空闲的端口给新建的 codebuddy 终端。
 * 每次都真探测一次，不预取、不固定区间；只有撞上刚发出去的端口才重挑。
 */
export async function reserveFreePort(): Promise<number> {
  let port = 0
  for (let i = 0; i < RETRY; i += 1) {
    port = await pickFreePort()
    if (!recent.includes(port)) break
  }
  recent.push(port)
  if (recent.length > RECENT_MAX) recent.shift()
  return port
}

/* ---------------------------------------------------------------------------
 * 二、codebuddy 自己的端口池（~/.codebuddy/web-ui-port.json）
 * 手动在系统终端里开的 codebuddy 走这一条：CLI 启动时从池里找第一个空闲端口，
 * 池子默认只有 4 个，且池满后不再扩容 —— 第 5 个实例拿不到端口，会回落到默认
 * 端口 52331 去 listen，撞上后 unhandledRejection 静默挂死。
 * ------------------------------------------------------------------------- */

/** codebuddy 挑端口用的池文件 */
function poolFile(): string {
  return join(homedir(), '.codebuddy', 'web-ui-port.json')
}

/** 池里有几个端口，就能同时跑几个 codebuddy 实例 */
const TARGET_SIZE = 10

/** 池文件还不存在时的起始端口，与 codebuddy 自己的默认值一致 */
const DEFAULT_BASE = 52331

/** 池文件内容：ports 是候选端口，port 是上次选中的那个 */
type PortPool = { ports: number[]; port?: number; updatedAt?: number }

function isPort(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n > 0 && n <= 65535
}

function readPool(file: string): number[] {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as Partial<PortPool>
    const list = Array.isArray(raw.ports) ? raw.ports : raw.port !== undefined ? [raw.port] : []
    const out: number[] = []
    for (const p of list) {
      if (isPort(p) && !out.includes(p)) out.push(p)
    }
    return out
  } catch {
    // 文件不存在或内容损坏：按空池处理，下面从默认起始端口重排一份
    return []
  }
}

/**
 * 把 codebuddy 的 web-ui 端口池补足到 TARGET_SIZE 个。
 * 只加不减：已有的端口与顺序一律保留，池子已经够大时不动文件。
 * 候选端口本身是否被别的程序占着不用管，CLI 启动时会逐个探测。
 */
function expandPoolFile(): void {
  const file = poolFile()
  try {
    const ports = readPool(file)
    if (ports.length >= TARGET_SIZE) return
    // 从第一个端口开始数，空池时才会带上起始端口本身
    const base = ports[0] ?? DEFAULT_BASE
    for (let p = base; ports.length < TARGET_SIZE && p <= 65535; p += 1) {
      if (!ports.includes(p)) ports.push(p)
    }
    mkdirSync(dirname(file), { recursive: true })
    const next: PortPool = { ports, port: ports[0], updatedAt: Date.now() }
    writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf-8')
    console.info('已把 codebuddy 的 web-ui 端口池扩到', ports.length, '个：', ports.join(','))
  } catch (error) {
    // 扩不成也不该拖住启动：最坏情况是退回 codebuddy 自己的 4 个端口
    console.error('扩容 codebuddy 端口池失败', error)
  }
}

/**
 * 启动准备：装了 codebuddy 才做。
 * 扩池只服务手动在系统终端里开的 codebuddy；MyClis 起的终端走 SERVER__PORT，不读池文件。
 */
export async function expandCodebuddyPortPool(): Promise<void> {
  const bin = await getCliBin('codebuddy')
  if (!bin) return
  expandPoolFile()
}
