import { existsSync } from 'fs'
import { execFileSync } from 'child_process'
import { dirname, join } from 'path'
import type { TerminalKind } from '../../shared/types'
import { windowsHide } from '../util'

export interface ShellSpec {
  file: string
  args: string[]
}

function gitBashPath(): string | null {
  const guesses: string[] = []
  try {
    const git = execFileSync('where.exe', ['git'], { windowsHide, encoding: 'utf-8' })
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find((s) => s)
    if (git) {
      // ...\Git\cmd\git.exe -> ...\Git\bin\bash.exe
      guesses.push(join(dirname(dirname(git)), 'bin', 'bash.exe'))
    }
  } catch {
    /* ignore */
  }
  guesses.push('C:\\Program Files\\Git\\bin\\bash.exe')
  guesses.push('C:\\Program Files (x86)\\Git\\bin\\bash.exe')
  return guesses.find((p) => existsSync(p)) ?? null
}

/** 解析三种终端的可执行与参数；git bash 未安装返回 null */
export function resolveShell(kind: TerminalKind): ShellSpec | null {
  switch (kind) {
    case 'powershell':
      return { file: 'powershell.exe', args: ['-NoProfile'] }
    case 'cmd':
      return { file: 'cmd.exe', args: [] }
    case 'gitbash': {
      const bash = gitBashPath()
      return bash ? { file: bash, args: ['--login','-i'] } : null
    }
  }
}
