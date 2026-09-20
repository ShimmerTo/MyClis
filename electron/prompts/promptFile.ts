import { randomUUID } from 'crypto'
import { basename, join, resolve } from 'path'
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs'

/** 超过这个时长的临时文件视为上次崩溃留下的残骸，写新文件时顺手清掉 */
const STALE_MS = 24 * 60 * 60 * 1000

/**
 * 层1 投递用的临时文件：把任务正文写在工作目录内，命令行只带路径。
 * 必须落在工作目录内 —— 实测 qodercli 会拒绝读取工作区之外的文件。
 * 路径一律用正斜杠的相对路径，避开 PowerShell/CMD/Git Bash 对反斜杠的不同处理。
 */
export interface PromptFile {
  /** 相对工作目录的路径，进命令行 */
  rel: string
  /** 绝对路径，用于清理 */
  abs: string
}

/** 命令行里的单行引导语：短、无引号、无 shell 特殊字符 */
export const PROMPT_LEAD = '请先按下面引用的任务文件执行'

const SUBDIR = '.clichilds/prompts'

export function writePromptFile(workDir: string, text: string): PromptFile {
  const dir = join(resolve(workDir), SUBDIR)
  mkdirSync(dir, { recursive: true })
  sweepStale(dir)
  const abs = join(dir, `${randomUUID()}.md`)
  writeFileSync(abs, text, 'utf-8')
  return { rel: `${SUBDIR}/${basename(abs)}`, abs }
}

/**
 * 清掉上次崩溃/强杀留下的临时文件。应用退出不一定会走到终端清理，
 * 光靠 remove() 挡不住进程被杀，所以每次写新文件时按时间兜一次底。
 */
function sweepStale(dir: string): void {
  const now = Date.now()
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.md')) continue
      const file = join(dir, name)
      const age = now - statSync(file).mtimeMs
      if (age > STALE_MS) rmSync(file, { force: true })
    }
  } catch (error) {
    console.error('清理投递临时文件失败', error)
  }
}

/** 删除临时文件。投递确认后或终端结束时调用，不能把文件留在用户仓库里 */
export function removePromptFile(file?: string): void {
  if (!file) return
  try {
    rmSync(file, { force: true })
  } catch (error) {
    console.error('删除投递临时文件失败', error)
  }
}
