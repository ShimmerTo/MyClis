import { useState } from 'react'
import { THEMES } from '@shared/types'
import type { AppConfig, CliId, TerminalKind, ThemeKind } from '@shared/types'
import { applyTheme, installedClis, saveConfig, useSettings } from '../store'

interface Props {
  /** 引导完成：进入启动页 */
  onDone: () => void
  /** 稍后设置：进入完整设置页 */
  onSettings: () => void
}

const SHELLS: { id: TerminalKind; label: string }[] = [
  { id: 'powershell', label: 'PowerShell' },
  { id: 'cmd', label: 'CMD' },
  { id: 'gitbash', label: 'Git Bash' }
]

/** 首次使用引导：只要「目录 + CLI + 终端」三步即可跑起来，其余稍后在设置页补 */
export default function WelcomePage({ onDone, onSettings }: Props): JSX.Element {
  const { cfg, clis, redetect, loadError } = useSettings()
  const [dir, setDir] = useState('')
  const [cli, setCli] = useState<CliId | ''>('')
  const [shell, setShell] = useState<TerminalKind | ''>('')
  const [theme, setTheme] = useState<ThemeKind | ''>('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  if (loadError) return <div className="welcome"><div className="boot"><p className="error">加载失败：{loadError}</p></div></div>
  if (!cfg) return <div className="welcome"><div className="boot">加载中…</div></div>

  const installed = installedClis(clis)
  const workDir = dir.trim()
  const configuredMain = cfg.cliConfigs.find((item) => item.id === cfg.launch.mainCliId)
  const pickCli = (cli || configuredMain?.cli || installed[0]?.id || 'qoder') as CliId
  const pickShell = shell || cfg.terminal
  const pickTheme = theme || cfg.theme
  const ready = !!workDir && installed.some((c) => c.id === pickCli)

  const pickDir = async (create: boolean): Promise<void> => {
    const p = await window.clichilds.dirPick({ create }).catch(() => null)
    if (p) setDir(p)
  }

  const changeTheme = (t: ThemeKind): void => {
    setTheme(t)
    applyTheme(t)
  }

  const finish = async (): Promise<void> => {
    if (!ready || busy) return
    setErr('')
    setBusy(true)
    try {
      const profileId = `cli-welcome-${Date.now().toString(36)}`
      await saveConfig({
        ...cfg,
        workDirs: [workDir],
        terminal: pickShell,
        theme: pickTheme,
        cliConfigs: [{ id: profileId, cli: pickCli, alias: '', model: '', permissionMode: 'default' }],
        launch: { ...cfg.launch, mainCliId: profileId }
      })
      onDone()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <div className="welcome">
      <div className="welcome-card">
        <div className="brand">
          <span className="brand-mark">M</span>
          <span className="brand-name">MyClis · 多 CLI 协同工作台</span>
        </div>
        <h1>先花 30 秒配好三件事</h1>
        <p className="sub">工作目录、主 CLI、终端类型。其他 CLI 档案稍后在设置页补充即可。</p>

        <div className="step">
          <div className="step-head">
            <span className="step-no">1</span>
            <span className="step-title">工作目录</span>
            <span className="hint">主终端在该目录运行</span>
          </div>
          <div className="row">
            <input
              placeholder="例如 D:\work\my-project"
              value={dir}
              onChange={(e) => setDir(e.target.value)}
            />
            <button onClick={() => void pickDir(false)}>浏览</button>
            <button onClick={() => void pickDir(true)} title="新建一个文件夹再选中">
              新建文件夹
            </button>
          </div>
        </div>

        <div className="step">
          <div className="step-head">
            <span className="step-no">2</span>
            <span className="step-title">主 CLI</span>
            <span className="hint">
              检测到 {installed.length}/{clis.length}
            </span>
            <span className="spacer" />
            <button className="link" onClick={() => void redetect()}>
              重新检测
            </button>
          </div>
          <div className="pick-grid">
            {clis.map((c) => (
              <button
                key={c.id}
                className={`pick-card ${pickCli === c.id && c.installed ? 'on' : ''} ${c.installed ? '' : 'missing'}`}
                disabled={!c.installed}
                onClick={() => setCli(c.id)}
                title={c.installed ? c.path : '未检测到，安装后点「重新检测」'}
              >
                <span className="pick-title">
                  <span className={`dot ${c.installed ? 'ok' : ''}`} />
                  {c.label}
                </span>
                <span className="pick-sub">{c.installed ? `已安装 · ${c.version}` : '未检测到'}</span>
              </button>
            ))}
          </div>
          {installed.length === 0 && (
            <div className="empty">本机还没检测到可用的 CLI —— 先安装 codex / qoder / codebuddy / pi 任一，再点「重新检测」。</div>
          )}
        </div>

        <div className="step">
          <div className="step-head">
            <span className="step-no">3</span>
            <span className="step-title">终端与皮肤</span>
            <span className="hint">随时可在设置页改</span>
          </div>
          <div className="row">
            <label className="field">终端</label>
            <select value={pickShell} onChange={(e) => setShell(e.target.value as TerminalKind)}>
              {SHELLS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
            <label className="field">皮肤</label>
            <select
              value={pickTheme}
              onChange={(e) => changeTheme(e.target.value as ThemeKind)}
            >
              {THEMES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="welcome-actions">
          <span className="hint">{err || (ready ? '已就绪，点击进入' : '填写工作目录并选择一个已安装的 CLI')}</span>
          <span className="spacer" />
          <button onClick={onSettings}>稍后设置</button>
          <button className="primary lg" disabled={!ready || busy} onClick={() => void finish()}>
            {busy ? '保存中…' : '完成，进入启动页 →'}
          </button>
        </div>
      </div>
    </div>
  )
}
