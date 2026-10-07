import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'

/** Live window references, shared by every main-process module. */
export const win: {
  avatar: BrowserWindow | null
  chat: BrowserWindow | null
  settings: BrowserWindow | null
} = { avatar: null, chat: null, settings: null }

export function modelsDir(): string {
  // Dev: <project>/models. Packaged: <resources>/models.
  return app.isPackaged ? join(process.resourcesPath, 'models') : join(app.getAppPath(), 'models')
}

function alive(w: BrowserWindow | null): w is BrowserWindow {
  return !!w && !w.isDestroyed()
}

export function broadcast(channel: string, payload?: unknown): void {
  for (const w of [win.avatar, win.chat, win.settings]) {
    if (alive(w)) w.webContents.send(channel, payload)
  }
}

export function toAvatar(channel: string, payload?: unknown): void {
  if (alive(win.avatar)) win.avatar.webContents.send(channel, payload)
}

export function toChat(channel: string, payload?: unknown): void {
  if (alive(win.chat)) win.chat.webContents.send(channel, payload)
}
