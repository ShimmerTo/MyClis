import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, Notification, shell } from 'electron'
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { execFile } from 'child_process'
import { tmpdir } from 'os'
import { join, dirname, resolve, isAbsolute } from 'path'
import { CH, DEFAULT_NOTES_DIR, TITLEBAR_OVERLAY_HEIGHT } from '../shared/types'
import type {
  AppConfig,
  CliId,
  DiscoverReq,
  NoteAssetResult,
  NoteKind,
  NoteStatus,
  TermMenuAction,
  TerminalKind,
  TranscriptReq
} from '../shared/types'
import { permissionLabelOf, profileLabel } from '../shared/profile'
import { buildChildControlInjection, buildPresentInjection } from '../shared/skillPrompts'
import { loadConfig, saveConfig } from './config/store'
import { cancelDataDirectoryMigration, dataDirectoryErrorMessage, getDataDirectory, prepareDataDirectoryMigration } from './config/dataDirectory'
import { DEFAULT_CONFIG, validateAppConfig } from './config/schema'
import { UpdateManager } from './update/manager'
import { detectAll, getCliBin } from './cli/detect'
import { manageCli } from './cli/management'
import { testCliModel } from './cli/models'
import { buildLaunch } from './cli/launch'
import { getAdapter } from './cli/registry'
import { TerminalManager } from './pty/terminals'
import { openNativeTerminal } from './pty/external'

import { toShellLine } from './util'
import { startBridge, bridgePort } from './bridge/server'
import type { BridgeHandlers } from './bridge/server'
import { ReviewRunner } from './review/runner'
import { generateSkillFiles } from './skills/generator'
import { injectSkills } from './skills/injector'
import { ChangesService } from './git/changes'
import { HistoryStore } from './sessions/history'
import { discoverSessions } from './sessions/discover'
import { readTranscript } from './sessions/transcripts'
import { OutputStore } from './outputs/store'
import { PROMPT_LEAD, removePromptFile, writePromptFile } from './prompts/promptFile'
import { ensureSessionWorkspace, workspaceRelativePath } from './sessions/workspace'
import { NotesStore } from './notes/store'
import { registerNoteCapture } from './notes/capture'
import { cleanupUnusedAssets, clipboardFilePaths, installNotesProtocol, readClipboardForNote, readNoteAsset, saveClipboardImage } from './notes/assets'
import { registerSsh } from './ssh'
import { registerDatabase } from './database'

let manager: TerminalManager | null = null
let updates: UpdateManager | null = null
const PASTE_DIR = join(tmpdir(), 'clichilds-paste')

/** 取路径最后一段，用于通知标题/正文 */
const dirBase = (p: string): string => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p

function cleanupPasteImages(): void {
  try {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
    for (const name of readdirSync(PASTE_DIR)) {
      const path = join(PASTE_DIR, name)
      if (statSync(path).isFile() && statSync(path).mtimeMs < cutoff) rmSync(path, { force: true })
    }
  } catch {
    // 临时目录不存在或个别文件被占用时忽略
  }
}

export function getTerminalManager(): TerminalManager {
  if (!manager) throw new Error('TerminalManager 未初始化')
  return manager
}

/** 更新管理（启动时先问它要不要装已经下载好的安装包） */
export function getUpdateManager(): UpdateManager | null {
  return updates
}

/** bridge 地址；启动会话前保证 bridge 已监听 */
function bridgeUrl(): string {
  return `http://127.0.0.1:${bridgePort()}`
}

/**
 * 把当前配置渲染成 skills，注入配置里出现过的每个 CLI。
 */
function syncSkills(cfg: AppConfig, sshEnabled: boolean, databaseEnabled: boolean, extra: Iterable<CliId> = []): void {
  const files = generateSkillFiles(cfg, bridgeUrl(), sshEnabled, databaseEnabled)
  const targets = new Set<CliId>(extra)
  for (const profile of cfg.cliConfigs) targets.add(profile.cli)
  for (const id of targets) {
    const adapter = getAdapter(id)
    if (adapter) injectSkills(adapter, files)
  }
}

/**
 * IPC 通道统一注册处（所有通道在这里汇总，模块实现放各自目录）。
 */
export function registerIpc(getWin: () => BrowserWindow | null): () => void {
  cleanupPasteImages()
  let disposed = false
  const syncManagedSkills = async (): Promise<void> => {
    const [sshEnabled, databaseEnabled] = await Promise.all([ssh.skillEnabled(), database.skillEnabled()])
    if (!disposed) syncSkills(loadConfig(), sshEnabled, databaseEnabled)
  }
  const ssh = registerSsh(getWin, syncManagedSkills)
  const database = registerDatabase(getWin, ssh.service, () => loadConfig().workDirs, syncManagedSkills)
  const send: (channel: string, payload: unknown) => void = (channel, payload) => {
    getWin()?.webContents.send(channel, payload)
  }
  const terminals = new TerminalManager(send)
  manager = terminals
  const history = new HistoryStore(send)
  const changes = new ChangesService(send)
  const notes = new NotesStore(send)
  const noteCapture = registerNoteCapture(notes, getWin)
  // 自定义协议只在 ready 之后能接管；它只按 noteId 查路径，渲染层传不了任意路径
  installNotesProtocol((id) => notes.list().find((item) => item.id === id))
  terminals.onTerminalExit((info) => {
    // 纯 shell 会话不是任务，不进历史
    if (info.role !== 'shell') history.recordExit(info)
    // 主终端退出：该工作目录不再需要实时监听变更
    if (info.role === 'main') {
      ssh.revokeMain(info.id)
      database.revokeMain(info.id)
      changes.untrack(info.workDir)
    }
  })
  terminals.onNativeId((termId, nativeSessionId) => history.recordNativeId(termId, nativeSessionId))
  // CLI 停止输出：走系统通知提醒用户回来（开关在设置页，默认开）
  terminals.onIdle((info, silentMs) => {
    if (!loadConfig().notifications?.cliIdle || !Notification.isSupported()) return
    const label = info.profileLabel ?? `${info.cli}${info.model ? ` · ${info.model}` : ''}`
    const seconds = Math.max(1, Math.round(silentMs / 1000))
    const note = new Notification({
      title: `${label} 已停止输出`,
      body: `${dirBase(info.workDir)} · 已静默 ${seconds} 秒，点击回到 MyClis`
    })
    note.on('click', () => {
      const win = getWin()
      if (!win) return
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    })
    note.show()
  })
  const outputs = new OutputStore(terminals, send)
  const runner = new ReviewRunner(terminals, history, outputs)

  // bridge：skills 触发 -> 按主会话快照拉起子终端；之后的查询、等待、重试都按 runId 走。
  // 端口固定 127.0.0.1 随机。
  const bridgeHandlers: BridgeHandlers = {
    onTrigger: (kind, request) => runner.run(kind, request),
    onPresent: async (request) => {
      const bundle = outputs.publish(request)
      return { bundleId: bundle.id, count: bundle.artifacts.length }
    },
    onRunStatus: (runId) => runner.status(runId),
    onRunWait: (runId, timeoutMs, signal) => runner.wait(runId, timeoutMs, signal),
    onRunRetry: (runId) => runner.retry(runId),
    onChildren: (sessionId) => runner.children(sessionId),
    onChildResume: (sessionId, termId) => runner.resumeChild(sessionId, termId),
    onChildApproval: (sessionId, termId, approvalId, option) => runner.chooseApproval(sessionId, termId, approvalId, option),
    onSsh: (req, res) => ssh.service.handleHttp(req, res),
    onDatabase: (req, res) => database.service.handleHttp(req, res)
  }
  void startBridge(bridgeHandlers).then(syncManagedSkills).catch((error: unknown) => {
    console.error('启动本机 bridge 或同步命令失败', error)
    if (!disposed) void dialog.showMessageBox({ type: 'warning', title: '命令未同步',
      message: '启动时同步命令失败，请在「命令」页检查并重新同步。不会结束现有 CLI 会话。' })
      .catch((cause: unknown) => console.error('显示命令同步提醒失败', cause))
  })

  ipcMain.handle(CH.bridgeInfo, () => ({ port: bridgePort(), baseUrl: `http://127.0.0.1:${bridgePort()}`,
    appVersion: app.getVersion(), appPath: app.getAppPath(), packaged: app.isPackaged }))
  ipcMain.handle(CH.skillsSync, async () => {
    await startBridge(bridgeHandlers)
    await syncManagedSkills()
  })

  // ---- 配置 ----
  ipcMain.handle(CH.dataDirectoryGet, () => getDataDirectory())
  ipcMain.handle(CH.dataDirectoryMigrate, (event, payload: { dir: string }) => {
    const win = getWin()
    if (disposed || !win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) {
      throw new Error('不允许从此窗口切换数据目录')
    }
    try {
      if (!prepareDataDirectoryMigration(payload?.dir)) return
      // 只交付 NSIS 安装版，没有便携启动器要重启：普通 relaunch 即可
      try {
        app.relaunch()
      } catch (error) {
        cancelDataDirectoryMigration()
        throw error
      }
      app.quit()
    } catch (error) {
      throw new Error(dataDirectoryErrorMessage(error))
    }
  })
  ipcMain.handle(CH.configGet, () => noteCapture.config())
  ipcMain.handle(CH.configSet, async (event, cfg: AppConfig) => {
    const win = getWin()
    if (cfg.notes?.selectionCaptureEnabled !== (await noteCapture.config()).notes.selectionCaptureEnabled &&
      (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame)) {
      throw new Error('不允许从此窗口设置全局便签收集')
    }
    const errors = validateAppConfig(cfg)
    for (const [i, profile] of cfg.cliConfigs.entries()) {
      const adapter = getAdapter(profile.cli)
      if (adapter && !adapter.permissionOptions.some((option) => option.id === profile.permissionMode)) {
        errors.push(`CLI 设置第 ${i + 1} 项的运行权限不属于 ${adapter.label}`)
      }
    }
    if (errors.length > 0) {
      throw new Error(errors.join('；'))
    }
    await startBridge(bridgeHandlers)
    // CLI 档案被删除或改类型时，也要到旧 CLI 目录删除不再启用的命令。
    const previous = loadConfig()
    const previousCliIds = previous.cliConfigs.map((profile) => profile.cli)
    syncSkills(cfg, await ssh.skillEnabled(), await database.skillEnabled(), previousCliIds)
    await ssh.revokeRemovedProjects(previous.workDirs, cfg.workDirs)
    await database.revokeRemovedProjects(previous.workDirs, cfg.workDirs)
    return noteCapture.save(cfg)
  })

  // ---- 目录选择 ----
  ipcMain.handle(CH.dirPick, async (_e, opts?: { create?: boolean }) => {
    const win = getWin()
    if (!win) return null
    const properties: ('openDirectory' | 'createDirectory')[] = ['openDirectory']
    if (opts?.create) properties.push('createDirectory')
    const res = await dialog.showOpenDialog(win, { properties })
    return res.canceled ? null : res.filePaths[0]
  })

  ipcMain.handle(CH.pasteFiles, (): string[] => {
    try {
      const files = clipboardFilePaths()
      if (files.length > 0) return files
      const img = clipboard.readImage()
      if (img.isEmpty()) return []
      mkdirSync(PASTE_DIR, { recursive: true })
      const file = join(PASTE_DIR, `paste-${Date.now()}-${randomUUID().slice(0, 8)}.png`)
      writeFileSync(file, img.toPNG())
      return [file]
    } catch (error) {
      console.error('读取终端剪贴板失败', error)
      throw new Error('读取剪贴板文件或图片失败')
    }
  })

  // ---- CLI 检测 ----
  ipcMain.handle(CH.cliDetect, () => detectAll())
  ipcMain.handle(CH.cliManage, (_e, request: { cli: CliId; action: 'install' | 'upgrade' }) => manageCli(request, detectAll))
  // 模型测试：起一次 CLI 子进程拿结果，失败原因一律回给渲染层展示
  ipcMain.handle(CH.cliModelTest, (_e, req: { cli: CliId; model: string }) =>
    testCliModel({ cli: req.cli, model: typeof req.model === 'string' ? req.model : '' })
  )

  // ---- 会话：进入主界面（主终端） ----
  ipcMain.handle(
    CH.sessionStart,
    async (event, payload: { workDir: string; profileId: string; resumeSessionId?: string; initialPrompt?: string; noteIds?: string[]; allowCrossDirNotes?: boolean }) => {
      if (payload.allowCrossDirNotes === true) {
        const win = getWin()
        if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error('不允许从此窗口跨目录发送便签')
        if (!payload.noteIds?.length || !payload.initialPrompt?.trim() || payload.resumeSessionId) throw new Error('请选择待执行便签并新建会话')
      }
      const cfg = loadConfig()
      const workDir = payload.workDir?.trim() ?? ''
      // 目录没了 node-pty 只会抛一句看不懂的 spawn 错误，这里先拦住
      if (!workDir || workDir === DEFAULT_NOTES_DIR || !existsSync(resolve(workDir))) throw new Error(`工作目录不存在：${workDir || '（未选择）'}`)
      if (payload.noteIds !== undefined) notes.validateSelection(workDir, payload.noteIds, payload.allowCrossDirNotes === true)
      const profile = cfg.cliConfigs.find((item) => item.id === payload.profileId)
      if (!profile) throw new Error(`未知 CLI 设置：${payload.profileId}`)
      const adapter = getAdapter(profile.cli)
      if (!adapter) throw new Error(`未知 CLI：${profile.cli}`)
      const bin = await getCliBin(profile.cli)
      if (!bin) throw new Error(`未检测到 ${adapter.label}，请先安装`)
      const model = profile.model?.trim() ?? ''
      const profilesById = new Map(cfg.cliConfigs.map((item) => [item.id, item]))
      const pickMany = (ids: string[]) =>
        ids.map((id) => profilesById.get(id)).filter((item): item is NonNullable<typeof item> => !!item)
      const taskAssignments = {
        design: pickMany(cfg.launch.designCliIds),
        write: pickMany(cfg.launch.codeWriterCliIds),
        review: pickMany(cfg.launch.codeReviewCliIds),
        custom: Object.fromEntries(cfg.commands
          .filter((command) => command.enabled && !command.builtinKind && command.allowChildClis === true)
          .map((command) => [command.id, pickMany(command.childCliIds ?? [])]))
      }

      // 1) 保证 bridge 就绪 2) 按启动页分配增删主 CLI commands
      await startBridge(bridgeHandlers)
      syncSkills(cfg, await ssh.skillEnabled(), await database.skillEnabled(), [profile.cli])

      // 启动注入只给主终端；子 CLI 由 review/runner 拉起，不带。
      // 会话 id 先定下来：注入里的发布地址要用它，终端创建也用它，两边必须是同一个。
      if (payload.resumeSessionId && terminals.sessions().some((session) =>
        session.cli === profile.cli && session.nativeSessionId === payload.resumeSessionId)) {
        throw new Error('该原生会话仍在运行，请返回已有终端，不能重复恢复')
      }
      if (payload.allowCrossDirNotes === true) notes.validateSelection(workDir, payload.noteIds!, true)
      const termId = randomUUID()
      const prior = payload.resumeSessionId ? history.list().find((item) =>
        item.cli === profile.cli && item.nativeSessionId === payload.resumeSessionId) : undefined
      const workspaceSessionId = prior?.workspaceSessionId ?? prior?.sessionId ?? termId
      ensureSessionWorkspace(workDir, workspaceSessionId)
      const sessionDir = workspaceRelativePath(workspaceSessionId)
      const present = cfg.injections.find((item) => item.builtinKind === 'present' && item.enabled)
      const extraPrompt = [
        `本会话目录是 ${sessionDir}，已在工作目录下创建。所有临时文件、请求、审批和产出只写这里，requests、results、prompts 在其下。命令文档中的 <本会话目录> 必须替换为这个路径，不要扫描其他会话目录或旧的公共目录。`,
        buildChildControlInjection(bridgeUrl(), termId, sessionDir),
        present ? buildPresentInjection(bridgeUrl(), termId, sessionDir) : ''
      ].join(' ')

      // 层1 投递：正文写进工作目录内的临时文件，命令行只带引导语和相对路径。
      // 适配器没声明 initialPromptArgs 时退回粘贴链路（autoPrompt 照旧）。
      const initialPrompt = payload.initialPrompt?.trim() || undefined
      const promptFile =
        initialPrompt && adapter.delivery?.initialPromptArgs ? writePromptFile(workDir, initialPrompt, workspaceSessionId) : undefined
      // 原生 id 与启动行一起定下来，别在中间留可失败的 await
      const launch = buildLaunch(
        adapter,
        bin,
        model,
        profile.permissionMode,
        payload.resumeSessionId,
        extraPrompt,
        promptFile ? { file: promptFile.rel, lead: PROMPT_LEAD } : undefined
      )
      let info
      try {
        const sessionLabel = profileLabel(profile, adapter.label, permissionLabelOf(adapter.permissionOptions, profile.permissionMode))
        const mainEnv = {
          ...ssh.createMainEnv(termId, workDir, sessionLabel, bridgeUrl()),
          ...database.createMainEnv(termId, workDir, sessionLabel)
        }
        info = await terminals.create({
          id: termId,
          workspaceSessionId,
          role: 'main',
          mainEnv,
          profileId: profile.id,
          permissionMode: profile.permissionMode,
          label: profileLabel(
            profile,
            adapter.label,
            permissionLabelOf(adapter.permissionOptions, profile.permissionMode)
          ),
          cli: profile.cli,
          model: model || undefined,
          workDir,
          shell: cfg.terminal,
          initialCommand: toShellLine(launch.args, cfg.terminal),
          concealBoot: true,
          nativeSessionId: launch.nativeSessionId,
          handshake: adapter.startupHandshake,
          delivery: adapter.delivery,
          // 层1 时这里只作指纹用，不再往输入框粘贴
          autoPrompt: initialPrompt,
          promptFile: promptFile?.abs,
          taskAssignments
        })
      } catch (error) {
        // 终端没起来（shell 不可用、pty spawn 失败）时临时文件不能留在用户仓库里
        removePromptFile(promptFile?.abs)
        ssh.revokeMain(termId)
        database.revokeMain(termId)
        throw error
      }
      history.recordStart(info, {
        permissionMode: profile.permissionMode,
        resumedFrom: payload.resumeSessionId
      })
      if (prior) runner.reparentChildren(prior.sessionId, info.id, workspaceSessionId)
      if (payload.noteIds?.length) {
        try {
          notes.bindExecution(payload.noteIds, { workspaceSessionId, cli: profile.cli, profileId: profile.id })
        } catch (error) {
          // PTY 已创建，便签持久化失败不能让调用方误判启动失败并再次拉起。
          console.error('会话已启动，但关联便签最近执行失败', { sessionId: info.id, error })
          void Promise.resolve().then(() => dialog.showMessageBox({
            type: 'warning',
            title: '便签关联未保存',
            message: 'CLI 会话已启动，但未能保存便签的最近执行关联。',
            detail: '请继续使用已启动的终端，不要重复启动。便签仍可能指向上一次执行，请检查便签存储目录权限与磁盘空间。',
            buttons: ['知道了']
          })).catch((error: unknown) => console.error('显示便签关联警告失败', error))
        }
      }
      // 主终端一拉起就开始盯着工作目录的 git 变更
      changes.track(workDir)
      return { sessionId: info.id }
    }
  )

  ipcMain.handle(CH.sessionList, () => terminals.sessions())

  // ---- 会话历史与 transcript ----
  ipcMain.handle(CH.historyList, () => history.list())
  ipcMain.handle(CH.historyDelete, (_e, sessionId: string) => history.remove(sessionId))
  ipcMain.handle(CH.sessionDiscover, (_e, req: DiscoverReq) => {
    const mine = new Set<string>()
    for (const record of history.list()) {
      if (record.nativeSessionId) mine.add(`${record.cli}|${record.nativeSessionId}`)
      for (const child of record.children) {
        if (child.nativeSessionId) mine.add(`${child.cli}|${child.nativeSessionId}`)
      }
    }
    return discoverSessions(req, mine)
  })
  ipcMain.handle(CH.transcriptRead, (_e, req: TranscriptReq) => readTranscript(req))

  // ---- 便签：整表读、增改删清；主进程每次变更后整表推给渲染层 ----
  ipcMain.handle(CH.notesList, () => notes.list())
  ipcMain.on(CH.notesSelection, (event, payload: Parameters<typeof noteCapture.selectLocal>[0]) => {
    const win = getWin()
    if (disposed || !win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) return
    noteCapture.selectLocal(payload)
  })
  ipcMain.handle(CH.notesReorder, (_e, payload: { workDir: string; ids: string[] }) => notes.reorder(payload.workDir, payload.ids))
  ipcMain.handle(
    CH.notesAdd,
    (
      _e,
      payload: { workDir: string; kind: NoteKind; content: string; title?: string }
    ) => notes.add(payload)
  )
  ipcMain.handle(CH.notesUpdate, (_e, payload: { id: string; title?: string; content?: string; status?: NoteStatus }) =>
    notes.update(payload)
  )
  ipcMain.handle(CH.notesRemove, (_e, id: string) => notes.remove(id))
  ipcMain.handle(CH.notesClear, (_e, payload?: { workDir?: string }) => notes.clear(payload?.workDir))
  // 预览：只接受 noteId，路径由主进程从便签表里取 —— 渲染层拿不到「按路径读文件」的能力
  ipcMain.handle(CH.notesAsset, async (_e, payload: { noteId: string }) => {
    const note = notes.list().find((item) => item.id === payload.noteId)
    if (!note) return { media: 'binary', reason: 'missing' } satisfies NoteAssetResult
    return readNoteAsset(note)
  })
  ipcMain.handle(CH.notesSaveImage, () => saveClipboardImage())
  ipcMain.handle(CH.notesPaste, () => readClipboardForNote())
  // 打开/定位便签引用的文件：路径同样由主进程从便签表里取，渲染层只给 id
  ipcMain.handle(CH.notesOpenFile, async (_e, payload: { noteId: string; reveal?: boolean }) => {
    const note = notes.list().find((item) => item.id === payload.noteId)
    if (!note || note.kind !== 'file') throw new Error('这条便签没有可打开的文件')
    if (payload.reveal) shell.showItemInFolder(note.content)
    else {
      const message = await shell.openPath(note.content)
      if (message) throw new Error(message)
    }
  })
  ipcMain.handle(CH.notesCleanupAssets, (_e, payload: { dryRun: boolean }) =>
    cleanupUnusedAssets(notes.list(), payload?.dryRun !== false)
  )
  // 仓库根相对路径 -> 绝对路径：git 变更清单里的 path 是仓库根相对，
  // 而工作目录可能是仓库的子目录，只有 ChangesService 知道真正的根
  ipcMain.handle(CH.pathResolve, (_e, payload: { workDir: string; path: string }) =>
    changes.resolvePath(payload.workDir, payload.path)
  )
  ipcMain.handle(CH.outputList, (_e, sessionId: string) => outputs.list(sessionId))
  ipcMain.handle(CH.outputRead, (_e, req: { sessionId: string; artifactId: string }) =>
    outputs.read(req.sessionId, req.artifactId)
  )
  ipcMain.handle(CH.outputAsset, (_e, req: { sessionId: string; artifactId: string; src: string }) =>
    outputs.readAsset(req.sessionId, req.artifactId, req.src)
  )
  // 在资源管理器里定位产物：路径由主进程从产出表里取，渲染层只给 id
  ipcMain.handle(CH.outputReveal, async (_e, req: { sessionId: string; artifactId: string }) => {
    const target = outputs.locate(req.sessionId, req.artifactId)
    // 文件还在就选中它；已被删除（或权限不足）就退化成打开所在目录
    if (existsSync(target)) shell.showItemInFolder(target)
    else await shell.openPath(dirname(target))
  })
  ipcMain.handle(CH.externalOpen, async (_e, url: string) => {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('只允许打开 http/https 链接')
    await shell.openExternal(parsed.toString())
  })

  // ---- 自动更新 ----
  updates = new UpdateManager({
    root: getDataDirectory,
    currentVersion: app.getVersion(),
    packaged: app.isPackaged,
    emit: (state) => send(CH.updateChanged, state),
    config: () => loadConfig().update ?? DEFAULT_CONFIG.update,
    quit: () => app.quit()
  })
  ipcMain.handle(CH.updateState, () => updates!.stateSnapshot())
  ipcMain.handle(CH.updateCheck, async () => {
    try {
      return await updates!.check(true)
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : '检查更新失败')
    }
  })
  ipcMain.handle(CH.updateDownload, async () => {
    try {
      return await updates!.download()
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : '下载更新失败')
    }
  })
  ipcMain.handle(CH.updateInstall, () => {
    updates!.install()
    // 安装程序会先等 UAC 提示，这里同步退出：留在前台会挡住 Installer 覆盖程序文件
    app.quit()
  })
  ipcMain.handle(CH.updateDismiss, async (_e, version: string) => {
    if (typeof version !== 'string' || !version.trim()) throw new Error('版本号无效')
    const cfg = loadConfig()
    saveConfig({ ...cfg, update: { ...cfg.update, lastDismissedVersion: version.trim() } })
    send(CH.updateChanged, updates!.stateSnapshot())
  })
  // ---- 工作目录变更清单与单文件 diff ----
  ipcMain.handle(CH.gitChangesList, (_e, workDir: string) => changes.list(workDir))
  ipcMain.handle(
    CH.gitDiff,
    (_e, req: { workDir: string; path: string; origPath?: string }) =>
      changes.diff(req.workDir, req.path, req.origPath)
  )
  ipcMain.handle(CH.gitReveal, async (_e, req: { workDir: string; path: string }) => {
    const absolute = await changes.resolvePath(req.workDir, req.path)
    // 文件还在就在资源管理器里选中它；已删除（或权限不足）就退化成打开所在目录
    if (existsSync(absolute)) shell.showItemInFolder(absolute)
    else await shell.openPath(dirname(absolute))
  })
  ipcMain.handle(CH.gitBranch, async (_e, workDir: string): Promise<string | null> => {
    try {
      return await new Promise<string | null>((resolve) => {
        execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: workDir, timeout: 3000 }, (err, stdout) => {
          resolve(err ? null : stdout.trim())
        })
      })
    } catch {
      return null
    }
  })

  /** 在应用内的子终端区开一个纯 shell 面板（不弹系统窗口，也不写会话历史） */
  const openShell = async (workDir: string, kind?: TerminalKind): Promise<void> => {
    await terminals.create({
      role: 'shell',
      cli: 'shell',
      workDir,
      shell: kind ?? loadConfig().terminal
    })
  }

  ipcMain.handle(CH.termOpenShell, (_e, payload: { workDir: string; kind?: TerminalKind }): void => {
    void openShell(payload.workDir, payload.kind)
  })

  /** 用系统原生窗口打开同一份终端：同目录、同 Shell，CLI 会话还带上同一行启动命令 */
  ipcMain.handle(CH.termOpenExternal, (_e, payload: { id: string }): void => {
    const target = manager?.externalTarget(payload.id)
    if (!target) throw new Error('这个终端已经结束了，无法用原生窗口打开')
    openNativeTerminal(target)
  })

  /**
   * 关闭一个子终端并按原参数重开一个：CLI 子任务交给 runner（任务规格在它那儿），
   * 手动开的纯 shell 用同一个工作目录与 Shell 重建。主终端不参与（页卡栏管它）。
   */
  ipcMain.handle(CH.childResume, (_e, payload: { sessionId: string; termId: string }) =>
    runner.resumeChild(payload.sessionId, payload.termId))

  ipcMain.handle(CH.termRestart, async (_e, payload: { id: string }): Promise<void> => {
    const info = terminals.get(payload.id)
    if (!info) return
    if (info.role === 'shell') {
      await openShell(info.workDir, info.shell)
      terminals.kill(payload.id)
      return
    }
    if (info.role === 'child') {
      await runner.restart(payload.id)
      return
    }
    throw new Error('主终端不支持重开')
  })

  // 交接记录落盘：%TEMP%/clichilds-handoff/ 下的 txt，返回绝对路径给新 CLI 读
  ipcMain.handle(CH.handoffWrite, (_e, p: { name: string; text: string }): { path: string } => {
    const dir = join(tmpdir(), 'clichilds-handoff')
    mkdirSync(dir, { recursive: true })
    const safe = (p.name || 'session').replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 60) || 'session'
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
    const file = join(dir, `${safe}-${stamp}.txt`)
    writeFileSync(file, p.text, 'utf8')
    return { path: file }
  })

  // ---- 窗口标题栏（原生窗口按钮叠加层）配色跟随皮肤 ----
  ipcMain.on(CH.titleBarTheme, (_e, p: { color: string; symbolColor: string }) => {
    try {
      getWin()?.setTitleBarOverlay({ color: p.color, symbolColor: p.symbolColor, height: TITLEBAR_OVERLAY_HEIGHT })
    } catch {
      // 未启用 titleBarOverlay 的窗口（或旧版 Electron）直接忽略
    }
  })

  // ---- 终端 IO ----
  ipcMain.on(CH.termWrite, (_e, p: { id: string; data: string }) => manager?.write(p.id, p.data))

  // 终端右键菜单：原生菜单（终端复制通常要靠鼠标选中，这里给出无需拖拽的复制/粘贴入口）
  ipcMain.on(CH.termMenu, (e, p: { id: string; hasSelection: boolean }) => {
    // 便签归属工作目录：终端实例池在渲染层没有 workDir，只能由主进程按 pty id 查
    const workDir = manager?.get(p.id)?.workDir
    const action = (key: TermMenuAction): (() => void) => (): void => {
      e.sender.send(CH.termMenuAction, { id: p.id, action: key, workDir })
    }
    const menu = Menu.buildFromTemplate([
      { label: '复制选中', accelerator: 'CmdOrCtrl+Shift+C', enabled: p.hasSelection, click: action('copy') },
      { label: '粘贴', accelerator: 'CmdOrCtrl+Shift+V', click: action('paste') },
      { label: '存储到便签', enabled: p.hasSelection, click: action('saveNote') },
      {
        label: '加入当前目录便签',
        enabled: p.hasSelection && !!workDir,
        click: action('addNote')
      },
      { type: 'separator' },
      { label: '全选', accelerator: 'CmdOrCtrl+Shift+A', click: action('selectAll') },
      { label: '清屏', click: action('clear') },
      { type: 'separator' },
      { label: '字号放大', accelerator: 'CmdOrCtrl+Plus', click: action('zoomIn') },
      { label: '字号缩小', accelerator: 'CmdOrCtrl+-', click: action('zoomOut') }
    ])
    menu.popup({ window: BrowserWindow.fromWebContents(e.sender) ?? undefined })
  })
  ipcMain.on(
    CH.termResize,
    (_e, p: { id: string; cols: number; rows: number }) => manager?.resize(p.id, p.cols, p.rows)
  )
  ipcMain.on(CH.termKill, (_e, p: { id: string }) => manager?.kill(p.id))
  ipcMain.on(CH.termRetryPrompt, (_e, p: { id: string }) => {
    if (terminals.get(p.id)?.role === 'child') runner.retryPrompt(p.id)
    else terminals.retryPrompt(p.id)
  })
  ipcMain.handle(CH.termAttach, (_e, id: string) => manager?.attach(id) ?? '')
  ipcMain.on(CH.termDetach, (_e, p: { id: string }) => manager?.detach(p.id))

  return () => { disposed = true; updates?.dispose(); noteCapture.dispose(); database.dispose(); ssh.dispose() }
}
