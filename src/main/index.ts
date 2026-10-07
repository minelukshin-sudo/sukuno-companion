import {
  app,
  BrowserWindow,
  Menu,
  dialog,
  globalShortcut,
  ipcMain,
  screen,
  session
} from 'electron'
import { readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, join, resolve as pathResolve } from 'node:path'
import type { ModelReadResult, RvcParams, SaveResult, SettingsPatch } from '../shared/types'
import { loadConfig } from './config'
import { effectiveSettings, getApiKey, saveSettings } from './settings'
import { broadcast, modelsDir, toAvatar, win } from './context'
import { ask, resetChat, testConnection } from './brain'
import { synthesize } from './tts'
import { ensureRvcServer, rvcConvert, rvcStatus, stopRvcServer } from './rvc'
import { getHistory, pushMessage } from './chatlog'
import type { ToolContext } from './tools'

const devUrl = process.env['ELECTRON_RENDERER_URL'] ?? ''
const PRELOAD = join(__dirname, '../preload/index.js')

let cursorTimer: NodeJS.Timeout | null = null
let ignoringMouse = false
let hoverCapture = false

function loadPage(target: BrowserWindow, page: string): void {
  if (devUrl) void target.loadURL(`${devUrl}/${page}`)
  else void target.loadFile(join(__dirname, `../renderer/${page}`))
}

function cornerPosition(): { x: number; y: number; width: number; height: number } {
  const cfg = loadConfig()
  const area = screen.getPrimaryDisplay().workArea
  const { width, height, margin, corner } = cfg.window
  return {
    x: corner.includes('left') ? area.x + margin : area.x + area.width - width - margin,
    y: corner.startsWith('top') ? area.y + margin : area.y + area.height - height - margin,
    width,
    height
  }
}

// ------------------------------------------------------------------ windows

function createAvatarWindow(): BrowserWindow {
  const cfg = loadConfig()
  const avatar = new BrowserWindow({
    ...cornerPosition(),
    transparent: true,
    frame: false,
    hasShadow: false,
    alwaysOnTop: true,
    show: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    title: cfg.character.name,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false
    }
  })
  avatar.setAlwaysOnTop(true, 'screen-saver')
  avatar.setBackgroundColor('#00000000')
  avatar.once('ready-to-show', () => avatar.show())
  avatar.on('closed', () => {
    win.avatar = null
  })
  loadPage(avatar, 'index.html')
  win.avatar = avatar
  return avatar
}

function openChat(): BrowserWindow {
  if (win.chat && !win.chat.isDestroyed()) {
    win.chat.show()
    win.chat.focus()
    return win.chat
  }
  const chat = new BrowserWindow({
    width: 460,
    height: 640,
    minWidth: 380,
    minHeight: 420,
    show: false,
    autoHideMenuBar: true,
    title: 'Чат',
    backgroundColor: '#12141c',
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: false }
  })
  chat.once('ready-to-show', () => chat.show())
  chat.on('closed', () => {
    win.chat = null
  })
  loadPage(chat, 'chat.html')
  win.chat = chat
  return chat
}

function openSettings(): BrowserWindow {
  if (win.settings && !win.settings.isDestroyed()) {
    win.settings.show()
    win.settings.focus()
    return win.settings
  }
  const settings = new BrowserWindow({
    width: 560,
    height: 700,
    minWidth: 480,
    minHeight: 520,
    show: false,
    autoHideMenuBar: true,
    title: 'Настройки',
    backgroundColor: '#12141c',
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: false }
  })
  settings.once('ready-to-show', () => settings.show())
  settings.on('closed', () => {
    win.settings = null
  })
  loadPage(settings, 'settings.html')
  win.settings = settings
  return settings
}

function showAvatarMenu(): void {
  if (!win.avatar || win.avatar.isDestroyed()) return
  Menu.buildFromTemplate([
    { label: 'Чат', click: () => openChat() },
    { label: 'Настройки', click: () => openSettings() },
    { type: 'separator' },
    { label: 'Выход', click: () => app.quit() }
  ]).popup({ window: win.avatar })
}

// ----------------------------------------------------------------- protocol

// --------------------------------------------------------------- model file

/**
 * Reads the .vrm in the main process and hands the bytes to the renderer.
 * The renderer never fetches the file itself: fetch() cannot reach local paths
 * from an http/file page.
 */
async function readModelFile(name: string): Promise<ModelReadResult> {
  const dir = pathResolve(modelsDir())
  const file = typeof name === 'string' ? basename(name) : ''
  const full = file ? pathResolve(dir, file) : dir
  try {
    if (!file || !full.startsWith(dir)) throw new Error(`Недопустимое имя файла модели: ${String(name)}`)
    const buffer = await readFile(full)
    const data = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer
    return { ok: true, path: full, data }
  } catch (err) {
    const reason = (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'файл не найден' : (err as Error).message
    console.error('[model:read]', full, err)
    return { ok: false, path: full, error: `Не удалось прочитать модель (${reason}): ${full}` }
  }
}

function listModels(): string[] {
  try {
    return readdirSync(modelsDir())
      .filter((f) => f.toLowerCase().endsWith('.vrm'))
      .sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}

// ------------------------------------------------------- mouse / click-through

function startCursorTracker(): void {
  if (cursorTimer) return
  cursorTimer = setInterval(() => {
    const avatar = win.avatar
    if (!avatar || avatar.isDestroyed() || !avatar.isVisible()) return
    const point = screen.getCursorScreenPoint()
    const bounds = avatar.getBounds()
    const inset = loadConfig().window.hitInset
    const inside =
      point.x >= bounds.x + inset &&
      point.x <= bounds.x + bounds.width - inset &&
      point.y >= bounds.y + inset &&
      point.y <= bounds.y + bounds.height - inset
    // The HUD sits below the avatar box, so the renderer also reports hover on buttons.
    const shouldIgnore = !(inside || hoverCapture)
    if (shouldIgnore !== ignoringMouse) {
      ignoringMouse = shouldIgnore
      avatar.setIgnoreMouseEvents(shouldIgnore, { forward: true })
    }
    avatar.webContents.send('cursor', { x: point.x - bounds.x, y: point.y - bounds.y })
  }, 60)
}

// ------------------------------------------------------------------ hotkeys

function registerHotkey(accelerator: string): boolean {
  globalShortcut.unregisterAll()
  try {
    const ok = globalShortcut.register(accelerator, () => toAvatar('ptt:toggle'))
    if (!ok) broadcast('status', { text: `Не удалось занять горячую клавишу ${accelerator}`, kind: 'error' })
    return ok
  } catch {
    broadcast('status', { text: `Некорректная горячая клавиша: ${accelerator}`, kind: 'error' })
    return false
  }
}

// -------------------------------------------------------------- tool context

const toolContext: ToolContext = {
  async confirm(title, detail) {
    const parent = win.chat && !win.chat.isDestroyed() ? win.chat : win.avatar
    const options = {
      type: 'question' as const,
      buttons: ['Разрешить', 'Отмена'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
      title: 'Подтверждение',
      message: title,
      detail
    }
    const result = parent
      ? await dialog.showMessageBox(parent, options)
      : await dialog.showMessageBox(options)
    return result.response === 0
  }
}

// ---------------------------------------------------------------------- ipc

function registerIpc(): void {
  ipcMain.handle('config:get', () => loadConfig())
  ipcMain.handle('models:list', () => listModels())
  ipcMain.handle('model:read', (_e, name: string) => readModelFile(name))
  ipcMain.handle('settings:get', () => effectiveSettings())
  ipcMain.handle('settings:test', () => testConnection())
  ipcMain.handle('tts:synth', (_e, text: string) => synthesize(String(text ?? '')))
  ipcMain.handle('rvc:status', () => rvcStatus())
  ipcMain.handle('rvc:restart', () => {
    stopRvcServer()
    return ensureRvcServer(true)
  })
  ipcMain.handle('rvc:convert', (_e, payload: { base64: string; params: RvcParams }) =>
    rvcConvert(String(payload?.base64 ?? ''), {
      pitch: Number(payload?.params?.pitch ?? 0),
      indexRate: Number(payload?.params?.indexRate ?? 0.6),
      protect: Number(payload?.params?.protect ?? 0.33)
    })
  )
  ipcMain.on('chat:note', (_e, text: string) => pushMessage('system', String(text ?? '').slice(0, 300)))
  ipcMain.on('tts:fallback', (_e, payload: { reason: string; provider: string }) => {
    const reason = String(payload?.reason ?? '').slice(0, 200)
    const provider = String(payload?.provider ?? '')
    pushMessage('system', `Озвучка ${provider || 'TTS'} не сработала — говорю системным голосом. ${reason}`.trim())
  })
  ipcMain.handle('chat:history', () => getHistory())

  ipcMain.handle('settings:save', (_e, patch: SettingsPatch): SaveResult => {
    const before = effectiveSettings()
    const result = saveSettings(patch ?? {})
    const after = result.settings ?? effectiveSettings()
    if (before.model !== after.model || before.systemPrompt !== after.systemPrompt) resetChat()
    if (before.hotkey !== after.hotkey) registerHotkey(after.hotkey)
    if (
      before.useRvc !== after.useRvc ||
      before.rvcModel !== after.rvcModel ||
      before.rvcIndex !== after.rvcIndex ||
      before.rvcPort !== after.rvcPort
    ) {
      void ensureRvcServer(true)
    }
    broadcast('settings:changed')
    return result
  })

  ipcMain.handle('voice:send', (_e, payload: { base64: string; mimeType: string }) => {
    pushMessage('user', '🎤 Голосовое сообщение')
    return ask({ audio: { base64: payload.base64, mimeType: payload.mimeType } }, toolContext)
  })

  ipcMain.handle('chat:send', (_e, text: string) => {
    const clean = String(text ?? '').trim().slice(0, 4000)
    if (clean) pushMessage('user', clean)
    return ask({ text: clean }, toolContext)
  })

  ipcMain.on('ui:open-chat', () => openChat())
  ipcMain.on('ui:open-settings', () => openSettings())
  ipcMain.on('ui:quit', () => app.quit())
  ipcMain.on('ui:context-menu', () => showAvatarMenu())
  ipcMain.on('renderer:ready', () => broadcast('settings:changed'))
  ipcMain.on('avatar:dance', (_e, _on: boolean) => {
    // The renderer owns the dance animation; main only mirrors the toggle for tool calls.
  })
  ipcMain.on('avatar:hover', (_e, on: boolean) => {
    hoverCapture = !!on
  })
}

function registerPermissions(): void {
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media')
  })
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media')
}

// --------------------------------------------------------------------- boot

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win.avatar && !win.avatar.isDestroyed()) {
      win.avatar.show()
      win.avatar.focus()
    }
  })

  app.whenReady().then(() => {
    registerPermissions()
    registerIpc()
    createAvatarWindow()
    startCursorTracker()

    // Software compositing cannot render a per-pixel transparent window.
    const gpu = app.getGPUFeatureStatus()
    if (String(gpu.gpu_compositing).startsWith('disabled')) {
      console.warn(
        '[window] Аппаратное ускорение недоступно (gpu_compositing=%s): прозрачность окна работать не будет, ' +
          'аватар будет с непрозрачным фоном.',
        gpu.gpu_compositing
      )
    }

    const settings = effectiveSettings()
    registerHotkey(settings.hotkey)
    // The RVC server is a child process of the app; it loads the voice model in the background.
    if (settings.useRvc) void ensureRvcServer()
    // The desktop shortcut passes --sukuno-settings to open the settings window too.
    const wantSettings = process.argv.includes('--sukuno-settings') || process.env['SUKUNO_OPEN_SETTINGS'] === '1'
    if (!getApiKey() || wantSettings) openSettings()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createAvatarWindow()
    })
  })

  app.on('window-all-closed', () => app.quit())
  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
    if (cursorTimer) clearInterval(cursorTimer)
    cursorTimer = null
    stopRvcServer()
  })
}
