import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { CH } from '../shared/types'
import type {
  AppConfig,
  ChangeFile,
  ClichildsApi,
  ClipboardPayload,
  CliId,
  CliStatus,
  DiscoverReq,
  GitDiffResult,
  HistoryRecord,
  Note,
  NoteAssetResult,
  NoteKind,
  NoteStatus,
  OutputBundle,
  SessionSummary,
  TermMenuAction,
  TerminalKind,
  TranscriptReq,
  UpdateState
} from '../shared/types'

function subscribe<T>(channel: string, cb: (p: T) => void): () => void {
  const listener = (_e: unknown, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: ClichildsApi = {
  database: {
    getSnapshot: () => ipcRenderer.invoke(CH.databaseGetSnapshot),
    updateConfig: update => ipcRenderer.invoke(CH.databaseUpdateConfig, update),
    testConnection: id => ipcRenderer.invoke(CH.databaseTest, id),
    listTables: input => ipcRenderer.invoke(CH.databaseTables, input),
    tableDetail: input => ipcRenderer.invoke(CH.databaseTableDetail, input),
    submitQuery: query => ipcRenderer.invoke(CH.databaseSubmitQuery, query),
    browseTable: query => ipcRenderer.invoke(CH.databaseBrowseTable, query),
    deleteRows: input => ipcRenderer.invoke(CH.databaseDeleteRows, input),
    requestInspect: key => ipcRenderer.invoke(CH.databaseInspect, key),
    requestDecide: decision => ipcRenderer.invoke(CH.databaseDecide, decision),
    requestCancel: key => ipcRenderer.invoke(CH.databaseCancel, key),
    onChanged: callback => subscribe(CH.databaseChanged, callback)
  },
  databaseResolveScope: dir => ipcRenderer.invoke(CH.databaseResolveScope, dir),
  databasePickFile: () => ipcRenderer.invoke(CH.databasePickFile),
  ssh: {
    getSnapshot: () => ipcRenderer.invoke(CH.sshGetSnapshot),
    updateConfig: (update) => ipcRenderer.invoke(CH.sshUpdateConfig, update),
    connect: (request) => ipcRenderer.invoke(CH.sshConnect, request),
    disconnect: (id) => ipcRenderer.invoke(CH.sshDisconnect, id),
    authRespond: (response) => ipcRenderer.invoke(CH.sshAuthRespond, response),
    trustHostKey: (decision) => ipcRenderer.invoke(CH.sshTrustHostKey, decision),
    terminalOpen: (id) => ipcRenderer.invoke(CH.sshTerminalOpen, id),
    terminalClose: (id) => ipcRenderer.invoke(CH.sshTerminalClose, id),
    terminalWrite: (input) => ipcRenderer.invoke(CH.sshTerminalWrite, input),
    terminalResize: (input) => ipcRenderer.invoke(CH.sshTerminalResize, input),
    terminalAttach: (id) => ipcRenderer.invoke(CH.sshTerminalAttach, id),
    terminalDetach: (id) => ipcRenderer.invoke(CH.sshTerminalDetach, id),
    requestInspect: (key) => ipcRenderer.invoke(CH.sshRequestInspect, key),
    requestDecide: (decision) => ipcRenderer.invoke(CH.sshRequestDecide, decision),
    requestCancel: (key) => ipcRenderer.invoke(CH.sshRequestCancel, key),
    onChanged: (cb) => subscribe(CH.sshChanged, cb),
    onTerminalData: (cb) => subscribe(CH.sshTerminalData, cb),
    onTerminalExit: (cb) => subscribe(CH.sshTerminalExit, cb)
  },
  sshResolveScope: (workDir) => ipcRenderer.invoke(CH.sshResolveScope, workDir),
  sshPickIdentity: () => ipcRenderer.invoke(CH.sshPickIdentity),
  configGet: () => ipcRenderer.invoke(CH.configGet),
  configSet: (cfg: AppConfig) => ipcRenderer.invoke(CH.configSet, cfg),
  dataDirectoryGet: () => ipcRenderer.invoke(CH.dataDirectoryGet),
  dataDirectoryMigrate: (payload) => ipcRenderer.invoke(CH.dataDirectoryMigrate, payload),
  cliDetect: () => ipcRenderer.invoke(CH.cliDetect),
  cliManage: (req) => ipcRenderer.invoke(CH.cliManage, req),
  notesReorder: (req) => ipcRenderer.invoke(CH.notesReorder, req),
  cliModelTest: (req: { cli: CliId; model: string }) => ipcRenderer.invoke(CH.cliModelTest, req),
  dirPick: (opts?: { create?: boolean }) => ipcRenderer.invoke(CH.dirPick, opts),
  pasteFiles: (): Promise<string[]> => ipcRenderer.invoke(CH.pasteFiles),
  bridgeInfo: () => ipcRenderer.invoke(CH.bridgeInfo),
  skillsSync: () => ipcRenderer.invoke(CH.skillsSync),
  sessionStart: (payload: {
    workDir: string
    profileId: string
    resumeSessionId?: string
    initialPrompt?: string
    noteIds?: string[]
    allowCrossDirNotes?: boolean
  }) => ipcRenderer.invoke(CH.sessionStart, payload),
  sessionList: () => ipcRenderer.invoke(CH.sessionList),
  historyList: () => ipcRenderer.invoke(CH.historyList),
  historyDelete: (sessionId: string) => ipcRenderer.invoke(CH.historyDelete, sessionId),
  sessionDiscover: (req: DiscoverReq) => ipcRenderer.invoke(CH.sessionDiscover, req),
  transcriptRead: (req: TranscriptReq) => ipcRenderer.invoke(CH.transcriptRead, req),
  termWrite: (id: string, data: string) => ipcRenderer.send(CH.termWrite, { id, data }),
  termResize: (id: string, cols: number, rows: number) =>
    ipcRenderer.send(CH.termResize, { id, cols, rows }),
  termKill: (id: string) => ipcRenderer.send(CH.termKill, { id }),
  termRestart: (id: string) => ipcRenderer.invoke(CH.termRestart, { id }),
  childResume: (sessionId, termId) => ipcRenderer.invoke(CH.childResume, { sessionId, termId }),
  termRetryPrompt: (id: string) => ipcRenderer.send(CH.termRetryPrompt, { id }),
  termAttach: (id: string) => ipcRenderer.invoke(CH.termAttach, id),
  termDetach: (id: string) => ipcRenderer.send(CH.termDetach, { id }),
  onSessionsChanged: (cb) => subscribe<SessionSummary[]>(CH.sessionsChanged, cb),
  onHistoryChanged: (cb) => subscribe<HistoryRecord[]>(CH.historyChanged, cb),
  showTermMenu: (payload: { id: string; hasSelection: boolean }) =>
    ipcRenderer.send(CH.termMenu, payload),
  onTermMenuAction: (cb) => subscribe<{ id: string; action: TermMenuAction; workDir?: string }>(CH.termMenuAction, cb),
  onTermData: (cb) => subscribe<{ id: string; data: string }>(CH.termData, cb),
  onTermExit: (cb) => subscribe<{ id: string }>(CH.termExit, cb),
  notesList: (): Promise<Note[]> => ipcRenderer.invoke(CH.notesList),
  notesAdd: (payload: { workDir: string; kind: NoteKind; content: string; title?: string }): Promise<Note> =>
    ipcRenderer.invoke(CH.notesAdd, payload),
  notesUpdate: (payload: { id: string; title?: string; content?: string; status?: NoteStatus }): Promise<void> =>
    ipcRenderer.invoke(CH.notesUpdate, payload),
  notesRemove: (id: string): Promise<void> => ipcRenderer.invoke(CH.notesRemove, id),
  notesClear: (payload?: { workDir?: string }): Promise<void> => ipcRenderer.invoke(CH.notesClear, payload),
  onNotesChanged: (cb) => subscribe<Note[]>(CH.notesChanged, cb),
  notesSelection: (payload) => ipcRenderer.send(CH.notesSelection, payload),
  onNotesCaptureState: (cb) => subscribe<boolean>(CH.notesCaptureState, cb),
  notesAsset: (payload: { noteId: string }): Promise<NoteAssetResult> =>
    ipcRenderer.invoke(CH.notesAsset, payload),
  notesSaveImage: (): Promise<string | null> => ipcRenderer.invoke(CH.notesSaveImage),
  notesPaste: (): Promise<ClipboardPayload> => ipcRenderer.invoke(CH.notesPaste),
  notesOpenFile: (payload: { noteId: string; reveal?: boolean }): Promise<void> =>
    ipcRenderer.invoke(CH.notesOpenFile, payload),
  notesCleanupAssets: (payload: { dryRun: boolean }): Promise<{ removed: number; bytes: number }> =>
    ipcRenderer.invoke(CH.notesCleanupAssets, payload),
  pathResolve: (payload: { workDir: string; path: string }): Promise<string> =>
    ipcRenderer.invoke(CH.pathResolve, payload),
  // 拖入文件取本地路径：这是渲染进程能力（不是 IPC），且必须在 preload 里调 ——
  // 渲染层 contextIsolation 下拿不到 webUtils。非本地文件（网页拖来的）返回空串。
  getPathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },
  outputList: (sessionId: string) => ipcRenderer.invoke(CH.outputList, sessionId),
  outputRead: (req: { sessionId: string; artifactId: string }) => ipcRenderer.invoke(CH.outputRead, req),
  outputAsset: (req: { sessionId: string; artifactId: string; src: string }) =>
    ipcRenderer.invoke(CH.outputAsset, req),
  outputReveal: (req: { sessionId: string; artifactId: string }) => ipcRenderer.invoke(CH.outputReveal, req),
  onOutputsChanged: (cb) => subscribe<{ sessionId: string; bundles: OutputBundle[] }>(CH.outputsChanged, cb),
  externalOpen: (url: string) => ipcRenderer.invoke(CH.externalOpen, url),
  updateState: (): Promise<UpdateState> => ipcRenderer.invoke(CH.updateState),
  updateCheck: (): Promise<UpdateState> => ipcRenderer.invoke(CH.updateCheck),
  updateDownload: (): Promise<UpdateState> => ipcRenderer.invoke(CH.updateDownload),
  updateInstall: (): Promise<void> => ipcRenderer.invoke(CH.updateInstall),
  updateDismiss: (version: string): Promise<void> => ipcRenderer.invoke(CH.updateDismiss, version),
  onUpdateChanged: (cb) => subscribe<UpdateState>(CH.updateChanged, cb),
  gitBranch: (workDir: string) => ipcRenderer.invoke(CH.gitBranch, workDir),
  gitChangesList: (workDir: string): Promise<ChangeFile[]> => ipcRenderer.invoke(CH.gitChangesList, workDir),
  gitDiff: (req: { workDir: string; path: string; origPath?: string }): Promise<GitDiffResult> =>
    ipcRenderer.invoke(CH.gitDiff, req),
  gitReveal: (req: { workDir: string; path: string }): Promise<void> =>
    ipcRenderer.invoke(CH.gitReveal, req),
  onGitChanges: (cb) => subscribe<{ workDir: string; files: ChangeFile[] }>(CH.gitChanges, cb),
  termOpenShell: (workDir: string, kind?: TerminalKind) =>
    ipcRenderer.invoke(CH.termOpenShell, { workDir, kind }),
  termOpenExternal: (id: string) => ipcRenderer.invoke(CH.termOpenExternal, { id }),
  setTitleBarTheme: (payload: { color: string; symbolColor: string }) =>
    ipcRenderer.send(CH.titleBarTheme, payload),
  handoffWrite: (payload: { name: string; text: string }) =>
    ipcRenderer.invoke(CH.handoffWrite, payload)
}

contextBridge.exposeInMainWorld('clichilds', api)

export type { CliStatus }
