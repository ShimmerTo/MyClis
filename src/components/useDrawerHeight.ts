import { useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'

/**
 * 底部抽屉高度。拖动中只改本地状态（每帧写配置会拖慢拖拽），松手时才把最终值交出去落盘。
 * 初值来自配置，窗口比上次小的时候先按当前窗口的上限夹紧，避免一打开就顶掉整个终端区。
 */
export function useDrawerHeight(
  saved: number,
  min: number,
  maxRatio: number,
  onCommit: (height: number) => void
): { height: number; resize: (event: ReactPointerEvent<HTMLDivElement>) => void } {
  const clamp = (v: number): number => Math.max(min, Math.min(window.innerHeight * maxRatio, v))
  const [height, setHeight] = useState(() => Math.round(clamp(saved)))

  const resize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const startY = event.clientY
    const start = height
    let latest = start
    const move = (e: PointerEvent): void => {
      latest = clamp(start + startY - e.clientY)
      setHeight(latest)
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      onCommit(Math.round(latest))
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up, { once: true })
  }

  return { height, resize }
}
