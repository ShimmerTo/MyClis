import { readFileSync } from 'fs'
import { extname } from 'path'

/**
 * 图片相关的公共判定：输出面板（产物预览）与变更面板（改动预览）都要用同一套，
 * 否则同一个 .gif 在一个面板里能看、另一个面板里说「不支持」。
 */
export const IMAGES = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])

export function isImagePath(file: string): boolean {
  return IMAGES.has(extname(file).toLowerCase())
}

function mimeOf(file: string): string {
  const ext = extname(file).toLowerCase()
  if (ext === '.png') return 'image/png'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.gif') return 'image/gif'
  return 'image/jpeg'
}

/** 读成 data URL：渲染层不碰 file://，图片一律由主进程给字节 */
export function toDataUrl(file: string): string {
  return `data:${mimeOf(file)};base64,${readFileSync(file).toString('base64')}`
}
