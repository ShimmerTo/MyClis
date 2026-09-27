import { request } from 'node:https'
import type { UpdateInfo } from '../../shared/types'

/** 发布仓库：Release 页面与检测接口同源 */
export const UPDATE_OWNER = 'ShimmerTo'
export const UPDATE_REPO = 'MyClis'
export const RELEASE_PAGE_URL = `https://github.com/${UPDATE_OWNER}/${UPDATE_REPO}/releases/latest`
const API_URL = `https://api.github.com/repos/${UPDATE_OWNER}/${UPDATE_REPO}/releases/latest`

/** GitHub API 要求带 User-Agent；不带会被 403 */
export const USER_AGENT = 'MyClis'
/** 检测请求必须短：启动时的后台检测不能拖慢进入界面 */
export const CHECK_TIMEOUT_MS = 8000

/** 只认 setup 安装包；blockmap 与便携版（若有）都不是安装源 */
const SETUP_ASSET = /^myclis-setup-[0-9][^/\\]*\.exe$/i
/** 摘要文件 <安装包名>.sha256：取第一段十六进制串，其它内容忽略 */
const DIGEST_ASSET = /^(.*\.exe)\.sha256$/i

/**
 * 解析版本号；只接受纯数字点分串，最多 4 段。
 * 拿不到可信版本号时返回 null —— 宁可提示「没有新版」，也不能把不可比较的字符串当版本用。
 */
export function parseVersion(value: string): number[] | null {
  const text = typeof value === 'string' ? value.trim().replace(/^[vV]/, '') : ''
  if (!/^\d+(?:\.\d+){0,3}$/.test(text)) return null
  return text.split('.').map((part) => Number(part))
}

/** 版本比较：a > b 返回正数，相等返回 0 */
export function compareVersion(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) return 0
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

type ReleaseAsset = { name?: unknown; browser_download_url?: unknown; size?: unknown }
type ReleasePayload = { tag_name?: unknown; html_url?: unknown; published_at?: unknown; body?: unknown; assets?: unknown }

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** 从发布数据里挑出要下载的安装包；没有符合的产物就不能升级 */
export function pickSetupAsset(release: ReleasePayload, version: string): { asset: ReleaseAsset; digestUrl?: string } | undefined {
  const assets = (Array.isArray(release.assets) ? release.assets : []) as ReleaseAsset[]
  const candidates = assets.filter((item) => typeof item.browser_download_url === 'string' && SETUP_ASSET.test(text(item.name)))
  if (candidates.length === 0) return undefined
  // 同名产物有���档时（如带架构后缀）优先挑文件名带版本号的那一个
  const asset = candidates.find((item) => text(item.name).includes(version)) ?? candidates[0]
  const name = text(asset.name)
  const digest = assets.find((item) => DIGEST_ASSET.test(text(item.name)) && DIGEST_ASSET.exec(text(item.name))?.[1] === name)
  const digestUrl = typeof digest?.browser_download_url === 'string' ? digest.browser_download_url : undefined
  return { asset, digestUrl }
}

/**
 * 把 GitHub 的 latest Release 归一成 UpdateInfo。
 * 版本号不可解析、低于当前版本、或没有可执行安装包时返回 null —— 这些都算「没有可用更新」。
 */
export function parseLatestRelease(raw: unknown, currentVersion: string): UpdateInfo | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const release = raw as ReleasePayload
  const version = text(release.tag_name).replace(/^[vV]/, '')
  if (!parseVersion(version) || !parseVersion(currentVersion)) return null
  if (compareVersion(version, currentVersion) <= 0) return null
  const picked = pickSetupAsset(release, version)
  if (!picked) return null
  const url = text(picked.asset.browser_download_url)
  if (!/^https:\/\//i.test(url)) return null
  const body = text(release.body)
  return {
    version,
    tag: text(release.tag_name),
    publishedAt: text(release.published_at) || undefined,
    // 正文可能很长，渲染层折叠展示；这里只做换行统一
    notes: body.replace(/\r\n/g, '\n').trim(),
    releaseUrl: /^https:\/\//i.test(text(release.html_url)) ? text(release.html_url) : RELEASE_PAGE_URL,
    asset: { name: text(picked.asset.name), url, size: number(picked.asset.size), digestUrl: picked.digestUrl }
  }
}

/** 取 GitHub 最新 Release 的原始 JSON；失败抛错，由调用方决定是提示还是静默 */
export function fetchLatestRelease(timeoutMs = CHECK_TIMEOUT_MS): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = request(API_URL, {
      method: 'GET',
      timeout: timeoutMs,
      headers: { 'user-agent': USER_AGENT, accept: 'application/vnd.github+json' }
    }, (res) => {
      const chunks: Buffer[] = []
      let length = 0
      res.on('data', (chunk: Buffer) => {
        // Release 正文理论上没有上限，这里给出 1MB 兜底，超出即失败不外溢
        if (length + chunk.length > 1024 * 1024) {
          reject(new Error('Release 数据过大'))
          res.destroy()
          return
        }
        length += chunk.length
        chunks.push(chunk)
      })
      res.on('end', () => {
        const status = res.statusCode ?? 0
        if (status !== 200) {
          reject(new Error(`检查更新失败：GitHub 返回 ${status}`))
          return
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch {
          reject(new Error('检查更新失败：返回内容不是有效 JSON'))
        }
      })
      res.on('error', reject)
    })
    req.on('timeout', () => req.destroy(new Error('检查更新超时')))
    req.on('error', reject)
    req.end()
  })
}
