import type { ChatMessage, ChatRole } from '../shared/types'
import { broadcast } from './context'

let seq = 1
const messages: ChatMessage[] = []

/** Adds a line to the visible chat log and pushes it to every window. */
export function pushMessage(role: ChatRole, text: string): ChatMessage {
  const m: ChatMessage = { id: seq++, role, text, time: Date.now() }
  messages.push(m)
  if (messages.length > 200) messages.shift()
  broadcast('chat:message', m)
  return m
}

export function getHistory(): ChatMessage[] {
  return messages
}
