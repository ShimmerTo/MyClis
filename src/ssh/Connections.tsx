import { useEffect, useRef, useState } from 'react'
import type { SshAuth, SshChallenge, SshConnectionInfo, SshProfile, SshProfileInput, SshSnapshot } from '../../packages/ssh/src/contracts'
import { dirBase } from '../notes'
import { isExpired, ModalFrame } from '../components/approval'
import { pushSshToast, refreshSsh, saveSshAction, setSshUi, sshApi, useSshAction, type SshScopeInfo } from './store'
import { GrantEditor } from './Grants'
import { ActionFeedback, authKindLabel, Field, runtimeLabel, sshTarget } from './ui'

function GearIcon(): JSX.Element {
  return <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><circle cx="8" cy="8" r="2.4" /><path d="M8 1.6v1.8M8 12.6v1.8M1.6 8h1.8M12.6 8h1.8M3.4 3.4l1.3 1.3M11.3 11.3l1.3 1.3M12.6 3.4l-1.3 1.3M4.7 11.3l-1.3 1.3" /></svg>
}
function UnlinkIcon(): JSX.Element {
  return <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M6.6 9.4L5.2 10.8a2.6 2.6 0 01-3.7-3.7l1.4-1.4" /><path d="M9.4 6.6l1.4-1.4a2.6 2.6 0 013.7 3.7l-1.4 1.4" /><path d="M4 3l8 10" /></svg>
}

/** 新建 / 编辑一台服务器的连接信息；保存只是写下来，不会去连，也不会给 AI 任何权限。 */
export function SshConnectionEditor({ profile, revision, onClose }: { profile?: SshProfile; revision: number; onClose: () => void }): JSX.Element {
  const [name, setName] = useState(profile?.name ?? '')
  const [environment, setEnvironment] = useState(profile?.environment ?? '')
  const [host, setHost] = useState(profile?.host ?? '')
  const [port, setPort] = useState(String(profile?.port ?? 22))
  const [username, setUsername] = useState(profile?.username ?? '')
  const [kind, setKind] = useState<Extract<SshAuth['kind'], 'password' | 'key'>>(profile?.auth.kind === 'key' ? 'key' : 'password')
  const [keyPath, setKeyPath] = useState(profile?.auth.kind === 'key' ? profile.auth.keyPath : '')
  const [password, setPassword] = useState(profile?.auth.kind === 'password' ? profile.auth.password ?? '' : '')
  const [expectedRevision] = useState(revision)
  const [validation, setValidation] = useState('')
  const action = useSshAction()
  function submit(): void {
    const number = Number(port)
    if (!name.trim() || !host.trim() || !username.trim() || !Number.isInteger(number) || number < 1 || number > 65535) {
      setValidation('名称、主机、用户名都要填，端口是 1–65535 的整数。')
      return
    }
    if (/[\s\x00-\x1f]/.test(host.trim()) || /[\s\x00-\x1f]/.test(username.trim())) {
      setValidation('主机和用户名里不能有空格或换行。')
      return
    }
    if (kind === 'key' && !keyPath.trim()) {
      setValidation('请先选择本机上的私钥文件。')
      return
    }
    const auth: SshAuth = kind === 'key' ? { kind: 'key', keyPath: keyPath.trim() } : { kind: 'password', ...(password.trim() ? { password: password.trim() } : {}) }
    const input: SshProfileInput = { name: name.trim(), environment: environment.trim(), host: host.trim(), port: number, username: username.trim(), auth }
    setValidation('')
    void action.run(async () => {
      await saveSshAction({ type: 'saveConnection', id: profile?.id, profile: input }, expectedRevision)
      onClose()
    })
  }
  return <ModalFrame title={profile ? '编辑连接' : '新建连接'} onClose={onClose}>
    <form className="ssh-ui" onSubmit={(event) => { event.preventDefault(); submit() }}>
      <p className="ssh-muted">手动填写服务器地址，不从 ~/.ssh/config 导入。</p>
      {profile && <p className="ssh-warning">改了主机、端口、用户名或登录方式，等于换了一台服务器：旧连接会断开，之前的审批和「不再询问」都会作废。</p>}
      <fieldset disabled={action.busy} className="ssh-form-grid">
        <Field label="名称"><input required maxLength={120} value={name} onChange={(event) => setName(event.target.value)} /></Field>
        <Field label="备注（可选）" hint="只是给自己看的标记，比如 测试 / 生产，不影响任何权限"><input maxLength={80} placeholder="测试 / 生产" value={environment} onChange={(event) => setEnvironment(event.target.value)} /></Field>
        <Field label="主机地址"><input required maxLength={255} placeholder="192.168.1.10 或 server.example.com" value={host} onChange={(event) => setHost(event.target.value)} /></Field>
        <Field label="端口"><input required type="number" min={1} max={65535} step={1} value={port} onChange={(event) => setPort(event.target.value)} /></Field>
        <Field label="用户名"><input required maxLength={128} autoComplete="off" value={username} onChange={(event) => setUsername(event.target.value)} /></Field>
        <Field label="登录方式"><select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}><option value="password">密码</option><option value="key">私钥文件</option></select></Field>
        {kind === 'key' && <div className="ssh-wide"><Field label="私钥文件" hint="这里只记路径，私钥内容和口令都不保存；口令在连接时临时输入。"><input readOnly required value={keyPath} /></Field><button type="button" onClick={() => { void action.run(async () => {
          const picked = await window.clichilds.sshPickIdentity()
          if (picked) setKeyPath(picked)
        }) }}>选择私钥文件</button></div>}
        {kind === 'password' && <div className="ssh-wide"><Field label="登录密码" hint="密码会明文保存在本机 ssh.json（和其它配置一样）。留空则回退到连接时临时输入、不保存。"><input type="password" autoComplete="new-password" spellCheck={false} value={password} onChange={(event) => setPassword(event.target.value)} /></Field></div>}
      </fieldset>
      {kind === 'password' && <p className="ssh-muted">填了密码：保存后点「测试连接」直接连，不再问密码（第一次连仍需确认服务器指纹）。留空：每次点「测试连接」临时输一遍、不保存。</p>}
      {validation && <p role="alert" className="ssh-error">{validation}</p>}
      <ActionFeedback {...action} />
      <div className="ssh-actions"><button type="button" onClick={onClose}>取消</button><button className="primary" type="submit" disabled={action.busy}>保存</button></div>
    </form>
  </ModalFrame>
}

/** 就地完成登录密码 / 私钥口令 / 服务器指纹确认，不用再去右上角的待办里找。 */
function InlineChallenge({ challenge }: { challenge: SshChallenge }): JSX.Element {
  const action = useSshAction()
  const [secret, setSecret] = useState('')
  const [verified, setVerified] = useState(false)
  const secretInput = useRef<HTMLInputElement>(null)
  function clearSecret(): void {
    setSecret('')
    if (secretInput.current) secretInput.current.value = ''
  }
  if (isExpired(challenge.expiresAt)) {
    return <p className="ssh-warning">这次认证超时了，请重新点「测试连接」。</p>
  }
  if (challenge.kind === 'host_key') {
    function decide(decision: 'trust' | 'reject'): void {
      const fingerprint = challenge.fingerprint
      if (!fingerprint) return
      void action.run(async () => {
        await sshApi().trustHostKey({ challengeId: challenge.id, fingerprint, decision })
        await refreshSsh()
      })
    }
    return <div className="ssh-inline-auth">
      <p>第一次连这台服务器，需要先确认它的指纹：<code className="ssh-fingerprint">{challenge.fingerprint || '服务没给指纹，不能信任'}</code></p>
      {challenge.previousFingerprint && <p className="ssh-warning">指纹和上次记录的不一样（上次：{challenge.previousFingerprint}）。可能是服务器重装了，也可能是中间人，请先跟服务器那边核实。</p>}
      <label className="ssh-check"><input type="checkbox" checked={verified} disabled={action.busy} onChange={(event) => setVerified(event.target.checked)} />这个指纹我核对过了</label>
      <ActionFeedback {...action} />
      <div className="ssh-actions">
        <button type="button" disabled={action.busy} onClick={() => decide('reject')}>拒绝这台服务器</button>
        <button className="primary" type="button" disabled={!verified || !challenge.fingerprint || action.busy} onClick={() => decide('trust')}>信任并继续</button>
      </div>
    </div>
  }
  function submit(): void {
    if (!secret || action.busy) return
    const temporary = secret
    clearSecret()
    void action.run(async () => {
      await sshApi().authRespond({ challengeId: challenge.id, secret: temporary })
      await refreshSsh()
    })
  }
  return <form className="ssh-inline-auth" onSubmit={(event) => { event.preventDefault(); submit() }}>
    <Field label={challenge.kind === 'passphrase' ? '私钥口令' : '登录密码'} hint="只在本次连接中使用，不写入配置、也不会发给 CLI 或模型。">
      <input ref={secretInput} type="password" autoComplete="off" spellCheck={false} value={secret} disabled={action.busy} onChange={(event) => setSecret(event.target.value)} />
    </Field>
    <ActionFeedback {...action} />
    <div className="ssh-actions">
      <button type="button" disabled={action.busy} onClick={() => { void action.run(async () => { await sshApi().disconnect(challenge.runtimeId); await refreshSsh() }) }}>取消连接</button>
      <button className="primary" type="submit" disabled={!secret || action.busy}>提交</button>
    </div>
  </form>
}

/** 一台服务器的一次实际连接：状态、待办和可用操作；scopeName 说明它是谁发起的。 */
function RuntimeRow({ runtime, snapshot, scopeName }: { runtime: SshConnectionInfo; snapshot: SshSnapshot; scopeName: string }): JSX.Element | null {
  const action = useSshAction()
  const challenge = snapshot.challenges.find((item) => item.runtimeId === runtime.id)
  const terminals = snapshot.terminals.filter((terminal) => terminal.runtimeId === runtime.id)
  const connected = runtime.state === 'connected'
  // 自己点的「测试连接」成功后不再显示「本机手动 · 已连接」这种废话行；异常状态仍然要说清楚
  const hideStatusLine = !runtime.scopeId && connected && !challenge
  if (hideStatusLine && !terminals.length) return null
  return <div className="ssh-runtime">
    {!hideStatusLine && <p><strong>{scopeName} · {runtimeLabel(runtime.state, challenge?.kind)}</strong>{runtime.error && runtime.state !== 'disconnected' && <span className="ssh-error">{runtime.error.message}（{runtime.error.code}）</span>}</p>}
    {challenge && <InlineChallenge challenge={challenge} />}
    {!connected && runtime.state !== 'disconnected' && runtime.state !== 'failed' && !challenge && (
      <button type="button" disabled={action.busy} onClick={() => { void action.run(async () => { await sshApi().disconnect(runtime.id); await refreshSsh() }, '已请求断开。已经发到服务器上执行的命令不会被撤回。') }}>断开</button>
    )}
    {connected && terminals.map((terminal, index) => <button type="button" key={terminal.id} onClick={() => setSshUi({ terminalId: terminal.id })}>打开终端 {index + 1}</button>)}
  </div>
}

/** 卡片里只列已关联的项目（状态 + 规则摘要）；勾项目、改权限都收进弹窗，避免整页铺开看不清。 */
function ProjectGrants({ profile, snapshot, dirs, scopes }: { profile: SshProfile; snapshot: SshSnapshot; dirs: string[]; scopes: Map<string, SshScopeInfo | null> }): JSX.Element {
  const action = useSshAction()
  const [picking, setPicking] = useState(false)
  const [setting, setSetting] = useState<{ scopeId: string; title: string } | null>(null)
  const [unlinking, setUnlinking] = useState<{ scopeId: string; name: string } | null>(null)
  const dirOfScope = new Map<string, string>()
  for (const [dir, info] of scopes) if (info) dirOfScope.set(info.scopeId, dir)
  const rows = snapshot.config.scopes.flatMap((scope) => {
    const grant = scope.grants.find((item) => item.connectionId === profile.id)
    if (!grant) return []
    const dir = dirOfScope.get(scope.scopeId)
    const title = dir ?? scope.label
    return [{ scope, grant, name: dirBase(title) }]
  })
  const settingScope = setting ? snapshot.config.scopes.find((scope) => scope.scopeId === setting.scopeId) : undefined
  const settingGrant = settingScope?.grants.find((item) => item.connectionId === profile.id)
  return <div className="ssh-projects">
    <div className="ssh-project-line">
      <strong>关联项目</strong>
      {rows.length
        ? <span className="ssh-muted">{rows.length} 个</span>
        : <span className="ssh-muted">还没关联；哪个项目的 AI 要用它，去勾选上</span>}
      <button type="button" onClick={() => setPicking(true)}>管理关联</button>
    </div>
    {rows.map(({ scope, grant, name }) => <div key={scope.scopeId} className="ssh-project-card">
      <span className="ssh-project-name" title={dirOfScope.get(scope.scopeId) ?? scope.label}>{name}</span>
      {grant.enabled ? <>
        {scope.defaultConnectionId === profile.id && <span className="ssh-tag">默认</span>}
        <span className="ssh-project-tools">
          <button type="button" className="ssh-icon-btn" title="权限设置" aria-label="权限设置" onClick={() => setSetting({ scopeId: scope.scopeId, title: dirOfScope.get(scope.scopeId) ?? scope.label })}><GearIcon /></button>
          <button type="button" className="ssh-icon-btn ssh-icon-btn-danger" title="解除关联" aria-label="解除关联" disabled={action.busy} onClick={() => setUnlinking({ scopeId: scope.scopeId, name })}><UnlinkIcon /></button>
        </span>
      </> : <span className="ssh-muted">已关联但未开启（AI 用不了），去「管理关联」勾上开启</span>}
    </div>)}
    <ActionFeedback {...action} />
    {picking && <ProjectPickerModal profile={profile} snapshot={snapshot} dirs={dirs} scopes={scopes} onClose={() => setPicking(false)} />}
    {unlinking && <ModalFrame title="确认解除关联" onClose={() => setUnlinking(null)}>
      <div className="ssh-ui">
        <p>服务器：<strong>{profile.name}</strong> · {profile.username}@{profile.host}:{profile.port}</p>
        <p>项目：<strong>{unlinking.name}</strong></p>
        <p className="ssh-warning">解除后：这个项目的 AI 立刻用不了这台服务器，使用权一并收回；还没执行的申请作废，已经在服务器上跑着的命令不会被撤回。之后可以重新关联。</p>
        <ActionFeedback {...action} />
        <div className="ssh-actions"><button type="button" onClick={() => setUnlinking(null)}>先不解除</button><button className="danger" type="button" disabled={action.busy} onClick={() => { void action.run(async () => {
          await saveSshAction({ type: 'removeAccess', scopeId: unlinking.scopeId, connectionId: profile.id }, snapshot.config.revision)
          setUnlinking(null)
        }, '已取消关联并收回使用权。') }}>确认解除</button></div>
      </div>
    </ModalFrame>}
    {setting && settingGrant && <ModalFrame title={`权限设置 · ${profile.name} · ${dirBase(setting.title)}`} className="ssh-grant-modal" backdropClose onClose={() => setSetting(null)}>
      <div className="ssh-ui"><GrantEditor key={`${settingGrant.connectionId}:${settingGrant.revision}`} snapshot={snapshot} grant={settingGrant} profile={profile} scopeId={setting.scopeId} scopeLabel={setting.title} /></div>
    </ModalFrame>}
  </div>
}

/** 全量项目勾选弹窗：勾上即授权；取消勾选与解除关联都要二次确认后才收回。 */
function ProjectPickerModal({ profile, snapshot, dirs, scopes, onClose }: { profile: SshProfile; snapshot: SshSnapshot; dirs: string[]; scopes: Map<string, SshScopeInfo | null>; onClose: () => void }): JSX.Element {
  const action = useSshAction()
  const [unlinking, setUnlinking] = useState<{ scopeId: string; dir: string } | null>(null)
  function link(scope: SshScopeInfo): void {
    void action.run(async () => {
      await saveSshAction({ type: 'setAccess', scopeId: scope.scopeId, scopeLabel: scope.label, connectionId: profile.id, enabled: true }, snapshot.config.revision)
    }, '已关联：这个项目的 AI 能用这台服务器；只读清单之外的命令每条都要批。')
  }
  function unlink(scopeId: string): void {
    void action.run(async () => {
      await saveSshAction({ type: 'removeAccess', scopeId, connectionId: profile.id }, snapshot.config.revision)
      setUnlinking(null)
    }, '已取消关联并收回使用权。')
  }
  return <ModalFrame title={`管理关联 · ${profile.name}`} onClose={onClose}>
    <div className="ssh-ui">
      <p className="ssh-muted">勾上 = 让该项目的 AI 使用这台服务器；取消 = 收回并解除关联（会先让你确认）。改完直接关闭本窗口。</p>
      {!dirs.length && <p>还没有可选项目：在启动页添加工作目录后再来勾选。</p>}
      {dirs.map((dir) => {
        const scope = scopes.get(dir)
        const access = scope ? snapshot.config.scopes.find((item) => item.scopeId === scope.scopeId) : undefined
        const grant = access?.grants.find((item) => item.connectionId === profile.id)
        const checked = !!grant?.enabled
        return <div key={dir} className="ssh-project-line">
          <label className="ssh-check">
            <input type="checkbox" checked={checked} disabled={action.busy || !scope} onChange={() => { if (!scope) return; if (checked) setUnlinking({ scopeId: scope.scopeId, dir }); else link(scope) }} />
            <span title={dir}>{dirBase(dir)}</span>
            {checked && <span className={grant?.commandPolicy === 'allow' ? 'ssh-tag ssh-warning' : 'ssh-tag'}>{grant?.commandPolicy === 'allow' ? '不再询问（高风险）' : '每条都问'}{access?.defaultConnectionId === profile.id ? ' · 默认' : ''}</span>}
          </label>
          {grant && !checked && <><span className="ssh-muted">已关联但未开启</span><button type="button" disabled={action.busy || !scope} onClick={() => { if (scope) setUnlinking({ scopeId: scope.scopeId, dir }) }}>解除关联</button></>}
          {!scope && <span className="ssh-muted">{scope === null ? '认不出这个目录，请确认项目还在' : '识别中…'}</span>}
        </div>
      })}
      <ActionFeedback {...action} />
      <div className="ssh-actions"><button type="button" onClick={onClose}>关闭</button></div>
      {unlinking && <ModalFrame title="确认解除关联" onClose={() => setUnlinking(null)}>
        <div className="ssh-ui">
          <p>服务器：<strong>{profile.name}</strong> · {profile.username}@{profile.host}:{profile.port}</p>
          <p>项目：<strong>{dirBase(unlinking.dir)}</strong></p>
          <p className="ssh-warning">解除后：这个项目的 AI 立刻用不了这台服务器，使用权一并收回；还没执行的申请作废，已经在服务器上跑着的命令不会被撤回。之后可以重新勾选恢复关联。</p>
          <ActionFeedback {...action} />
          <div className="ssh-actions"><button type="button" onClick={() => setUnlinking(null)}>先不解除</button><button className="danger" type="button" disabled={action.busy} onClick={() => unlink(unlinking.scopeId)}>确认解除</button></div>
        </div>
      </ModalFrame>}
    </div>
  </ModalFrame>
}

function ConnectionCard({ profile, snapshot, dirs, scopes, onEdit }: {
  profile: SshProfile; snapshot: SshSnapshot; dirs: string[]; scopes: Map<string, SshScopeInfo | null>; onEdit: () => void
}): JSX.Element {
  const action = useSshAction()
  const [deleting, setDeleting] = useState(false)
  const [testing, setTesting] = useState(false)
  const runtimes = snapshot.connections.filter((runtime) => runtime.connectionId === profile.id)
  const humanRuntimes = runtimes.filter((runtime) => !runtime.scopeId)
  const connected = humanRuntimes.find((runtime) => runtime.state === 'connected')
  const scopesWithGrant = snapshot.config.scopes.filter((scope) => scope.grants.some((grant) => grant.connectionId === profile.id))
  const terminals = snapshot.terminals.filter((terminal) => terminal.connectionId === profile.id)
  const pending = snapshot.requests.filter((request) => request.connectionId === profile.id && request.state === 'pending_approval')
  const active = snapshot.requests.filter((request) => request.connectionId === profile.id && ['ready', 'executing'].includes(request.state))
  const scopeName = (runtime: SshConnectionInfo): string => runtime.scopeId
    ? `项目 ${dirBase(scopesWithGrant.find((scope) => scope.scopeId === runtime.scopeId)?.label ?? runtime.scopeId)}`
    : '本机手动'
  // 只跟踪本次手动「测试连接」发起的连接，转成 connected/failed 时在右上角提示成功或失败，并结束按钮上的转圈。
  const watching = useRef<Set<string>>(new Set())
  const seenState = useRef<Map<string, string>>(new Map())
  const humanSig = humanRuntimes.map((runtime) => `${runtime.id}:${runtime.state}`).join('|')
  useEffect(() => {
    for (const runtime of humanRuntimes) {
      const previous = seenState.current.get(runtime.id)
      seenState.current.set(runtime.id, runtime.state)
      if (!watching.current.has(runtime.id) || previous === runtime.state) continue
      if (runtime.state === 'connected') { pushSshToast('success', `${profile.name} 连接成功`); watching.current.delete(runtime.id); setTesting(false) }
      else if (runtime.state === 'failed') { pushSshToast('error', `${profile.name} 连接失败：${runtime.error?.message ?? '连不上，请检查地址、端口和登录方式'}`); watching.current.delete(runtime.id); setTesting(false) }
      else if (runtime.state === 'disconnected') { watching.current.delete(runtime.id); setTesting(false) }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [humanSig, profile.name])
  return <article className="unit-card ssh-connection-card">
    <div className="unit-card-head"><b>{profile.name}</b><span className="ssh-tag">{profile.environment || '无备注'}</span></div>
    <p className="ssh-identity">{profile.username}@{profile.host}:{profile.port} · {authKindLabel(profile.auth)}</p>
    <ProjectGrants profile={profile} snapshot={snapshot} dirs={dirs} scopes={scopes} />
    {runtimes.map((runtime) => <RuntimeRow key={runtime.id} runtime={runtime} snapshot={snapshot} scopeName={scopeName(runtime)} />)}
    <div className="ssh-actions">
      <button type="button" onClick={onEdit}>编辑</button>
      <button className="primary" type="button" disabled={action.busy || testing} onClick={() => {
        setTesting(true)
        void action.run(async () => {
          try {
            const info = await sshApi().connect({ connectionId: profile.id })
            if (info.state === 'connected') { pushSshToast('success', `${profile.name} 连接成功`); setTesting(false) }
            else if (info.state === 'failed') { pushSshToast('error', `${profile.name} 连接失败：${info.error?.message ?? '连不上，请检查地址、端口和登录方式'}`); setTesting(false) }
            else {
              seenState.current.set(info.id, info.state)
              watching.current.add(info.id)
              // 停在等密码/等指纹这一步时转圈没有意义：先停表让用户去补认证，最终结果仍由右上角提示
              if (info.state !== 'connecting') setTesting(false)
            }
            await refreshSsh()
          } catch (cause: unknown) { setTesting(false); throw cause }
        })
      }}>{testing ? <><span className="ssh-spinner" aria-hidden="true" />连接中…</> : '测试连接'}</button>
      <button type="button" disabled={action.busy || !connected} onClick={() => { if (connected) void action.run(async () => {
        const terminal = await sshApi().terminalOpen(connected.id)
        await refreshSsh()
        setSshUi({ terminalId: terminal.id })
      }) }}>打开终端</button>
      <button type="button" disabled={action.busy} onClick={() => setDeleting(true)}>删除</button>
    </div>
    <ActionFeedback {...action} />
    {deleting && <ModalFrame title="确认删除这条连接" onClose={() => setDeleting(false)}><div className="ssh-ui">
      <p>{sshTarget(profile)}</p>
      <p className="ssh-warning">删掉之后：所有项目对它的访问授权会一起撤销，还没执行的申请作废，正在用的连接断开。已经发到服务器上执行的命令收不回来。</p>
      <p>关联项目 {scopesWithGrant.length} 个；未断开的连接 {snapshot.connections.filter((runtime) => runtime.connectionId === profile.id && !['failed', 'disconnected'].includes(runtime.state)).length} 个；终端 {terminals.length} 个；等你批准的申请 {pending.length} 条；正在执行 {active.length} 条。</p>
      <ul>{scopesWithGrant.map((scope) => <li key={scope.scopeId}>{scope.label}</li>)}</ul>
      <ActionFeedback {...action} /><div className="ssh-actions"><button type="button" onClick={() => setDeleting(false)}>留着</button><button type="button" disabled={action.busy} onClick={() => { void action.run(async () => {
        await saveSshAction({ type: 'deleteConnection', connectionId: profile.id }, snapshot.config.revision)
        setDeleting(false)
      }) }}>确认删除</button></div>
    </div></ModalFrame>}
  </article>
}

/** 连接管理与人工终端入口：一台服务器一张卡片，各自成块；「项目的 AI 能不能用」在卡片的项目勾选里。 */
export function SshConnections({ snapshot, dirs, scopes }: { snapshot: SshSnapshot; dirs: string[]; scopes: Map<string, SshScopeInfo | null> }): JSX.Element {
  const [editing, setEditing] = useState<string>()
  const [editorRevision, setEditorRevision] = useState(0)
  const profile = snapshot.config.connections.find((item) => item.id === editing)
  function openEditor(id?: string): void {
    setEditorRevision(snapshot.config.revision)
    setEditing(id ?? 'new')
  }
  return <>
    <div className="ssh-head">
      <span className="ssh-muted">{snapshot.config.connections.length} 台服务器 · 每台一张卡片</span>
      <span className="spacer" />
      <button className="primary" type="button" onClick={() => openEditor()}>新建连接</button>
    </div>
    {!snapshot.config.connections.length && <p>还没有连接。新建一条只是记下来，不会去连服务器，也不会让 AI 能用。</p>}
    <div className="ssh-connections">{snapshot.config.connections.map((item) => <ConnectionCard key={item.id} profile={item} snapshot={snapshot} dirs={dirs} scopes={scopes} onEdit={() => openEditor(item.id)} />)}</div>
    {editing && (editing === 'new' || profile) && <SshConnectionEditor key={`${editing}:${editorRevision}`} profile={profile} revision={editorRevision} onClose={() => setEditing(undefined)} />}
  </>
}
