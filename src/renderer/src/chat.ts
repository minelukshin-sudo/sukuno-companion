import './style.css'
import type { ChatMessage } from '../../shared/types'

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

const log = $<HTMLDivElement>('log')
const state = $<HTMLDivElement>('state')
const input = $<HTMLInputElement>('text')
const send = $<HTMLButtonElement>('send')

function append(message: ChatMessage): void {
  const node = document.createElement('div')
  node.className = `msg ${message.role}`
  node.textContent = message.text
  log.appendChild(node)
  log.scrollTop = log.scrollHeight
}

async function submit(): Promise<void> {
  const text = input.value.trim()
  if (!text) return
  input.value = ''
  send.disabled = true
  const result = await window.api.ask(text)
  send.disabled = false
  input.focus()
  if (!result.ok) append({ id: -1, role: 'system', text: result.error ?? 'Ошибка', time: Date.now() })
}

send.addEventListener('click', () => void submit())
input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') void submit()
})

window.api.onMessage(append)
window.api.onStatus((status) => {
  state.textContent = status.text
  state.className = status.kind === 'error' ? 'error' : ''
})

void window.api.getHistory().then((history) => history.forEach(append))
input.focus()
