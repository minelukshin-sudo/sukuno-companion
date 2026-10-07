import { GoogleGenAI } from '@google/genai'
import type { AskResult, ConnectionTest } from '../shared/types'
import { loadConfig } from './config'
import { effectiveSettings, getApiKey } from './settings'
import { memoryBlock } from './memory'
import { pushMessage } from './chatlog'
import { runTool, toolDeclarations, type ToolContext } from './tools'
import { broadcast, toAvatar } from './context'

interface Turn {
  role: 'user' | 'model'
  parts: unknown[]
}

export interface AskInput {
  text?: string
  audio?: { base64: string; mimeType: string }
}

let turns: Turn[] = []
let busy = false

/** Drops the conversation memory kept on the Gemini side (the UI log stays). */
export function resetChat(): void {
  turns = []
}

function systemInstruction(): string {
  const cfg = loadConfig()
  const s = effectiveSettings(cfg)
  const base = (s.systemPrompt || cfg.gemini.systemPrompt).replace(/\{name\}/g, s.characterName)
  const apps = cfg.appWhitelist.map((a) => a.name).join(', ')
  return [
    base,
    '',
    `Тебя зовут ${s.characterName}.`,
    `Текущее время: ${new Date().toLocaleString('ru-RU')}.`,
    `Разрешённые приложения для open_app: ${apps}.`,
    memoryBlock()
  ]
    .filter((line) => line !== '')
    .join('\n')
}

function rawMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)) || 'Неизвестная ошибка'
}

/** Turns SDK errors into something actionable (region blocks, bad key, missing model). */
export function describeError(err: unknown, model = ''): string {
  const msg = rawMessage(err)
  if (/location is not supported|user location|country[\s\S]{0,40}not supported/i.test(msg)) {
    return (
      'Google отклонил запрос из вашего региона. Нужен VPN, через который идёт весь трафик системы ' +
      '(включая это приложение), иначе запрос уходит с российского IP.'
    )
  }
  if (/API key not valid|API_KEY_INVALID|invalid.*api.?key|unauthenticated|UNAUTHENTICATED/i.test(msg)) {
    return 'Ключ Gemini не принят. Проверьте ключ и нажмите «Проверить подключение» в настройках.'
  }
  if (/not found|NOT_FOUND|is not found|does not exist|not supported for API/i.test(msg)) {
    return (
      `Модель «${model || 'неизвестная'}» недоступна для этого ключа (часто это устаревшее имя, например gemini-1.5-*). ` +
      'Откройте Настройки → «Проверить подключение», там будет список рабочих моделей. Обычно подходит gemini-2.5-flash.'
    )
  }
  if (/PERMISSION_DENIED|permission denied|forbidden|403/i.test(msg)) {
    return `Доступ запрещён: ${msg.slice(0, 200)}`
  }
  if (/quota|RESOURCE_EXHAUSTED|rate limit|too many requests/i.test(msg)) {
    return 'Исчерпана квота или слишком много запросов. Попробуйте позже.'
  }
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|getaddrinfo|network/i.test(msg)) {
    return 'Нет связи с Gemini. Проверьте интернет и VPN (сервер generativelanguage.googleapis.com).'
  }
  return `Ошибка Gemini: ${msg.slice(0, 300)}`
}

/** Settings → "Проверить подключение": lists models the current key can actually use. */
export async function testConnection(): Promise<ConnectionTest> {
  const apiKey = getApiKey()
  if (!apiKey) return { ok: false, models: [], error: 'Ключ Gemini не сохранён.' }
  try {
    const ai = new GoogleGenAI({ apiKey })
    const pager = (await ai.models.list({ config: { pageSize: 200 } })) as unknown as AsyncIterable<{
      name?: string
      supportedActions?: string[]
    }>
    const models: string[] = []
    for await (const model of pager) {
      const name = (model.name ?? '').replace(/^models\//, '')
      if (!name) continue
      if (model.supportedActions?.length && !model.supportedActions.includes('generateContent')) continue
      if (!/gemini/i.test(name)) continue
      models.push(name)
      if (models.length >= 40) break
    }
    if (!models.length) return { ok: false, models: [], error: 'Ключ принят, но доступных моделей Gemini не найдено.' }
    return { ok: true, models }
  } catch (err) {
    console.error('[gemini] testConnection', rawMessage(err).slice(0, 300))
    return { ok: false, models: [], error: describeError(err) }
  }
}

export async function ask(input: AskInput, ctx: ToolContext): Promise<AskResult> {
  if (busy) return { ok: false, text: '', error: 'Я ещё думаю над прошлым вопросом.' }
  const cfg = loadConfig()
  const s = effectiveSettings(cfg)
  const model = s.model.replace(/^models\//, '').trim()
  const apiKey = getApiKey()
  if (!apiKey) return { ok: false, text: '', error: 'Не задан ключ Gemini. Откройте «Настройки».' }

  busy = true
  broadcast('status', { text: 'Думаю…', kind: 'info' })

  const userParts: unknown[] = []
  if (input.audio) userParts.push({ inlineData: { mimeType: input.audio.mimeType, data: input.audio.base64 } })
  if (input.text) userParts.push({ text: input.text })
  else if (input.audio) userParts.push({ text: 'Это голосовое сообщение пользователя. Пойми его и ответь вслух коротко.' })

  const contents: Turn[] = [...turns, { role: 'user', parts: userParts }]
  let answer = ''
  try {
    const ai = new GoogleGenAI({ apiKey })
    for (let step = 0; step < 6; step++) {
      const request = {
        model,
        contents,
        config: {
          systemInstruction: systemInstruction(),
          temperature: 0.9,
          tools: [{ functionDeclarations: toolDeclarations }]
        }
      }
      // The SDK typings differ between majors, so the request object stays untyped here.
      const res = (await ai.models.generateContent(request as never)) as unknown as {
        text?: string
        functionCalls?: { name: string; args?: Record<string, unknown> }[]
      }
      const calls = res.functionCalls ?? []
      const text = (res.text ?? '').trim()

      if (!calls.length) {
        answer = text
        break
      }

      contents.push({ role: 'model', parts: calls.map((c) => ({ functionCall: c })) })
      const responses: unknown[] = []
      for (const call of calls) {
        const result = await runTool(call.name, call.args ?? {}, ctx)
        responses.push({ functionResponse: { name: call.name, response: result } })
      }
      contents.push({ role: 'user', parts: responses })
      answer = text
    }

    if (!answer) answer = 'Готово.'
  } catch (err) {
    const error = describeError(err, model)
    console.error('[gemini]', rawMessage(err).slice(0, 300))
    // Show the untouched API error too: it is what actually tells region/key/model apart.
    pushMessage('system', `Gemini ответил: ${rawMessage(err).slice(0, 240)}`)
    pushMessage('system', error)
    return { ok: false, text: '', error }
  } finally {
    busy = false
    broadcast('status', { text: '', kind: 'info' })
  }

  // Keep only text in the long-term history: raw audio would burn tokens on every turn.
  turns.push({ role: 'user', parts: [{ text: input.text || '[голосовое сообщение]' }] })
  turns.push({ role: 'model', parts: [{ text: answer }] })
  while (turns.length > 24) turns.shift()

  pushMessage('assistant', answer)
  toAvatar('assistant:speak', answer)
  return { ok: true, text: answer }
}
