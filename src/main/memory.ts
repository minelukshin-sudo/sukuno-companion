import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

interface MemoryFile {
  facts: string[]
}

const MAX_FACTS = 200

function memoryFile(): string {
  return join(app.getPath('userData'), 'memory.json')
}

export function readMemory(): string[] {
  try {
    if (!existsSync(memoryFile())) return []
    const data = JSON.parse(readFileSync(memoryFile(), 'utf8')) as Partial<MemoryFile>
    return Array.isArray(data.facts) ? data.facts.filter((f) => typeof f === 'string') : []
  } catch {
    return []
  }
}

export function addFact(fact: string): string[] {
  const clean = fact.trim().slice(0, 300)
  const facts = readMemory()
  if (!clean) return facts
  if (!facts.some((f) => f.toLowerCase() === clean.toLowerCase())) facts.push(clean)
  const trimmed = facts.slice(-MAX_FACTS)
  writeFileSync(memoryFile(), JSON.stringify({ facts: trimmed }, null, 2), 'utf8')
  return trimmed
}

/** Text block appended to the system instruction. */
export function memoryBlock(): string {
  const facts = readMemory()
  if (!facts.length) return ''
  return 'Факты о пользователе (память):\n' + facts.map((f) => `- ${f}`).join('\n')
}
