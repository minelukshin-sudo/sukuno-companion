import './style.css'
import { AudioPlayer } from './playback'
import type { VoiceProvider } from '../../shared/types'

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

const apiKey = $<HTMLInputElement>('apiKey')
const model = $<HTMLInputElement>('model')
const characterName = $<HTMLInputElement>('characterName')
const systemPrompt = $<HTMLTextAreaElement>('systemPrompt')
const microphone = $<HTMLSelectElement>('microphone')
const hotkey = $<HTMLInputElement>('hotkey')
const refreshMics = $<HTMLButtonElement>('refreshMics')
const save = $<HTMLButtonElement>('save')
const saveStatus = $<HTMLSpanElement>('saveStatus')
const test = $<HTMLButtonElement>('test')
const testResult = $<HTMLElement>('testResult')
const voiceProvider = $<HTMLSelectElement>('voiceProvider')
const ttsVoice = $<HTMLInputElement>('ttsVoice')
const ttsModel = $<HTMLInputElement>('ttsModel')
const ttsVoiceHint = $<HTMLElement>('ttsVoiceHint')
const testVoice = $<HTMLButtonElement>('testVoice')
const stopVoice = $<HTMLButtonElement>('stopVoice')
const voiceResult = $<HTMLElement>('voiceResult')
const useRvc = $<HTMLSelectElement>('useRvc')
const rvcModel = $<HTMLInputElement>('rvcModel')
const rvcIndex = $<HTMLInputElement>('rvcIndex')
const rvcPitch = $<HTMLInputElement>('rvcPitch')
const rvcIndexRate = $<HTMLInputElement>('rvcIndexRate')
const rvcPort = $<HTMLInputElement>('rvcPort')
const rvcStatus = $<HTMLElement>('rvcStatus')
const rvcRestart = $<HTMLButtonElement>('rvcRestart')
const rvcError = $<HTMLElement>('rvcError')
const player = new AudioPlayer()

const VOICE_HINTS: Record<VoiceProvider, string> = {
  edge: 'Например ru-RU-SvetlanaNeural (женский) или ru-RU-DmitryNeural (мужской). Пусто — берётся значение из config.json.',
  gemini: 'Предустановленные голоса Gemini, например Kore, Puck, Charon, Aoede. Пусто — берётся значение из config.json.',
  system: 'Системный голос Windows выбирается автоматически, имя не используется.'
}

function setStatus(text: string, kind: 'ok' | 'error' | 'none' = 'none'): void {
  saveStatus.textContent = text
  saveStatus.className = kind === 'none' ? '' : kind
}

function fillMicrophones(withPermission: boolean): Promise<void> {
  return (async () => {
    const current = microphone.value
    try {
      if (withPermission) {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        stream.getTracks().forEach((track) => track.stop())
      }
      const devices = await navigator.mediaDevices.enumerateDevices()
      const inputs = devices.filter((d) => d.kind === 'audioinput')
      microphone.innerHTML = ''
      const auto = document.createElement('option')
      auto.value = ''
      auto.textContent = 'Системный по умолчанию'
      microphone.appendChild(auto)
      inputs.forEach((device, index) => {
        const option = document.createElement('option')
        option.value = device.deviceId
        option.textContent = device.label || `Микрофон ${index + 1}`
        microphone.appendChild(option)
      })
      const ids = Array.from(microphone.options).map((o) => o.value)
      microphone.value = ids.includes(current) ? current : ''
    } catch {
      setStatus('Не удалось получить список микрофонов', 'error')
    }
  })()
}

function readAccelerator(event: KeyboardEvent): string | null {
  const parts: string[] = []
  if (event.ctrlKey) parts.push('CommandOrControl')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')
  if (event.metaKey) parts.push('Super')
  const code = event.code
  let key = ''
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3)
  else if (/^Digit[0-9]$/.test(code)) key = code.slice(5)
  else if (/^F[0-9]{1,2}$/.test(code)) key = code
  else if (code === 'Space') key = 'Space'
  else if (code.startsWith('Arrow')) key = code.slice(5)
  else if (code === 'Escape' || code === 'ShiftLeft' || code === 'ShiftRight') return null
  else if (code.startsWith('Control') || code.startsWith('Alt') || code.startsWith('Meta')) return null
  else if (event.key.length === 1) key = event.key.toUpperCase()
  if (!key || !parts.length) return null
  parts.push(key)
  return parts.join('+')
}

hotkey.addEventListener('keydown', (event) => {
  event.preventDefault()
  const accelerator = readAccelerator(event)
  if (accelerator) hotkey.value = accelerator
})

hotkey.addEventListener('focus', () => setStatus('Нажмите сочетание клавиш…'))

refreshMics.addEventListener('click', () => void fillMicrophones(true))

test.addEventListener('click', async () => {
  test.disabled = true
  testResult.className = ''
  testResult.textContent = 'Проверяю ключ и связь с Gemini…'
  const result = await window.api.testConnection()
  test.disabled = false
  if (result.ok) {
    testResult.className = 'ok'
    testResult.textContent =
      `Ключ работает. Доступные модели: ${result.models.slice(0, 15).join(', ')}` +
      (result.models.length > 15 ? ' …' : '')
  } else {
    testResult.className = 'error'
    testResult.textContent = result.error ?? 'Не удалось подключиться.'
  }
})

function currentPatch(): Parameters<typeof window.api.saveSettings>[0] {
  const typedKey = apiKey.value.trim()
  const patch = {
    model: model.value.trim(),
    characterName: characterName.value.trim(),
    systemPrompt: systemPrompt.value.trim(),
    microphone: microphone.value,
    hotkey: hotkey.value.trim(),
    voiceProvider: voiceProvider.value as VoiceProvider,
    ttsVoice: ttsVoice.value.trim(),
    ttsModel: ttsModel.value.trim(),
    useRvc: useRvc.value === 'on',
    rvcModel: rvcModel.value.trim(),
    rvcIndex: rvcIndex.value.trim(),
    rvcPitch: Number(rvcPitch.value) || 0,
    rvcIndexRate: Number(rvcIndexRate.value) || 0,
    rvcPort: Number(rvcPort.value) || 5055
  }
  return typedKey ? { ...patch, apiKey: typedKey } : patch
}

const RVC_STATE_TEXT: Record<string, string> = {
  off: 'RVC выключен.',
  starting: 'Сервер RVC запускается и грузит модель (это занимает ~35 секунд)...',
  ready: 'RVC готов',
  error: 'Сервер RVC не работает'
}

async function refreshRvcStatus(): Promise<void> {
  const status = await window.api.rvcStatus()
  rvcStatus.textContent =
    `${RVC_STATE_TEXT[status.state] ?? status.state}` +
    (status.state === 'ready' ? `: ${status.model} на ${status.device}${status.index ? `, индекс ${status.index}` : ''}` : '')
  rvcError.textContent = status.error || ''
}

rvcRestart.addEventListener('click', async () => {
  rvcRestart.disabled = true
  rvcStatus.textContent = 'Перезапускаю сервер RVC...'
  rvcError.textContent = ''
  const status = await window.api.rvcRestart()
  rvcRestart.disabled = false
  rvcStatus.textContent = `${RVC_STATE_TEXT[status.state] ?? status.state}`
  rvcError.textContent = status.error || ''
})

setInterval(() => void refreshRvcStatus(), 3000)

function updateVoiceHint(): void {
  const provider = voiceProvider.value as VoiceProvider
  ttsVoiceHint.textContent = VOICE_HINTS[provider]
  ttsVoice.disabled = provider === 'system'
  ttsModel.disabled = provider !== 'gemini'
}

voiceProvider.addEventListener('change', updateVoiceHint)

testVoice.addEventListener('click', async () => {
  testVoice.disabled = true
  voiceResult.className = ''
  voiceResult.textContent = 'Сохраняю и проверяю голос…'
  const saved = await window.api.saveSettings(currentPatch())
  apiKey.value = ''
  if (!saved.ok) {
    testVoice.disabled = false
    voiceResult.className = 'error'
    voiceResult.textContent = saved.error ?? 'Не удалось сохранить настройки.'
    return
  }
  const result = await window.api.synthesize('Привет! Я Сукуно. Так я буду говорить вслух.')
  testVoice.disabled = false
  if (!result.ok) {
    voiceResult.className = 'error'
    voiceResult.textContent = `Не получилось (${result.provider}): ${result.error ?? 'неизвестная ошибка'}. Будет использован системный голос.`
    return
  }
  voiceResult.className = 'ok'
  voiceResult.textContent = `TTS ${result.provider}: ${Math.round(result.base64.length / 1024)} КБ аудио.`

  let audio = { base64: result.base64, mimeType: result.mimeType }
  if (useRvc.value === 'on') {
    voiceResult.textContent += ' Конвертирую через RVC…'
    const converted = await window.api.rvcConvert(result.base64, {
      pitch: Number(rvcPitch.value) || 0,
      indexRate: Number(rvcIndexRate.value) || 0,
      protect: 0.33
    })
    if (converted.ok) {
      audio = { base64: converted.base64, mimeType: converted.mimeType }
      voiceResult.textContent = `RVC: ${converted.seconds.toFixed(2)} с на конвертацию, ${Math.round(converted.base64.length / 1024)} КБ.`
    } else {
      voiceResult.className = 'error'
      voiceResult.textContent = `RVC не сработал: ${converted.error ?? 'ошибка'}. Играю обычный TTS.`
    }
  }

  try {
    player.stop()
    await player.play(audio.base64, audio.mimeType)
  } catch (err) {
    voiceResult.className = 'error'
    voiceResult.textContent = `Аудио получено, но не воспроизвелось: ${(err as Error).message}`
  }
})

stopVoice.addEventListener('click', () => {
  player.stop()
  voiceResult.textContent = 'Остановлено.'
  voiceResult.className = ''
})

save.addEventListener('click', async () => {
  save.disabled = true
  setStatus('Сохраняю…')
  const result = await window.api.saveSettings(currentPatch())
  save.disabled = false
  apiKey.value = ''
  if (result.ok) {
    apiKey.placeholder = 'Ключ сохранён (зашифрован). Введите новый, чтобы заменить.'
    setStatus('Сохранено', 'ok')
  } else {
    setStatus(result.error ?? 'Не удалось сохранить', 'error')
  }
})

async function init(): Promise<void> {
  const settings = await window.api.getSettings()
  model.value = settings.model
  characterName.value = settings.characterName
  systemPrompt.value = settings.systemPrompt
  hotkey.value = settings.hotkey
  voiceProvider.value = settings.voiceProvider
  ttsVoice.value = settings.ttsVoice
  ttsModel.value = settings.ttsModel
  useRvc.value = settings.useRvc ? 'on' : 'off'
  rvcModel.value = settings.rvcModel
  rvcIndex.value = settings.rvcIndex
  rvcPitch.value = String(settings.rvcPitch)
  rvcIndexRate.value = String(settings.rvcIndexRate)
  rvcPort.value = String(settings.rvcPort)
  updateVoiceHint()
  void refreshRvcStatus()
  apiKey.placeholder = settings.hasApiKey
    ? 'Ключ сохранён (зашифрован). Введите новый, чтобы заменить.'
    : 'Вставьте ключ Gemini'
  await fillMicrophones(false)
  microphone.value = settings.microphone
  if (microphone.value !== settings.microphone) microphone.value = ''
}

void init()
