import { setSshUi, useSshStore } from './store'
import { sshRequestKey } from './ui'

/** 图标形状：待审批沿用页卡上那枚「文档 + 时钟」，认证用钥匙，终端用窗口。 */
export type SshBadgeKind = 'approval' | 'challenge' | 'terminal'

const GLYPH: Record<SshBadgeKind, JSX.Element> = {
  approval: (
    <>
      <path d="M7 14H3V2h7l3 3v2M9 2v4h4M5 5h1M5 8h2" />
      <circle cx="11.5" cy="11.5" r="3.5" />
      <path d="M11.5 9.5v2l1.3 1" />
    </>
  ),
  challenge: (
    <>
      <circle cx="5.5" cy="8" r="3" />
      <path d="M8.2 9.6 14 9.6M11.6 9.6v2.6M13.4 9.6v2.1" />
    </>
  ),
  terminal: (
    <>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.6" />
      <path d="M4.5 6.5l2.4 2-2.4 2M8.5 10.8h3.6" />
    </>
  )
}

/** 一枚可点击的 SSH 待办图标；count 为 0 时不渲染，避免卡片上出现空壳。 */
export function SshBadge({ kind, count, title, onClick, className }: {
  kind: SshBadgeKind
  count: number
  title: string
  onClick: () => void
  className?: string
}): JSX.Element | null {
  if (count <= 0) return null
  return (
    <button
      type="button"
      className={`ssh-badge ${className ?? ''}`}
      title={title}
      aria-label={title}
      onKeyDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation()
        onClick()
      }}
    >
      <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {GLYPH[kind]}
      </svg>
      {count > 1 && <span className="ssh-badge-count">{count}</span>}
    </button>
  )
}

/**
 * 会话卡片上的 SSH 待办：待审批按会话自己的 pty id 精确归属；
 * 认证请求与开着的终端只带项目 scopeId，只能按卡片目录认，认不出就不显示。
 */
export function SshCardBadges({ sessionId, scopeId }: { sessionId?: string; scopeId?: string | null }): JSX.Element | null {
  const { snapshot } = useSshStore()
  if (!snapshot) return null
  const approvals = snapshot.requests.filter((request) => request.sessionId === sessionId && request.state === 'pending_approval')
  const challenges = scopeId ? snapshot.challenges.filter((item) => item.scopeId === scopeId) : []
  const terminals = scopeId ? snapshot.terminals.filter((item) => item.scopeId === scopeId) : []
  if (!approvals.length && !challenges.length && !terminals.length) return null
  return (
    <span className="ssh-card-badges">
      <SshBadge
        kind="approval"
        count={approvals.length}
        title={`等你批准的命令 ${approvals.length} 条，点击处理`}
        onClick={() => setSshUi({ approvalId: sshRequestKey(approvals[0]) })}
      />
      <SshBadge
        kind="challenge"
        count={challenges.length}
        title={`等你输密码或确认指纹 ${challenges.length} 件，点击处理`}
        onClick={() => setSshUi({ challengeId: challenges[0].id })}
      />
      <SshBadge
        kind="terminal"
        count={terminals.length}
        title={`开着的终端 ${terminals.length} 个，点击显示`}
        onClick={() => setSshUi({ terminalId: terminals[0].id })}
      />
    </span>
  )
}

/**
 * 右侧栏兜底的 SSH 待办入口：认证请求与终端只带项目 scopeId，
 * 认不到会话（没关联项目，或该项目的会话已经不在列表里）时就汇到这里，避免没有出口。
 * 服务报错和操作提示也走这个入口，删掉右上角常驻按钮后它们是唯一的落点。
 */
export function SshRailTodo({ attributedScopeIds }: { attributedScopeIds: Set<string> }): JSX.Element | null {
  const { snapshot, loadError, notices } = useSshStore()
  const orphans =
    (snapshot?.challenges.filter((item) => !item.scopeId || !attributedScopeIds.has(item.scopeId)).length ?? 0) +
    (snapshot?.terminals.filter((item) => !item.scopeId || !attributedScopeIds.has(item.scopeId)).length ?? 0)
  const problems = notices.length + (loadError ? 1 : 0) + (snapshot?.error ? 1 : 0)
  if (!orphans && !problems) return null
  const title = orphans && problems ? `SSH：${orphans} 件待办，另有 ${problems} 条问题` : orphans ? `SSH：${orphans} 件待办挂不到会话，点击处理` : `SSH 有 ${problems} 条问题，点击查看`
  return (
    <button type="button" className="ssh-rail-todo" title={title} onClick={() => setSshUi({ queueOpen: true })}>
      SSH 待办 {orphans || problems}
    </button>
  )
}
