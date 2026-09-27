import { useEffect, useState } from 'react'
import type { SshUiRequest } from '../../packages/ssh/src/contracts'
import { refreshSsh, sshApi, sshError, useSshAction } from './store'
import { ActionFeedback, authorizationLabel, requestLabels, sshRequestKey } from './ui'

/** 按需查询有限结果；快照从不携带完整输出，不自动重新执行。 */
export function SshRequestResult({ request }: { request: Omit<SshUiRequest, 'result'> }): JSX.Element {
  const [detail, setDetail] = useState<SshUiRequest>()
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  const [confirmCancel, setConfirmCancel] = useState(false)
  const action = useSshAction()
  const identity = sshRequestKey(request)
  useEffect(() => {
    let alive = true
    setDetail(undefined)
    setError('')
    void sshApi().requestInspect({ sessionId: request.sessionId, requestId: request.requestId })
      .then((value) => { if (alive) setDetail(value) })
      .catch((cause: unknown) => { if (alive) setError(sshError(cause)) })
    return () => { alive = false }
  }, [identity, request.state, reload, request.sessionId, request.requestId])
  const result = detail?.state === request.state ? detail.result : undefined
  const cancellable = request.state === 'pending_approval' || request.state === 'ready' || request.state === 'executing'
  return <div className="ssh-result">
    <p><strong>{requestLabels[request.state]}</strong> · {authorizationLabel(request)}</p>
    {(request.state === 'unknown' || request.state === 'timed_out') && <p className="ssh-warning">命令可能已经执行，甚至还在服务器上跑着。别当成没执行，也别直接重发，先用只读方式确认一下。</p>}
    {request.error && <p className="ssh-error">{request.error.message}（{request.error.code}）</p>}
    {error && <p className="ssh-error" role="alert">{error}</p>}
    {!detail && !error && <p>正在读取结果…</p>}
    {result ? <>
      <p>退出码：{result.exitCode ?? '未知'} · 耗时：{result.durationMs} ms{result.truncated ? ' · 输出过长，已截断' : ''}</p>
      <h4>输出</h4><pre tabIndex={0}>{result.stdout || '（空）'}</pre>
      <h4>错误输出</h4><pre tabIndex={0}>{result.stderr || '（空）'}</pre>
    </> : detail && <p className="ssh-muted">没有可显示的输出内容。输出只保留一段时间，重启后不再提供；这不代表命令没在服务器上执行。</p>}
    <div className="ssh-actions">
      <button type="button" onClick={() => { setReload((value) => value + 1); void refreshSsh() }}>刷新结果</button>
      {cancellable && <button type="button" disabled={action.busy} onClick={() => setConfirmCancel(true)}>取消这条</button>}
    </div>
    <ActionFeedback {...action} />
    {confirmCancel && <div className="ssh-confirm" role="group" aria-label="确认取消请求">
      <p>只取消这一个会话里的这一条。命令如果已经发出去了，取消不保证服务器上会停下来，也撤不回来。</p>
      <button type="button" onClick={() => setConfirmCancel(false)}>先不取消</button>{' '}
      <button type="button" disabled={action.busy} onClick={() => { void action.run(async () => {
        await sshApi().requestCancel({ sessionId: request.sessionId, requestId: request.requestId })
        await refreshSsh()
        setConfirmCancel(false)
        setReload((value) => value + 1)
      }, '已提交取消，以这里显示的状态为准。') }}>确认取消</button>
    </div>}
  </div>
}
