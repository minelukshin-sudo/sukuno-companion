// Shared types used by main, preload and renderer.

export interface AppEntry {
  name: string
  path: string
}

export type Corner = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left'

export interface AppConfig {
  gemini: { model: string; systemPrompt: string }
  character: { name: string }
  window: { corner: Corner; width: number; height: number; margin: number; hitInset: number }
  hotkey: string
  modelFile: string
  appWhitelist: AppEntry[]
  confirm: { open_app: boolean; open_url: boolean; press_keys: boolean }
  tts: { provider: VoiceProvider; geminiModel: string; geminiVoice: string; edgeVoice: string }
  rvc: { enabled: boolean; model: string; index: string; pitch: number; indexRate: number; port: number }
}

export interface Settings {
  model: string
  characterName: string
  systemPrompt: string
  /** deviceId of the microphone, '' = system default */
  microphone: string
  hotkey: string
  /** true when an encrypted key is stored next to the settings */
  hasApiKey: boolean
  voiceProvider: VoiceProvider
  /** voice name for the selected provider, '' = provider default */
  ttsVoice: string
  /** Gemini TTS model, '' = default */
  ttsModel: string
  /** RVC voice conversion on top of the TTS */
  useRvc: boolean
  rvcModel: string
  rvcIndex: string
  rvcPitch: number
  rvcIndexRate: number
  rvcPort: number
}

export type VoiceProvider = 'gemini' | 'edge' | 'system'

/** Local RVC server state, shown in the settings window. */
export interface RvcStatus {
  state: 'off' | 'starting' | 'ready' | 'error'
  device: string
  model: string
  index: string
  error: string
  port: number
}

export interface RvcParams {
  pitch: number
  indexRate: number
  protect: number
}

export interface RvcConvertResult {
  ok: boolean
  base64: string
  mimeType: string
  seconds: number
  error?: string
}

/** Synthesised speech handed from the main process to the renderer. */
export interface TtsAudio {
  ok: boolean
  provider: VoiceProvider
  mimeType: string
  base64: string
  error?: string
}

export interface SettingsPatch {
  model?: string
  characterName?: string
  systemPrompt?: string
  microphone?: string
  hotkey?: string
  /** plain key, encrypted with safeStorage before it touches the disk */
  apiKey?: string
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

export type ChatRole = 'user' | 'assistant' | 'system'

export interface ChatMessage {
  id: number
  role: ChatRole
  text: string
  time: number
}

export interface CursorPos {
  x: number
  y: number
}

export interface ReminderEvent {
  text: string
  at: number
}

export interface StatusEvent {
  text: string
  kind: 'info' | 'error' | 'ok'
}

export interface SaveResult {
  ok: boolean
  error?: string
  settings?: Settings
}

export interface AskResult {
  ok: boolean
  text: string
  error?: string
}

export interface ConnectionTest {
  ok: boolean
  models: string[]
  error?: string
}

export interface VoicePayload {
  base64: string
  mimeType: string
}

/** Result of reading a .vrm file in the main process and shipping it to the renderer. */
export interface ModelReadResult {
  ok: boolean
  /** absolute path that was attempted, always filled in so errors can show it */
  path: string
  error?: string
  data?: ArrayBuffer
}

/** Surface of `window.api` (implemented in the preload script). */
export interface Api {
  getConfig(): Promise<AppConfig>
  listModels(): Promise<string[]>
  readModel(name: string): Promise<ModelReadResult>
  getSettings(): Promise<Settings>
  saveSettings(patch: SettingsPatch): Promise<SaveResult>
  testConnection(): Promise<ConnectionTest>
  /** asks the main process to synthesise one sentence with the selected provider */
  synthesize(text: string): Promise<TtsAudio>
  /** tells main that TTS failed so it can post a short note into the chat log */
  ttsFallback(reason: string, provider: string): void
  rvcStatus(): Promise<RvcStatus>
  rvcRestart(): Promise<RvcStatus>
  rvcConvert(base64: string, params: RvcParams): Promise<RvcConvertResult>
  /** short note from the renderer into the chat log (e.g. when RVC fell back) */
  note(text: string): void
  sendVoice(base64: string, mimeType: string): Promise<AskResult>
  ask(text: string): Promise<AskResult>
  getHistory(): Promise<ChatMessage[]>
  openChat(): void
  openSettings(): void
  quit(): void
  contextMenu(): void
  setDance(on: boolean): void
  /** renderer tells main that the cursor is over a clickable element (HUD button) */
  setHoverCapture(on: boolean): void
  /** tells main that the renderer finished its first paint */
  ready(): void

  onCursor(cb: (p: CursorPos) => void): () => void
  onRecordToggle(cb: () => void): () => void
  onMessage(cb: (m: ChatMessage) => void): () => void
  onAssistant(cb: (text: string) => void): () => void
  onReminder(cb: (r: ReminderEvent) => void): () => void
  onStatus(cb: (s: StatusEvent) => void): () => void
  onSettingsChanged(cb: () => void): () => void
  onDanceCommand(cb: (on: boolean) => void): () => void
}
