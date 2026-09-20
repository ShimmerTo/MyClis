import { createServer } from 'http'
import type { IncomingMessage, Server, ServerResponse } from 'http'
import type {
  PresentRequest,
  RetryResponse,
  RunSnapshot,
  TriggerKind,
  TriggerRequest,
  TriggerResponse,
  TriggerTarget
} from '../../shared/types'

export type TriggerHandler = (kind: TriggerKind, request: TriggerRequest) => Promise<TriggerResponse>
export type PresentHandler = (request: PresentRequest) => Promise<{ bundleId: string; count: number }>
/** runId 无效（不存在或应用已重启）时回 null，由路由翻成 404 */
export type RunStatusHandler = (runId: string) => RunSnapshot | null
export type RunWaitHandler = (runId: string, timeoutMs: number, signal: AbortSignal) => Promise<RunSnapshot | null>
export type RunRetryHandler = (runId: string) => Promise<RetryResponse | null>

export interface BridgeHandlers {
  onTrigger: TriggerHandler
  onPresent?: PresentHandler
  onRunStatus: RunStatusHandler
  onRunWait: RunWaitHandler
  onRunRetry: RunRetryHandler
}

/** 子任务监督路由：全部是 GET + 路径参数，主 CLI 的 curl 不需要引号与 query 拼接 */
const RUN_ROUTE = /^\/(status|wait|retry)\/([A-Za-z0-9_-]{1,64})$/
/** 输出发布：会话 id 直接放路径里（注入文案是逐字抄的 URL，比 JSON 字段可靠）；不带 id 时回退 */
const PRESENT_ROUTE = /^\/present(?:\/([A-Za-z0-9_-]{1,64}))?$/
const MAX_TARGETS = 16
const BODY_LIMIT = 256 * 1024

/**
 * 主 CLI 提交的 targets 属于外部输入，逐条清洗后再交给执行器。
 * 缺字段一律报错而不是丢弃：允许子集下发之后，静默丢弃等于静默不拉起。
 */
function normalizeTargets(raw: unknown): TriggerTarget[] | undefined {
  if (!Array.isArray(raw)) return undefined
  if (raw.length > MAX_TARGETS) throw new Error(`targets 最多 ${MAX_TARGETS} 条`)
  return raw.map((item, i) => {
    if (!item || typeof item !== 'object') throw new Error(`targets 第 ${i + 1} 条不是对象`)
    const record = item as Partial<TriggerTarget>
    const profileId = typeof record.profileId === 'string' ? record.profileId.trim() : ''
    const task = typeof record.task === 'string' ? record.task.trim() : ''
    if (!profileId) throw new Error(`targets 第 ${i + 1} 条缺少 profileId`)
    if (!task) throw new Error(`targets 第 ${i + 1} 条缺少 task 任务指令`)
    const documents = Array.isArray(record.documents)
      ? record.documents.filter((p): p is string => typeof p === 'string' && !!p.trim())
      : undefined
    return { profileId, task, documents }
  })
}

let server: Server | null = null
let port = 0
let starting: Promise<number> | null = null

/**
 * 本地 bridge：仅监听 127.0.0.1。
 * 注入到主 CLI 的 skills 通过 `POST /trigger/{design|write|review}` 触发应用拉起子终端，
 * 之后靠 `GET /status|/wait|/retry/{runId}` 盯着这些子任务直到全部出结果。
 */
export function startBridge(handlers: BridgeHandlers): Promise<number> {
  if (starting) return starting
  if (server?.listening) return Promise.resolve(port)
  const pending = doStart(handlers).finally(() => {
    if (starting === pending) starting = null
  })
  starting = pending
  return pending
}

async function doStart(handlers: BridgeHandlers): Promise<number> {
  const current = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.method === 'GET' && url.pathname === '/status') {
      sendJson(res, 200, { ok: true })
      return
    }
    const run = req.method === 'GET' ? RUN_ROUTE.exec(url.pathname) : null
    if (run) {
      const action = run[1]
      const runId = run[2]
      if (action === 'wait') {
        // 长轮询：客户端断开（curl 被杀、命令超时）时 abort，别把挂起者留在台账里
        const controller = new AbortController()
        res.on('close', () => {
          if (!res.writableEnded) controller.abort()
        })
        void handlers
          .onRunWait(runId, Number(url.searchParams.get('timeoutMs') ?? ''), controller.signal)
          .then((snap) => replyRun(res, runId, snap))
          .catch((error) => sendJson(res, 500, { ok: false, error: message(error) }))
        return
      }
      void (async () => {
        try {
          const snap =
            action === 'status' ? handlers.onRunStatus(runId) : await handlers.onRunRetry(runId)
          replyRun(res, runId, snap)
        } catch (error) {
          sendJson(res, 500, { ok: false, error: message(error) })
        }
      })()
      return
    }
    const present = req.method === 'POST' ? PRESENT_ROUTE.exec(url.pathname) : null
    if (present && handlers.onPresent) {
      const session = present[1]
      readBody(req, res, async (body) => {
        const parsed = body ? (JSON.parse(body) as Partial<PresentRequest>) : {}
        const files = Array.isArray(parsed.files)
          ? parsed.files.flatMap((item) => {
              if (!item || typeof item !== 'object') return []
              const path = typeof item.path === 'string' ? item.path.trim() : ''
              if (!path) return []
              return [{ path, label: typeof item.label === 'string' ? item.label.trim() : undefined }]
            }).slice(0, 50)
          : []
        return handlers.onPresent!({
          workDir: String(parsed.workDir ?? ''),
          session,
          title: typeof parsed.title === 'string' ? parsed.title : undefined,
          files
        })
      })
      return
    }
    const m = url.pathname.match(/^\/trigger\/(design|write|review)$/)
    if (req.method === 'POST' && m) {
      readBody(req, res, async (body) => {
        const parsed = body ? (JSON.parse(body) as Partial<TriggerRequest> & { targets?: unknown }) : {}
        const session = typeof parsed.session === 'string' ? parsed.session.trim() : ''
        const request: TriggerRequest = {
          query: String(parsed.query ?? ''),
          workDir: String(parsed.workDir ?? ''),
          session: session || undefined,
          documentPath: String(parsed.documentPath ?? ''),
          targets: normalizeTargets(parsed.targets)
        }
        if (!request.workDir.trim()) throw new Error('缺少 workDir')
        if (!request.documentPath.trim()) throw new Error('缺少 documentPath')
        return handlers.onTrigger(m[1] as TriggerKind, request)
      })
      return
    }
    res.writeHead(404)
    res.end()
  })
  server = current
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        current.off('close', onClose)
        reject(error)
      }
      const onClose = (): void => {
        current.off('error', onError)
        reject(new Error('本机 bridge 已停止启动'))
      }
      current.once('error', onError)
      current.once('close', onClose)
      current.listen(0, '127.0.0.1', () => {
        current.off('error', onError)
        current.off('close', onClose)
        resolve()
      })
    })
    if (server !== current) {
      current.close()
      throw new Error('本机 bridge 已停止启动')
    }
    port = (current.address() as { port: number }).port
    return port
  } catch (error) {
    if (server === current) {
      server = null
      port = 0
    }
    throw error
  }
}

function replyRun(res: ServerResponse, runId: string, snap: RunSnapshot | RetryResponse | null): void {
  if (!snap) {
    sendJson(res, 404, { ok: false, error: `本次 run 不存在或应用已重启，runId 已失效：${runId}` })
    return
  }
  sendJson(res, 200, { ok: true, ...snap })
}

function sendJson(res: ServerResponse, status: number, payload: object): void {
  // 长轮询期间客户端可能已经被杀掉（curl 超时、命令被中断），连接没了就别再写
  if (res.writableEnded || res.destroyed) return
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(payload))
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function readBody(req: IncomingMessage, res: ServerResponse, handler: (body: string) => Promise<unknown>): void {
  let body = ''
  req.on('data', (chunk) => {
    body += chunk
    if (body.length > BODY_LIMIT) req.destroy()
  })
  req.on('end', () => {
    void handler(body)
      .then((result) => sendJson(res, 200, { ok: true, ...(result as object) }))
      .catch((error) => sendJson(res, 500, { ok: false, error: message(error) }))
  })
}

export function bridgePort(): number {
  return port
}

export function stopBridge(): void {
  const current = server
  server = null
  starting = null
  port = 0
  current?.close()
}
