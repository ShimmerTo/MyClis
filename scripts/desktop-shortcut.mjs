/**
 * 打包后把桌面上的 myclis-portable.lnk 指向 release 里最新的便携版 exe。
 * 便携版产物名带版本号（myclis-portable-<版本>.exe），每次打包都会变，所以快捷方式必须每次重建，
 * 否则双击到的是上一版、甚至是被 clean-release 删掉的旧文件。
 *
 * 与安装版互不干扰：NSIS 自己在桌面建的是 myclis.lnk（electron-builder.yml 的 createDesktopShortcut），
 * 这里只用 myclis-portable.lnk 这个名字，不碰安装版建的快捷方式。
 *
 * 全程失败都只警告不中断 —— 挂在本脚本前面的打包已经产出安装包了，快捷方式建不出来不该让 dist 报红。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** 桌面快捷方式名（不带 .lnk），刻意与安装版的 myclis 区分开 */
const SHORTCUT_NAME = 'myclis-portable'

const root = process.cwd()
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
const builderYml = readFileSync(join(root, 'electron-builder.yml'), 'utf8')
const productName = /^productName:\s*(\S+)\s*$/m.exec(builderYml)?.[1]
if (!productName) {
  console.warn('[desktop-shortcut] 读不到 electron-builder.yml 里的 productName，跳过')
  process.exit(0)
}

const releaseDir = join(root, 'release')
let entries = []
try {
  entries = readdirSync(releaseDir)
} catch {
  console.warn('[desktop-shortcut] 没有 release 目录，跳过')
  process.exit(0)
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const portable = new RegExp(`^${escapeRe(productName)}-portable-(\\d+)\\.(\\d+)\\.(\\d+)\\.exe$`, 'i')

// 正常情况下 clean-release 已经把旧版本删干净、只剩当前版本；
// 万一它没跑（或跑失败），这里按版本号最大挑，不能随手取 readdir 的第一个。
let best = null
for (const name of entries) {
  const m = portable.exec(name)
  if (!m) continue
  const key = [m[1], m[2], m[3]].map((n) => String(Number(n)).padStart(10, '0')).join('')
  if (!best || key > best.key) best = { key, name }
}

if (!best) {
  console.warn(`[desktop-shortcut] release 里没有 ${productName}-portable-<版本>.exe，桌面快捷方式保持原样`)
  process.exit(0)
}
if (!best.name.includes(`-portable-${version}.`)) {
  console.warn(`[desktop-shortcut] 没找到当前版本 ${version} 的便携版，只能指向 ${best.name}`)
}

const target = join(releaseDir, best.name)

// 路径通过环境变量交给 PowerShell，避免把带空格 / 引号的路径拼进 -Command 字符串
const ps = [
  "$ErrorActionPreference = 'Stop'",
  "$desktop = [Environment]::GetFolderPath('Desktop')",
  "if ([string]::IsNullOrWhiteSpace($desktop)) { throw '拿不到桌面目录' }",
  '$lnk = Join-Path $desktop ($env:MYCLIS_LNK_NAME + ".lnk")',
  '$shell = New-Object -ComObject WScript.Shell',
  '$sc = $shell.CreateShortcut($lnk)',
  '$sc.TargetPath = $env:MYCLIS_LNK_TARGET',
  '$sc.WorkingDirectory = $env:MYCLIS_LNK_WORKDIR',
  '$sc.IconLocation = $env:MYCLIS_LNK_TARGET + ",0"',
  '$sc.Description = "myclis 便携版（最新一次打包）"',
  '$sc.Save()',
  'Write-Output $lnk'
].join('; ')

try {
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      MYCLIS_LNK_NAME: SHORTCUT_NAME,
      MYCLIS_LNK_TARGET: target,
      MYCLIS_LNK_WORKDIR: releaseDir
    }
  })
  console.log(`[desktop-shortcut] 桌面快捷方式 ${SHORTCUT_NAME}.lnk → ${best.name}`)
} catch (e) {
  console.warn(`[desktop-shortcut] 创建桌面快捷方式失败：${String(e.stderr || e.message).trim()}`)
}
