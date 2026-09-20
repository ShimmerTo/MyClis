/**
 * 打包前把版本号自增一位（patch）：0.1.0 → 0.1.1。
 * 只改 package.json 与 package-lock.json，不做任何 git 操作 ——
 * 版本号落在仓库里的文件上，由提交者自己决定何时 commit。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const pkgPath = join(root, 'package.json')
const lockPath = join(root, 'package-lock.json')

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const prev = pkg.version
const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(prev)
if (!m) {
  console.error(`[bump-version] package.json 的 version 不是 x.y.z 形式：${prev}`)
  process.exit(1)
}
const next = `${m[1]}.${m[2]}.${Number(m[3]) + 1}`
pkg.version = next
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)

// lock 文件里也有两处版本号，不同步会在 npm ci 时报不一致
try {
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
  lock.version = next
  if (lock.packages?.['']) lock.packages[''].version = next
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`)
} catch {
  console.warn('[bump-version] 未同步 package-lock.json')
}

console.log(`[bump-version] ${prev} → ${next}`)
