import type { SessionSummary } from '@shared/types'
import { PHASE_LABEL } from '../display'

interface Props {
  info: SessionSummary
  /** 画面上给这个终端起的名字（主 CLI 用档案名，子终端用「子任务 #n · 档案名」） */
  label: string
  onShowTerminal: () => void
  /** 给了就在失败态多一个「重试投递」出口：进程还活着、只是任务文本没进输入框时用 */
  onRetryPrompt?: () => void
}

/**
 * CLI 就绪前的占位：这段时间终端不挂载，xterm 拿不到启动期的命令行回显。
 * 阶段消息就地展示（含异常），失败时给一个「查看终端」出口。
 */
export default function BootOverlay({ info, label, onShowTerminal, onRetryPrompt }: Props): JSX.Element {
  const failed = info.runtime.phase === 'error'
  return (
    <div className={`term-boot${failed ? ' error' : ''}`}>
      <span className={failed ? 'term-boot-bad' : 'term-boot-spin'} />
      <span className="term-boot-title">{failed ? '启动失败' : `正在启动 ${label}`}</span>
      <span className="term-boot-msg" title={info.runtime.message}>
        {info.runtime.message ?? PHASE_LABEL[info.runtime.phase]}
      </span>
      {/* 只有「确实是粘贴没进去」才给重试：层1 是 CLI 自己提交的，重试投递没有意义 */}
      {failed && onRetryPrompt && info.runtime.deliveryAttempt !== undefined ? (
        <button onClick={onRetryPrompt} title="进程还活着、只是任务文本没进输入框时用这个：重新投递一次">
          重试投递
        </button>
      ) : null}
      {failed && (
        <button onClick={onShowTerminal} title="忽略加载层，直接看终端原始输出">
          查看终端
        </button>
      )}
    </div>
  )
}
