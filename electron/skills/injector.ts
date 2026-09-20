import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { CliAdapter } from '../cli/types'
import type { SkillFile } from './generator'

/**
 * clichilds 写到过哪些 skill 名（增删模板时同步维护）。
 * 只用来清理已废弃的残留，绝不遍历删除目录里的其它 skill——那是用户自己的。
 * 后三个是改名前的旧命令，留在名单里才会把上一代注入的文件清掉，否则会剩下一堆能调用却已失效的重复命令。
 */
const LEGACY_MANAGED = [
  'myclis-check-design',
  'myclis-code',
  'myclis-review',
  'childsdesign',
  'childscode',
  'childsreview'
]

const MANIFEST = '.myclis-managed.json'

function readManaged(dir: string): Set<string> {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, MANIFEST), 'utf-8')) as { names?: unknown }
    return new Set(Array.isArray(parsed.names) ? parsed.names.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

function writeManaged(dir: string, names: Set<string>): void {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, MANIFEST)
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify({ version: 1, names: [...names].sort() }, null, 2), 'utf-8')
  renameSync(tmp, path)
}

/** SKILL.md front-matter（skills 目录形式，qoder / codebuddy / pi 通用） */
function skillMd(f: SkillFile): string {
  return `---\nname: ${f.name}\ndescription: ${f.description.replace(/\n/g, ' ')}\n---\n\n${f.body}\n`
}

/**
 * 按适配器声明的注入目标写入 skills / 自定义命令，并清掉已废弃的同名残留。
 * skills  -> <dir>/<name>/SKILL.md
 * prompts -> <dir>/<name>.md（codex 自定义命令，自动获得 /<name> 调用）
 */
export function injectSkills(adapter: CliAdapter, files: SkillFile[]): string[] {
  const written: string[] = []
  const keep = new Set(files.map((f) => f.name))
  for (const target of adapter.skillTargets()) {
    const previous = readManaged(target.dir)
    for (const f of files) {
      const owned = previous.has(f.name) || LEGACY_MANAGED.includes(f.name)
      if (target.kind === 'skills') {
        const dir = join(target.dir, f.name)
        if (existsSync(dir) && !owned) {
          throw new Error(`命令 /${f.name} 与 ${adapter.label} 中的用户自有 skill 冲突，未覆盖：${dir}`)
        }
        mkdirSync(dir, { recursive: true })
        const p = join(dir, 'SKILL.md')
        writeFileSync(p, skillMd(f), 'utf-8')
        written.push(p)
      } else {
        mkdirSync(target.dir, { recursive: true })
        const p = join(target.dir, `${f.name}.md`)
        if (existsSync(p) && !owned) {
          throw new Error(`命令 /${f.name} 与 ${adapter.label} 中的用户自有 prompt 冲突，未覆盖：${p}`)
        }
        writeFileSync(p, f.body, 'utf-8')
        written.push(p)
      }
    }
    for (const stale of new Set([...previous, ...LEGACY_MANAGED])) {
      if (keep.has(stale)) continue
      const p = target.kind === 'skills' ? join(target.dir, stale) : join(target.dir, `${stale}.md`)
      rmSync(p, { recursive: true, force: true })
    }
    writeManaged(target.dir, keep)
  }
  return written
}
