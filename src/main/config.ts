import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AppConfig } from '../shared/types'

export const DEFAULTS: AppConfig = {
  gemini: {
    model: 'gemini-2.5-flash',
    systemPrompt:
      'Ты — {name}, голосовой компаньон на рабочем столе Windows. Отвечай по-русски, дружелюбно и кратко: ' +
      '1–3 предложения. Никакого markdown, списков, ссылок и эмодзи — твой ответ озвучивается вслух. ' +
      'Если для ответа нужен инструмент — вызывай его. Никогда не удаляй файлы. ' +
      'Учитывай факты о пользователе из блока памяти.'
  },
  character: { name: 'Сукуно' },
  window: { corner: 'bottom-right', width: 420, height: 620, margin: 24, hitInset: 70 },
  hotkey: 'CommandOrControl+Shift+Space',
  modelFile: 'model.vrm',
  appWhitelist: [
    { name: 'Блокнот', path: 'notepad.exe' },
    { name: 'Калькулятор', path: 'calc.exe' },
    { name: 'Проводник', path: 'explorer.exe' },
    { name: 'Paint', path: 'mspaint.exe' },
    { name: 'Командная строка', path: 'cmd.exe' },
    { name: 'Браузер Chrome', path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' },
    { name: 'Браузер Edge', path: 'msedge.exe' },
    { name: 'VS Code', path: 'code.cmd' }
  ],
  confirm: { open_app: true, open_url: true, press_keys: true },
  tts: {
    provider: 'edge',
    geminiModel: 'gemini-2.5-flash-preview-tts',
    geminiVoice: 'Kore',
    edgeVoice: 'ru-RU-SvetlanaNeural'
  },
  rvc: {
    enabled: true,
    model: 'rvc/models/voice.pth',
    index: 'rvc/models/voice.index',
    pitch: 0,
    indexRate: 0.6,
    port: 5055
  }
}

let cache: AppConfig | null = null

export function configPath(): string {
  return join(app.getAppPath(), 'config.json')
}

/** Reads config.json next to package.json, creating it with defaults when missing. */
export function loadConfig(force = false): AppConfig {
  if (cache && !force) return cache
  const file = configPath()
  try {
    if (!existsSync(file)) {
      writeFileSync(file, JSON.stringify(DEFAULTS, null, 2), 'utf8')
      cache = DEFAULTS
      return cache
    }
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<AppConfig>
    cache = {
      gemini: { ...DEFAULTS.gemini, ...(raw.gemini ?? {}) },
      character: { ...DEFAULTS.character, ...(raw.character ?? {}) },
      window: { ...DEFAULTS.window, ...(raw.window ?? {}) },
      hotkey: raw.hotkey || DEFAULTS.hotkey,
      modelFile: raw.modelFile || DEFAULTS.modelFile,
      appWhitelist: Array.isArray(raw.appWhitelist) ? raw.appWhitelist : DEFAULTS.appWhitelist,
      confirm: { ...DEFAULTS.confirm, ...(raw.confirm ?? {}) },
      tts: { ...DEFAULTS.tts, ...(raw.tts ?? {}) },
      rvc: { ...DEFAULTS.rvc, ...(raw.rvc ?? {}) }
    }
    return cache
  } catch {
    cache = DEFAULTS
    return cache
  }
}
