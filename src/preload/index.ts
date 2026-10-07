import { contextBridge, ipcRenderer } from 'electron'
import type {
  Api,
  AppConfig,
  AskResult,
  ChatMessage,
  ConnectionTest,
  CursorPos,
  ModelReadResult,
  ReminderEvent,
  RvcConvertResult,
  RvcParams,
  RvcStatus,
  SaveResult,
  Settings,
  SettingsPatch,
  StatusEvent,
  TtsAudio
} from '../shared/types'

function sub<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_e: Electron.IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api: Api = {
  getConfig: () => ipcRenderer.invoke('config:get') as Promise<AppConfig>,
  listModels: () => ipcRenderer.invoke('models:list') as Promise<string[]>,
  readModel: (name: string) => ipcRenderer.invoke('model:read', name) as Promise<ModelReadResult>,
  getSettings: () => ipcRenderer.invoke('settings:get') as Promise<Settings>,
  saveSettings: (patch: SettingsPatch) => ipcRenderer.invoke('settings:save', patch) as Promise<SaveResult>,
  testConnection: () => ipcRenderer.invoke('settings:test') as Promise<ConnectionTest>,
  synthesize: (text: string) => ipcRenderer.invoke('tts:synth', text) as Promise<TtsAudio>,
  ttsFallback: (reason: string, provider: string) => ipcRenderer.send('tts:fallback', { reason, provider }),
  rvcStatus: () => ipcRenderer.invoke('rvc:status') as Promise<RvcStatus>,
  rvcRestart: () => ipcRenderer.invoke('rvc:restart') as Promise<RvcStatus>,
  rvcConvert: (base64: string, params: RvcParams) =>
    ipcRenderer.invoke('rvc:convert', { base64, params }) as Promise<RvcConvertResult>,
  note: (text: string) => ipcRenderer.send('chat:note', text),
  sendVoice: (base64: string, mimeType: string) =>
    ipcRenderer.invoke('voice:send', { base64, mimeType }) as Promise<AskResult>,
  ask: (text: string) => ipcRenderer.invoke('chat:send', text) as Promise<AskResult>,
  getHistory: () => ipcRenderer.invoke('chat:history') as Promise<ChatMessage[]>,
  openChat: () => ipcRenderer.send('ui:open-chat'),
  openSettings: () => ipcRenderer.send('ui:open-settings'),
  quit: () => ipcRenderer.send('ui:quit'),
  contextMenu: () => ipcRenderer.send('ui:context-menu'),
  setDance: (on: boolean) => ipcRenderer.send('avatar:dance', on),
  setHoverCapture: (on: boolean) => ipcRenderer.send('avatar:hover', on),
  ready: () => ipcRenderer.send('renderer:ready'),

  onCursor: (cb: (p: CursorPos) => void) => sub('cursor', cb),
  onRecordToggle: (cb: () => void) => sub('ptt:toggle', cb),
  onMessage: (cb: (m: ChatMessage) => void) => sub('chat:message', cb),
  onAssistant: (cb: (text: string) => void) => sub('assistant:speak', cb),
  onReminder: (cb: (r: ReminderEvent) => void) => sub('reminder', cb),
  onStatus: (cb: (s: StatusEvent) => void) => sub('status', cb),
  onSettingsChanged: (cb: () => void) => sub('settings:changed', cb),
  onDanceCommand: (cb: (on: boolean) => void) => sub('avatar:dance-command', cb)
}

contextBridge.exposeInMainWorld('api', api)
