import { useCallback, useEffect, useState } from 'react'
import type {
  AppConfig,
  CliStatus,
  DiscoveredSession,
  DiscoverReq,
  HistoryRecord,
  Note,
  SessionSummary,
  ThemeKind
} from '@shared/types'

// 模块级缓存：切换页面时直接复用，避免重复 IPC 造成的「加载中…」闪烁
let cfgCache: AppConfig | null = null
let cliCache: CliStatus[] | null = null
/** 存活会话快照缓存：工作台刚挂载时先拿上次快照，不然首帧的空列表会把标签误判成「已退出」 */
let sessionsCache: SessionSummary[] = []
/** 便签缓存：整表推送，切页时直接复用 */
let notesCache: Note[] = []

/** 加载配置 + CLI 检测状态，供启动页与设置页使用 */
export function useSettings() {
  const [cfg, setCfg] = useState<AppConfig | null>(cfgCache)
  const [clis, setClis] = useState<CliStatus[]>(cliCache ?? [])
  const [loadError, setLoadError] = useState<string>('')

  useEffect(() => {
    if (cfgCache && cliCache) return
    let alive = true
    Promise.all([window.clichilds.configGet(), window.clichilds.cliDetect()])
      .then(([c, list]) => {
        if (!alive) return
        cfgCache = c
        cliCache = list
        setCfg(c)
        setClis(list)
      })
      .catch((e: unknown) => alive && setLoadError(String(e)))
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    const fn = (c: AppConfig): void => setCfg(c)
    cfgSubs.add(fn)
    return () => {
      cfgSubs.delete(fn)
    }
  }, [])

  const redetect = useCallback(async () => {
    const list = await window.clichilds.cliDetect()
    cliCache = list
    setClis(list)
  }, [])

  return { cfg, setCfg, clis, redetect, loadError }
}

/** 串行即时写盘，避免连续输入时较旧的 IPC 请求覆盖较新的配置。 */
let saveQueue: Promise<void> = Promise.resolve()
export function saveConfig(cfg: AppConfig): Promise<void> {
  const write = saveQueue.catch(() => undefined).then(async () => {
    await window.clichilds.configSet(cfg)
    cfgCache = cfg
  })
  saveQueue = write
  return write
}

/** 配置缓存更新订阅：主进程侧改了配置（如便签迁移）并回传新配置时通知各页面 */
const cfgSubs = new Set<(c: AppConfig) => void>()

/** 接受一份「主进程已生效」的配置：只更新缓存并通知，不再回写 IPC */
export function adoptConfig(cfg: AppConfig): void {
  cfgCache = cfg
  for (const fn of cfgSubs) fn(cfg)
}

// StrictMode 下工作台会挂载两次；短暂合并同 (目录, CLI, 恢复目标) 的启动请求，避免重复拉起 pty
let pendingStart: { key: string; promise: Promise<string> } | null = null

export interface StartMainOpts {
  workDir: string
  profileId: string
  /** 要恢复的 CLI 原生 session id；省略 = 新会话 */
  resumeSessionId?: string
  /** 就绪后自动投递的初始提示词（如「用其他 CLI 继续」的交接说明） */
  initialPrompt?: string
  /** 主动新建场景（工作台「+」）：跳过 StrictMode 合并，两个同参会话要各拉一个 pty */
  fresh?: boolean
}

export function startMainSession(opts: StartMainOpts): Promise<string> {
  const { workDir, profileId, resumeSessionId, initialPrompt, fresh = false } = opts
  const key = `${profileId}|${workDir}|${resumeSessionId ?? ''}`
  if (!fresh && pendingStart && pendingStart.key === key) return pendingStart.promise
  const promise = window.clichilds
    .sessionStart({ workDir, profileId, resumeSessionId, initialPrompt })
    .then((r) => {
      setTimeout(() => {
        if (pendingStart?.promise === promise) pendingStart = null
      }, 1500)
      return r.sessionId
    })
    .catch((error: unknown) => {
      if (pendingStart?.promise === promise) pendingStart = null
      throw error
    })
  if (!fresh) pendingStart = { key, promise }
  return promise
}

/** 存活 pty 会话快照（启动页任务面板 / 工作台的校验列共用） */
export function useSessions(): SessionSummary[] {
  const [sessions, setSessions] = useState<SessionSummary[]>(sessionsCache)
  useEffect(() => {
    let alive = true
    window.clichilds
      .sessionList()
      .then((list) => {
        sessionsCache = list
        if (alive) setSessions(list)
      })
      .catch(() => undefined)
    const off = window.clichilds.onSessionsChanged((list) => {
      sessionsCache = list
      if (alive) setSessions(list)
    })
    return () => {
      alive = false
      off()
    }
  }, [])
  return sessions
}

/** 跨重启的会话历史；主进程每次变更后整表推送 */
export function useHistory(): HistoryRecord[] {
  const [items, setItems] = useState<HistoryRecord[]>([])
  useEffect(() => {
    let alive = true
    window.clichilds
      .historyList()
      .then((list) => alive && setItems(list))
      .catch(() => undefined)
    const off = window.clichilds.onHistoryChanged((list) => alive && setItems(list))
    return () => {
      alive = false
      off()
    }
  }, [])
  return items
}

/** 便签：主进程每次变更后整表推送，渲染层只读不写 */
export function useNotes(): Note[] {
  const [notes, setNotes] = useState<Note[]>(notesCache)
  useEffect(() => {
    let alive = true
    window.clichilds
      .notesList()
      .then((list) => {
        notesCache = list
        if (alive) setNotes(list)
      })
      .catch(() => undefined)
    const off = window.clichilds.onNotesChanged((list) => {
      notesCache = list
      if (alive) setNotes(list)
    })
    return () => {
      alive = false
      off()
    }
  }, [])
  return notes
}

/**
 * 回填各 CLI 自己的会话。请求变了就重查，另有手动刷新；
 * 别挂到 1s 的会话推送循环上（要扫磁盘目录 + 读文件头）。
 */
export function useDiscovered(req: DiscoverReq): {
  sessions: DiscoveredSession[]
  loading: boolean
  refresh: () => void
} {
  const key = JSON.stringify(req)
  const [sessions, setSessions] = useState<DiscoveredSession[]>([])
  const [loading, setLoading] = useState(false)
  const load = useCallback(() => {
    setLoading(true)
    window.clichilds
      .sessionDiscover(JSON.parse(key) as DiscoverReq)
      .then(setSessions)
      .catch(() => setSessions([]))
      .finally(() => setLoading(false))
  }, [key])
  useEffect(() => {
    load()
  }, [load])
  return { sessions, loading, refresh: load }
}

export function applyTheme(theme: ThemeKind): void {
  document.documentElement.dataset.theme = theme
  syncTitleBarTheme()
}

/**
 * 把当前皮肤的标题栏配色推给主进程：窗口右侧的原生按钮区（Window Controls Overlay）
 * 需要与自绘标题栏底色一致，否则会出现一条色差。颜色直接读 CSS 变量，避免多处维护。
 */
function syncTitleBarTheme(): void {
  try {
    const cs = getComputedStyle(document.documentElement)
    const color = cs.getPropertyValue('--bg-panel').trim()
    const symbolColor = cs.getPropertyValue('--text-dim').trim() || color
    if (!color) return
    window.clichilds.setTitleBarTheme({ color, symbolColor })
  } catch {
    // 旧窗口没有 WCO：忽略
  }
}

/** 已安装的 CLI 列表 */
export function installedClis(clis: CliStatus[]): CliStatus[] {
  return clis.filter((c) => c.installed)
}
