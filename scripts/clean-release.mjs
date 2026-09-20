/**
 * 打包后清理 release 目录里旧版本的安装包：只留与 package.json 当前版本一致的那些。
 * 产物名前缀取自 electron-builder.yml 的 productName（不硬编码，改名后不会静默失效），
 * 只删 `myclis-setup-<版本>.exe[.blockmap]` 与 `myclis-portable-<版本>.exe` 这类文件；
 * win-unpacked 目录与 builder-*.yml 不带版本号、也不是安装包，一律不动。
 */
import { readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
const builderYml = readFileSync(join(root, 'electron-builder.yml'), 'utf8')
const productName = /^productName:\s*(\S+)\s*$/m.exec(builderYml)?.[1]
if (!productName) {
  console.error('[clean-release] 读不到 electron-builder.yml 里的 productName，跳过清理')
  process.exit(0)
}

const releaseDir = join(root, 'release')
let entries = []
try {
  entries = readdirSync(releaseDir)
} catch {
  // 还没打过包：没有 release 目录，没什么可清的
  process.exit(0)
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const artifact = new RegExp(`^${escapeRe(productName)}-(?:setup|portable)-(\\d+\\.\\d+\\.\\d+)(?:\\.exe|\\.exe\\.blockmap)$`, 'i')

let removed = 0
for (const name of entries) {
  const m = artifact.exec(name)
  if (!m || m[1] === version) continue
  const path = join(releaseDir, name)
  try {
    if (!statSync(path).isFile()) continue
    unlinkSync(path)
    removed += 1
    console.log(`[clean-release] 删除旧版本产物 ${name}`)
  } catch (e) {
    console.warn(`[clean-release] 删除 ${name} 失败：${e.message}`)
  }
}
console.log(`[clean-release] 已清理 ${removed} 个旧版本产物，保留 ${version}`)
