import { useEffect, useRef, useState } from 'react'
import type { SshChallenge, SshSnapshot, SshTerminalInfo } from '../../packages/ssh/src/contracts'
import { ApprovalHost, isExpired, formatLocalDate, ModalFrame, useApprovalClock, type ApprovalViewModel } from '../components/approval'
import { dismissSshNotice, dismissSshToast, refreshSsh, reportSshError, setSshUi, sshApi, sshError, useSshAction, useSshStore } from './store'
import { mountSshTerminal, disposeSshTerminal, reconcileSshTerminals } from './terminalPool'
import { SshRequestResult } from './Records'
import { ActionFeedback, authorizationLabel, connectionLabels, Field, requestLabels, SshStoreNotice, sshRequestKey, sshTarget } from './ui'
import './ssh.css'

function ChallengeDialog({ challenge, snapshot, onClose }: { challenge: SshChallenge; snapshot: SshSnapshot; onClose: () => void }): JSX.Element {
  const [secret, setSecret] = useState('')
  const [verified, setVerified] = useState(false)
  const secretInput = useRef<HTMLInputElement>(null)
  const action = useSshAction()
  const now = useApprovalClock()
  const profile = snapshot.config.connections.find((item) => item.id === challenge.connectionId)
  const scope = snapshot.config.scopes.find((item) => item.scopeId === challenge.scopeId)
  const live = snapshot.challenges.some((item) => item.id === challenge.id && item.runtimeId === challenge.runtimeId && item.fingerprint === challenge.fingerprint)
  const expired = isExpired(challenge.expiresAt, now)
  const valid = live && !expired && !!profile
  function clear(): void {
    setSecret('')
    if (secretInput.current) secretInput.current.value = ''
  }
  useEffect(() => {
    const input = secretInput.current
    return () => { if (input) input.value = '' }
  }, [])
  useEffect(() => { if (!valid) clear() }, [valid])
  function close(): void { clear(); onClose() }
  function submitSecret(): void {
    if (!valid || isExpired(challenge.expiresAt) || !secret || action.busy) return
    const temporary = secret
    clear()
    void action.run(async () => {
      await sshApi().authRespond({ challengeId: challenge.id, secret: temporary })
      await refreshSsh()
      onClose()
    })
  }
  function decideHost(decision: 'trust' | 'reject'): void {
    const fingerprint = challenge.fingerprint
    if (!valid || isExpired(challenge.expiresAt) || !fingerprint || (decision === 'trust' && !verified)) return
    void action.run(async () => {
      await sshApi().trustHostKey({ challengeId: challenge.id, fingerprint, decision })
      await refreshSsh()
      close()
    })
  }
  return <ModalFrame title={challenge.kind === 'host_key' ? '确认服务器指纹' : challenge.kind === 'passphrase' ? '输入私钥口令' : '输入登录密码'} onClose={close}>
    <div className="ssh-ui">
      <p>服务器：<strong>{profile ? sshTarget(profile) : '这台服务器已经被删掉了'}</strong></p>
      <p>项目：{challenge.scopeId ? scope?.label ?? `项目身份 ${challenge.scopeId}` : '没有关联项目（你自己在用 SSH）'}</p>
      <p>过期时间：{formatLocalDate(challenge.expiresAt)}</p>
      {!valid && <p role="alert" className="ssh-error">这次认证已经过期、作废或者目标没了，没法提交。请回到 SSH 页面重新点一次「测试连接」，系统不会自动重连。</p>}
      {challenge.kind === 'host_key' ? <>
        <p>算法：{challenge.algorithm || '服务没给'}</p><p className="ssh-fingerprint">完整指纹：{challenge.fingerprint || '缺少指纹，先不要信任'}</p>
        {challenge.previousFingerprint && <><p className="ssh-warning">注意：这跟之前记录的指纹不一样。可能是服务器换了机器或重装了系统，也可能是有人在中间截包。请先换个可靠渠道核实清楚。</p><p className="ssh-fingerprint">之前记录的指纹：{challenge.previousFingerprint}</p></>}
        <p>信任只表示你认得这台服务器，不等于批准 AI 执行任何命令；也不会去改你本机的 known_hosts。</p>
        <label className="ssh-check"><input type="checkbox" checked={verified} disabled={!valid || action.busy} onChange={(event) => setVerified(event.target.checked)} />这个指纹我核对过了</label>
        <ActionFeedback {...action} /><div className="ssh-actions"><button type="button" onClick={close}>先不处理</button><button type="button" disabled={!valid || action.busy || !challenge.fingerprint} onClick={() => decideHost('reject')}>拒绝这台服务器</button><button type="button" disabled={!valid || !verified || action.busy || !challenge.fingerprint} onClick={() => decideHost('trust')}>信任并继续</button></div>
      </> : <form onSubmit={(event) => { event.preventDefault(); submitSecret() }}>
        <Field label={challenge.kind === 'passphrase' ? '私钥口令' : '登录密码'} hint="只在这一台机器的这个窗口里用一下，不会存起来，也不会发给 CLI 或模型。">
          <input ref={secretInput} type="password" autoComplete="off" spellCheck={false} value={secret} disabled={!valid || action.busy} onChange={(event) => setSecret(event.target.value)} />
        </Field><ActionFeedback {...action} /><div className="ssh-actions"><button type="button" onClick={close}>先不处理（清空输入）</button><button type="button" disabled={!valid || action.busy} onClick={() => { clear(); void action.run(async () => { await sshApi().disconnect(challenge.runtimeId); await refreshSsh(); onClose() }) }}>取消连接</button><button type="submit" disabled={!valid || !secret || action.busy}>提交</button></div>
      </form>}
    </div>
  </ModalFrame>
}

function TerminalSurface({ terminalId }: { terminalId: string }): JSX.Element {
  const container = useRef<HTMLDivElement>(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!container.current) return
    try {
      setError('')
      return mountSshTerminal(terminalId, container.current)
    } catch (cause: unknown) {
      setError(sshError(cause))
    }
  }, [terminalId, attempt])
  return <>
    {error && <div role="alert" className="ssh-error">{error}<button type="button" onClick={() => setAttempt((value) => value + 1)}>重新显示终端</button></div>}
    <div className="ssh-terminal-surface" ref={container} />
  </>
}

function TerminalDialog({ terminal, snapshot, onClose }: { terminal: SshTerminalInfo; snapshot: SshSnapshot; onClose: () => void }): JSX.Element {
  const [maximized, setMaximized] = useState(false)
  const [confirmClose, setConfirmClose] = useState(false)
  const action = useSshAction()
  const profile = snapshot.config.connections.find((item) => item.id === terminal.connectionId)
  const scope = snapshot.config.scopes.find((item) => item.scopeId === terminal.scopeId)
  const runtime = snapshot.connections.find((item) => item.id === terminal.runtimeId)
  const title = `${profile ? sshTarget(profile) : '这台服务器已删除'} · ${terminal.scopeId ? scope?.label ?? terminal.scopeId : '你自己在用的终端'}`
  return <ModalFrame title={title} className={`ssh-terminal-modal ${maximized ? 'ssh-maximized' : ''}`} onClose={onClose}>
    <div className="ssh-ui ssh-terminal-layout">
      <div className="ssh-row"><strong className="ssh-warning">这是你手敲的终端，不做任何限制</strong><span>{runtime ? connectionLabels[runtime.state] : '连接已经不在了'}</span><button type="button" onClick={() => setMaximized((value) => !value)}>{maximized ? '还原' : '最大化'}</button></div>
      <p className="ssh-muted">只能打字和粘文字，图片和截图路径不会自动插进来。点「收起」只是把窗口藏起来，shell 还在远端跑着；再点出来会给你看最近的内容。</p>
      <TerminalSurface terminalId={terminal.id} />
      <ActionFeedback {...action} />
      {confirmClose && <div className="ssh-confirm"><p>关掉这个终端只是退出这个 shell，已经在服务器上跑起来的命令不会停，也不会撤销。</p><button type="button" disabled={action.busy} onClick={() => { void action.run(async () => {
        await sshApi().terminalClose(terminal.id)
        disposeSshTerminal(terminal.id)
        await refreshSsh()
        onClose()
      }) }}>确认关闭</button><button type="button" onClick={() => setConfirmClose(false)}>先留着</button></div>}
      <div className="ssh-actions"><button type="button" onClick={onClose}>收起</button><button type="button" disabled={action.busy} onClick={() => setConfirmClose(true)}>关闭这个终端</button><button type="button" disabled={action.busy} onClick={() => { void action.run(async () => {
        await sshApi().disconnect(terminal.runtimeId)
        await refreshSsh()
        onClose()
      }) }}>断开连接</button></div>
    </div>
  </ModalFrame>
}

/** 每个页面都挂一份的 SSH 宿主：命令审批卡片、后台连接的认证入口、终端窗口。 */
export function SshGlobalHost({ activeSessionId, inlineContainer }: { activeSessionId?: string; inlineContainer?: HTMLElement | null }): JSX.Element {
  const { snapshot, loadError, ui, notices, toasts } = useSshStore()
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set())
  const [errors, setErrors] = useState<Map<string, string>>(new Map())
  const locked = useRef(new Set<string>())
  const current = useRef(snapshot)
  current.current = snapshot
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    if (snapshot) reconcileSshTerminals(snapshot.terminals.map((terminal) => terminal.id))
  }, [snapshot])
  const requests = snapshot?.requests ?? []
  const challenge = snapshot?.challenges.find((item) => item.id === ui.challengeId)
  const terminal = snapshot?.terminals.find((item) => item.id === ui.terminalId)
  const views: ApprovalViewModel[] = requests.map((request) => ({
    id: sshRequestKey(request), contextKey: request.sessionId, title: 'SSH：AI 想执行一条命令',
    sourceLabel: `${request.sessionLabel} · ${authorizationLabel(request)}`,
    contextItems: [
      { label: '项目', value: request.scopeLabel },
      { label: '哪个会话', value: `${request.sessionLabel} (${request.sessionId})` },
      { label: '服务器', value: request.target },
      { label: '服务器指纹', value: request.fingerprint }
    ],
    detailText: request.command, reason: request.reason,
    warnings: ['这条命令可能改动或删掉服务器上的东西，「只给读某个目录」的限制管不住它。', '点允许只代表执行这一次。脚本、变量或者下载下来的东西还会做别的，这条命令本身没被证明是安全的。'],
    expiresAt: request.expiresAt, status: requestLabels[request.state], pending: request.state === 'pending_approval', approveLabel: '允许，只执行这一次'
  }))
  const disabledIds = new Set(busyIds)
  for (const request of requests) if (request.state === 'pending_approval' && !request.nonce) disabledIds.add(sshRequestKey(request))
  async function decide(id: string, decision: 'approve' | 'reject'): Promise<boolean> {
    // 凭据来自本次渲染的不可变请求，不从异步完成时的新选择读取。
    const original = requests.find((request) => sshRequestKey(request) === id)
    const latest = current.current?.requests.find((request) => sshRequestKey(request) === id)
    if (locked.current.has(id)) return false
    if (!original || !latest || latest.state !== 'pending_approval' || !original.nonce || original.digest !== latest.digest || original.nonce !== latest.nonce || isExpired(original.expiresAt)) {
      setErrors((previous) => new Map(previous).set(id, '这条申请已经过期或者内容变过了，不能再点。请回到原来那个会话让 AI 重新提一次，系统不会自动补发。'))
      return false
    }
    const payload = { sessionId: original.sessionId, requestId: original.requestId, digest: original.digest, nonce: original.nonce, decision }
    locked.current.add(id)
    setBusyIds(new Set(locked.current))
    setErrors((previous) => { const next = new Map(previous); next.delete(id); return next })
    try {
      await sshApi().requestDecide(payload)
      return true
    } catch (cause: unknown) {
      const message = sshError(cause)
      if (mounted.current) setErrors((previous) => new Map(previous).set(id, message))
      else reportSshError(message)
      return false
    } finally {
      locked.current.delete(id)
      if (mounted.current) setBusyIds(new Set(locked.current))
      void refreshSsh()
    }
  }
  const pendingViews = views.filter((view) => view.pending)
  const closeQueue = (): void => setSshUi({ queueOpen: false })
  return <>
    {toasts.length > 0 && <div className="ssh-toasts" role="status">
      {toasts.map((toast) => <div key={toast.id} className={`ssh-toast ssh-toast-${toast.kind}`}><span>{toast.message}</span><button type="button" onClick={() => dismissSshToast(toast.id)}>✕</button></div>)}
    </div>}
    <ApprovalHost views={views} activeContext={activeSessionId} inlineContainer={inlineContainer} detailId={ui.approvalId}
      onOpenDetail={(approvalId) => setSshUi({ approvalId })} onDecision={decide}
      busyIds={disabledIds} errors={errors} disabled={!!loadError || !!snapshot?.error}
      renderOutcome={(id) => { const request = requests.find((item) => sshRequestKey(item) === id); return request ? <SshRequestResult key={id} request={request} /> : null }} />
    {ui.queueOpen && <ModalFrame title="SSH 等你处理的事" onClose={closeQueue}><div className="ssh-ui">
      <SshStoreNotice />
      {notices.map((notice) => <div key={notice.id} className="ssh-error" role="alert">{notice.message} <button type="button" onClick={() => dismissSshNotice(notice.id)}>知道了</button></div>)}
      <h3>等你批准的命令</h3><p className="ssh-muted">这里列出各个会话发来的命令申请；不在当前会话的也能在这里批，但只表示放行这一次。</p>
      {!pendingViews.length && <p>现在没有要批的命令。</p>}
      {pendingViews.map((view) => <button className="ssh-todo" type="button" key={view.id} onClick={() => setSshUi({ approvalId: view.id })}><strong>{view.title}</strong><span>{view.sourceLabel}</span><span>{view.detailText}</span></button>)}
      <h3>等你输密码或确认指纹</h3><p className="ssh-muted">AI 发起的连接也会跑到这里来。这里不会自动帮你填密码、也不会自动信任新指纹；后台弹出来抢焦点的事同样不会发生。自己连服务器请直接在 SSH 页面点「测试连接」，输入框就在那张卡片里。</p>
      {!snapshot?.challenges.length && <p>这里没有等你处理的认证。</p>}
      {snapshot?.challenges.map((item) => {
        const profile = snapshot.config.connections.find((connection) => connection.id === item.connectionId)
        const scope = snapshot.config.scopes.find((access) => access.scopeId === item.scopeId)
        return <button className="ssh-todo" type="button" key={item.id} onClick={() => setSshUi({ challengeId: item.id })}><strong>{item.kind === 'host_key' ? '确认服务器指纹' : item.kind === 'passphrase' ? '输入私钥口令' : '输入登录密码'}</strong><span>{profile ? sshTarget(profile) : item.connectionId}</span><span>{item.scopeId ? scope?.label ?? item.scopeId : '不关联项目'} · {formatLocalDate(item.expiresAt)} 之前有效</span></button>
      })}
      <h3>开着的终端</h3>{!snapshot?.terminals.length && <p>现在没有开着的终端。要到 SSH 页面连上服务器再点「打开终端」。</p>}
      {snapshot?.terminals.map((item) => {
        const profile = snapshot.config.connections.find((connection) => connection.id === item.connectionId)
        const scope = snapshot.config.scopes.find((access) => access.scopeId === item.scopeId)
        return <button className="ssh-todo" type="button" key={item.id} onClick={() => setSshUi({ terminalId: item.id })}><span>{profile ? sshTarget(profile) : item.connectionId}</span><span>{item.scopeId ? scope?.label ?? item.scopeId : '不关联项目'} · 显示终端</span></button>
      })}
      <button type="button" onClick={() => { void refreshSsh() }}>重新读一遍 SSH 状态</button>
    </div></ModalFrame>}
    {ui.challengeId && snapshot && (challenge ? <ChallengeDialog key={challenge.id} challenge={challenge} snapshot={snapshot} onClose={() => setSshUi({ challengeId: undefined })} /> : <ModalFrame title="这次认证已经结束了" onClose={() => setSshUi({ challengeId: undefined })}><p>要么已经处理完，要么过期了，要么连接被关掉了。请回 SSH 页面看真实状态，系统不会接着跑刚才那一步。</p></ModalFrame>)}
    {ui.terminalId && snapshot && (terminal ? <TerminalDialog key={terminal.id} terminal={terminal} snapshot={snapshot} onClose={() => setSshUi({ terminalId: undefined })} /> : <ModalFrame title="终端已经关闭，或者状态还没同步" onClose={() => setSshUi({ terminalId: undefined })}><p>不会自动给你开一个新的 shell。</p><button type="button" onClick={() => { void refreshSsh() }}>重新读一遍状态</button></ModalFrame>)}
  </>
}
