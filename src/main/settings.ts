import { app, safeStorage } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AppConfig, SaveResult, Settings, SettingsPatch, VoiceProvider } from '../shared/types'
import { loadConfig } from './config'

interface Stored {
  model?: string
  characterName?: string
  systemPrompt?: string
  microphone?: string
  hotkey?: string
  voiceProvider?: VoiceProvider
  ttsVoice?: string
  ttsModel?: string
  useRvc?: boolean
  rvcModel?: string
  rvcIndex?: string
  rvcPitch?: number
  rvcIndexRate?: number
  rvcPort?: number
}

function settingsFile(): string {
  return join(app.getPath('userData'), 'settings.json')
}

// The API key never lives in settings.json: it is DPAPI-encrypted by safeStorage.
function keyFile(): string {
  return join(app.getPath('userData'), 'apikey.bin')
}

function readStored(): Stored {
  try {
    if (!existsSync(settingsFile())) return {}
    return JSON.parse(readFileSync(settingsFile(), 'utf8')) as Stored
  } catch {
    return {}
  }
}

function writeStored(data: Stored): void {
  writeFileSync(settingsFile(), JSON.stringify(data, null, 2), 'utf8')
}

export function hasApiKey(): boolean {
  return existsSync(keyFile())
}

/** Merges user settings over the defaults from config.json. Never returns the key. */
export function effectiveSettings(cfg: AppConfig = loadConfig()): Settings {
  const s = readStored()
  return {
    model: s.model || cfg.gemini.model,
    characterName: s.characterName || cfg.character.name,
    systemPrompt: s.systemPrompt || cfg.gemini.systemPrompt,
    microphone: s.microphone || '',
    hotkey: s.hotkey || cfg.hotkey,
    hasApiKey: hasApiKey(),
    voiceProvider: s.voiceProvider || cfg.tts.provider,
    ttsVoice: s.ttsVoice ?? '',
    ttsModel: s.ttsModel || cfg.tts.geminiModel,
    useRvc: s.useRvc ?? cfg.rvc.enabled,
    rvcModel: s.rvcModel || cfg.rvc.model,
    rvcIndex: s.rvcIndex || cfg.rvc.index,
    rvcPitch: typeof s.rvcPitch === 'number' ? s.rvcPitch : cfg.rvc.pitch,
    rvcIndexRate: typeof s.rvcIndexRate === 'number' ? s.rvcIndexRate : cfg.rvc.indexRate,
    rvcPort: s.rvcPort || cfg.rvc.port
  }
}

export function getApiKey(): string {
  try {
    if (!existsSync(keyFile())) return ''
    if (!safeStorage.isEncryptionAvailable()) return ''
    const buf = Buffer.from(readFileSync(keyFile(), 'utf8'), 'base64')
    return safeStorage.decryptString(buf)
  } catch {
    return ''
  }
}

export function saveSettings(patch: SettingsPatch): SaveResult {
  let error: string | undefined

  if (typeof patch.apiKey === 'string' && patch.apiKey.trim() !== '') {
    if (!safeStorage.isEncryptionAvailable()) {
      error = 'Системное шифрование (safeStorage) недоступно — ключ не сохранён.'
    } else {
      try {
        const enc = safeStorage.encryptString(patch.apiKey.trim())
        writeFileSync(keyFile(), enc.toString('base64'), { encoding: 'utf8', mode: 0o600 })
      } catch {
        error = 'Не удалось зашифровать и сохранить ключ.'
      }
    }
  }

  const stored = readStored()
  if (typeof patch.model === 'string') stored.model = patch.model.trim()
  if (typeof patch.characterName === 'string') stored.characterName = patch.characterName.trim()
  if (typeof patch.systemPrompt === 'string') stored.systemPrompt = patch.systemPrompt.trim()
  if (typeof patch.microphone === 'string') stored.microphone = patch.microphone
  if (typeof patch.hotkey === 'string') stored.hotkey = patch.hotkey.trim()
  if (patch.voiceProvider === 'gemini' || patch.voiceProvider === 'edge' || patch.voiceProvider === 'system') {
    stored.voiceProvider = patch.voiceProvider
  }
  if (typeof patch.ttsVoice === 'string') stored.ttsVoice = patch.ttsVoice.trim()
  if (typeof patch.ttsModel === 'string') stored.ttsModel = patch.ttsModel.trim()
  if (typeof patch.useRvc === 'boolean') stored.useRvc = patch.useRvc
  if (typeof patch.rvcModel === 'string') stored.rvcModel = patch.rvcModel.trim()
  if (typeof patch.rvcIndex === 'string') stored.rvcIndex = patch.rvcIndex.trim()
  if (typeof patch.rvcPitch === 'number' && Number.isFinite(patch.rvcPitch)) stored.rvcPitch = patch.rvcPitch
  if (typeof patch.rvcIndexRate === 'number' && Number.isFinite(patch.rvcIndexRate)) {
    stored.rvcIndexRate = Math.min(1, Math.max(0, patch.rvcIndexRate))
  }
  if (typeof patch.rvcPort === 'number' && Number.isFinite(patch.rvcPort)) stored.rvcPort = patch.rvcPort
  writeStored(stored)

  return { ok: !error, error, settings: effectiveSettings() }
}
