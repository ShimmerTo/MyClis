import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

type Listener = (message: string) => void

const listeners = new Set<Listener>()
let seq = 0

const SHOW_MS = 2200

/**
 * 应用级轻提示。terminalPool 不是 React 组件，对话详情又会从启动页打开，
 * 所以提示不能挂在工作台里，必须由一个常驻宿主统一承载。
 */
export function toast(message: string): void {
  for (const listener of listeners) listener(message)
}

/** 挂在 App 上的提示宿主（工作台分支与普通页面分支都要挂） */
export function ToastHost(): JSX.Element | null {
  const [item, setItem] = useState<{ id: number; text: string } | null>(null)

  useEffect(() => {
    let timer = 0
    const listener: Listener = (message) => {
      seq += 1
      setItem({ id: seq, text: message })
      window.clearTimeout(timer)
      timer = window.setTimeout(() => setItem(null), SHOW_MS)
    }
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
      window.clearTimeout(timer)
    }
  }, [])

  if (!item) return null
  return createPortal(
    <div className="notes-toast" role="status" key={item.id}>
      {item.text}
    </div>,
    document.body
  )
}
