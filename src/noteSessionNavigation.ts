import { useEffect, useState } from 'react'

let target: { workspaceSessionId: string; seq: number } | null = null
let sequence = 0
export const NOTE_SESSION_EVENT = 'myclis:note-session'

export function consumeNoteSessionTarget(seq: number): void {
  if (target?.seq === seq) target = null
}

export function showNoteSession(workspaceSessionId: string): void {
  target = { workspaceSessionId, seq: ++sequence }
  window.dispatchEvent(new Event(NOTE_SESSION_EVENT))
}

export function useNoteSessionTarget(): typeof target {
  const [value, setValue] = useState(target)
  useEffect(() => {
    const update = (): void => setValue(target)
    window.addEventListener(NOTE_SESSION_EVENT, update)
    return () => window.removeEventListener(NOTE_SESSION_EVENT, update)
  }, [])
  return value
}
