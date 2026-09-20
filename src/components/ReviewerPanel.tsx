import { useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import type { SessionSummary } from '@shared/types'
import TerminalView, { TerminalStatus } from './TerminalView'
import BootOverlay from './BootOverlay'
import { shellLabel } from '../display'

interface Props {
  info: SessionSummary
  done: boolean
  resultFile?: string
  style?: CSSProperties
  onClose: (id: string) => void
  onMinimize: (id: string) => void
  /** 杀掉这个子终端并按同一任务重开一个：CLI 卡死（输入框等不到、弹窗挡住）时的出口 */
  onRestart: (id: string) => void
  /** 用系统原生终端窗口打开一份一模一样的：同目录、同 Shell，CLI 会话还带上同一行启动命令 */
  onOpenExternal: (id: string) => void
  onResizeStart?: (event: ReactPointerEvent<HTMLDivElement>, id: string) => void
}

const TASK_LABEL = { design: '方案校验', write: '代码编写', review: '代码检查' } as const

const dirBase = (p: string): string => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p

/** 右侧子终端卡片：运行中的任务 CLI 或手动开的终端 + 完成标记 */
export default function ReviewerPanel({
  info,
  done,
  resultFile,
  style,
  onClose,
  onMinimize,
  onRestart,
  onOpenExternal,
  onResizeStart
}: Props): JSX.Element {
  const [revealed, setRevealed] = useState(false)
  // CLI 就绪前不挂载 xterm：启动命令行与自动投递的回显都不进界面
  // 手动开的 shell 没有 CLI 要等，一挂载就是可用状态
  const concealed =
    info.role !== 'shell' && (info.runtime.phase === 'booting' || (info.runtime.phase === 'error' && !revealed))
  const title =
    info.role === 'shell'
      ? `${shellLabel(info.shell)} · ${dirBase(info.workDir)}`
      : (info.taskKind ? TASK_LABEL[info.taskKind] : '子任务') +
        ` #${info.index} · ` +
        (info.profileLabel ?? `${info.cli}${info.model ? ` · ${info.model}` : ''}`)
  const nativeTip =
    info.role === 'shell'
      ? `用原生 ${shellLabel(info.shell)} 窗口打开同一工作目录`
      : `用原生 ${shellLabel(info.shell)} 窗口打开一份同样的 ${info.profileLabel ?? info.cli}（同目录、同启动命令）`
  return (
    <div className={`reviewer-panel ${done ? 'done' : ''}`} style={style} data-child-id={info.id}>
      <div className="reviewer-head">
        {/* 标题放不下就截断，全称挂在 title 上，鼠标指上去看 */}
        <span className="reviewer-title" title={title}>
          {title}
        </span>
        <span className="spacer" />
        {done ? (
          <span className="ok" title={resultFile}>
            ✓ 已完成
          </span>
        ) : null}
        {/* 异常时不只给一个含混的「重试」：投递重试、重开进程、关掉，三件事分开说清楚 */}
        {info.runtime.phase === 'error' && (
          <span className="reviewer-error-actions">
            <button
              onClick={() => window.clichilds.termRetryPrompt(info.id)}
              title="进程还活着、只是任务文本没进输入框时用这个：重新投递一次"
            >
              重试投递
            </button>
            <button
              onClick={() => onRestart(info.id)}
              title="杀掉这个坏死的进程，并按同一任务重开一个新终端"
            >
              重开
            </button>
            <button
              className="danger"
              onClick={() => onClose(info.id)}
              title="关掉这个终端；主 CLI 侧该子任务会转为失败，可以用 /retry 重新拉起"
            >
              关闭
            </button>
          </span>
        )}
        {/* 三个图标按钮平时隐形，鼠标进卡片才显形（与页卡栏的 ← / ＋ / 终端 同一套做法） */}
        {info.role === 'child' && (
          <button
            className="reviewer-icon"
            onClick={() => onRestart(info.id)}
            title="重开：杀掉这个终端进程，按同一任务拉起新终端（卡死、启动失败时用）"
          >
            <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
              <path
                d="M12.9 7.2a4.9 4.9 0 1 1-1.5-3.4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
              />
              <path
                d="M13 2.6v3.1H9.9"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        )}
        <button className="reviewer-icon" onClick={() => onOpenExternal(info.id)} title={nativeTip}>
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
            <path
              d="M9.7 2.6h3.7v3.7"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M13.4 2.6 8.3 7.7"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinecap="round"
            />
            <path
              d="M13.4 9.9v2.5a1 1 0 0 1-1 1H3.6a1 1 0 0 1-1-1V3.6a1 1 0 0 1 1-1h2.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <button className="reviewer-icon" onClick={() => onMinimize(info.id)} title="最小化到顶部隐藏栏">
          —
        </button>
        <button className="reviewer-icon" onClick={() => onClose(info.id)} title="关闭">
          ✕
        </button>
      </div>
      {concealed ? (
        <BootOverlay info={info} label={title} onShowTerminal={() => setRevealed(true)} />
      ) : (
        <>
          <TerminalView termId={info.id} />
          {/* 子终端的状态栏留在卡片里：工作台最底部那条是主会话的 */}
          <TerminalStatus info={info} />
        </>
      )}
      {onResizeStart ? (
        <div className="pane-resizer child" onPointerDown={(event) => onResizeStart(event, info.id)} />
      ) : null}
    </div>
  )
}
