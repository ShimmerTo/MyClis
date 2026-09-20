import { spawn } from 'child_process'
import { mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { TerminalKind } from '../../shared/types'
import { windowsHide } from '../util'
import { resolveShell } from './shells'

export interface ExternalTarget {
  workDir: string
  shell: TerminalKind
  /** 该终端启动时键入的那行命令；纯 shell 没有 */
  command?: string
}

/**
 * 用系统原生终端窗口打开同一份东西：同一工作目录，CLI 会话还带上同一行启动命令。
 *
 * 命令不直接塞进原生 shell 的参数里 —— `start` + `-Command` 会被 cmd 与 PowerShell 各解析
 * 一遍引号，路径带空格就会散架。改成先落一个临时脚本，再让原生窗口去执行它：
 * 引号只在「写脚本」这一处按目标 shell 的语法处理。
 */
export function openNativeTerminal(target: ExternalTarget): void {
  const spec = resolveShell(target.shell)
  if (!spec) throw new Error(`终端不可用：${target.shell}（请确认已安装 Git for Windows）`)
  const script = writeScript(target)
  const args =
    target.shell === 'powershell'
      ? ['-NoExit', '-ExecutionPolicy', 'Bypass', '-File', script]
      : target.shell === 'cmd'
        ? ['/k', script]
        : ['--login', '-i', script]
  // start 会把第一个带引号的参数当成窗口标题，所以先给一个空标题再给真正的程序
  spawn('cmd.exe', ['/c', 'start', '', spec.file, ...args], {
    cwd: target.workDir,
    detached: true,
    stdio: 'ignore',
    windowsHide
  }).unref()
}

/** 按目标 shell 的语法生成临时启动脚本，返回脚本绝对路径 */
function writeScript(target: ExternalTarget): string {
  const dir = join(tmpdir(), 'clichilds-external')
  mkdirSync(dir, { recursive: true })
  const base = `open-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const command = target.command?.trim()
  let ext: string
  let lines: string[]
  let eol = '\r\n'
  if (target.shell === 'powershell') {
    ext = 'ps1'
    lines = ['chcp 65001 > $null', `Set-Location -LiteralPath '${psQuote(target.workDir)}'`, command ?? '']
  } else if (target.shell === 'cmd') {
    ext = 'cmd'
    lines = ['@echo off', 'chcp 65001 >nul', `cd /d "${target.workDir}"`, command ?? '']
  } else {
    ext = 'sh'
    // git bash 会把 Windows 路径里的 `\` 当转义吃掉；脚本也必须用 LF，CRLF 会报 $'\r'
    eol = '\n'
    lines = [
      `cd '${bashQuote(target.workDir)}'`,
      command ?? '',
      // 脚本跑完把进程换成交互式 bash，窗口留着不关
      'exec bash --login -i'
    ]
  }
  const file = join(dir, `${base}.${ext}`)
  writeFileSync(file, lines.filter((line) => line).join(eol) + eol, 'utf8')
  return file
}

function psQuote(value: string): string {
  return value.replace(/'/g, "''")
}

function bashQuote(value: string): string {
  return value.replace(/\\/g, '/').replace(/'/g, `'"'"'`)
}
