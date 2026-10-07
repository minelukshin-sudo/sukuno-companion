import { app } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import type { RvcConvertResult, RvcParams, RvcStatus } from '../shared/types'
import { loadConfig } from './config'
import { effectiveSettings } from './settings'

/** Everything lives inside the project: venv, server script and models. */
export function rvcDir(): string {
  return join(app.getAppPath(), 'rvc')
}

function pythonPath(): string {
  return join(rvcDir(), 'venv', 'python.exe')
}

function serverPath(): string {
  return join(rvcDir(), 'server.py')
}

function resolveInside(projectPath: string): string {
  return isAbsolute(projectPath) ? projectPath : resolve(app.getAppPath(), projectPath)
}

let child: ChildProcess | null = null
let starting = false
let status: RvcStatus = {
  state: 'off',
  device: '',
  model: '',
  index: '',
  error: '',
  port: 0
}

export function rvcStatus(): RvcStatus {
  return { ...status }
}

function setStatus(patch: Partial<RvcStatus>): void {
  status = { ...status, ...patch }
}

function log(line: string): void {
  const text = line.trim()
  if (text) console.log(`[rvc-server] ${text}`)
}

async function health(port: number, timeoutMs = 1500): Promise<RvcStatus | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(timeoutMs)
    })
    if (!response.ok) return null
    const data = (await response.json()) as {
      loaded?: boolean
      device?: string
      model?: string
      index?: string
      error?: string
    }
    if (!data.loaded) return null
    return {
      state: 'ready',
      device: data.device ?? '',
      model: data.model ?? '',
      index: data.index ?? '',
      error: data.error ?? '',
      port
    }
  } catch {
    return null
  }
}

/** Starts the Python RVC server if RVC is on and it is not running yet. */
export async function ensureRvcServer(force = false): Promise<RvcStatus> {
  const cfg = loadConfig()
  const settings = effectiveSettings(cfg)
  const enabled = settings.useRvc
  const port = settings.rvcPort || cfg.rvc.port

  if (!enabled) {
    stopRvcServer()
    setStatus({ state: 'off', error: '', port })
    return rvcStatus()
  }
  if (child && !child.killed) {
    const alive = await health(port)
    if (alive) {
      setStatus(alive)
      return rvcStatus()
    }
  }
  if (starting && !force) return rvcStatus()

  const python = pythonPath()
  const script = serverPath()
  const model = resolveInside(settings.rvcModel || cfg.rvc.model)
  const index = resolveInside(settings.rvcIndex || cfg.rvc.index)

  if (!existsSync(python)) {
    setStatus({
      state: 'error',
      port,
      error: `Не найдено окружение RVC: ${python}\nЗапустите rvc\\setup.cmd (один раз).`
    })
    return rvcStatus()
  }
  if (!existsSync(model)) {
    setStatus({ state: 'error', port, error: `Не найден файл модели: ${model}` })
    return rvcStatus()
  }

  starting = true
  setStatus({ state: 'starting', port, error: '', model, index })

  try {
    const args = [script, '--model', model, '--port', String(port)]
    if (index && existsSync(index)) args.push('--index', index)
    child = spawn(python, args, {
      cwd: rvcDir(),
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' }
    })
    console.log(`[rvc] запускаю сервер: ${python} ${args.join(' ')}`)

    child.stdout?.on('data', (chunk: Buffer) => log(chunk.toString('utf8')))
    child.stderr?.on('data', (chunk: Buffer) => log(chunk.toString('utf8')))
    child.on('exit', (code) => {
      console.log(`[rvc] сервер остановлен (код ${code})`)
      child = null
      starting = false
      setStatus({
        state: 'error',
        error: code === 0 ? '' : `Сервер RVC завершился с кодом ${code}. Смотрите лог в консоли.`
      })
    })

    // Загрузка модели занимает ~35 c, при первом запуске ещё докачиваются базовые модели.
    const deadline = Date.now() + 240_000
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1500))
      if (!child) break
      const ready = await health(port)
      if (ready) {
        starting = false
        setStatus(ready)
        console.log(`[rvc] сервер готов: ${ready.model} на ${ready.device}`)
        return rvcStatus()
      }
    }
    starting = false
    if (status.state !== 'error') {
      setStatus({ state: 'error', error: 'Сервер RVC не поднялся за 4 минуты. Смотрите лог в консоли.' })
    }
    return rvcStatus()
  } catch (err) {
    starting = false
    setStatus({ state: 'error', error: `Не удалось запустить сервер RVC: ${(err as Error).message}` })
    return rvcStatus()
  }
}

export function stopRvcServer(): void {
  const process_ = child
  child = null
  starting = false
  if (process_ && !process_.killed) {
    console.log('[rvc] останавливаю сервер')
    try {
      process_.kill()
    } catch {
      // уже умер
    }
  }
}

/** Sends one WAV clip to the local server and returns the converted WAV. */
export async function rvcConvert(base64: string, params: RvcParams): Promise<RvcConvertResult> {
  const cfg = loadConfig()
  const settings = effectiveSettings(cfg)
  const port = settings.rvcPort || cfg.rvc.port
  const started = Date.now()
  try {
    const bytes = Buffer.from(base64, 'base64')
    const form = new FormData()
    form.append('file', new Blob([bytes], { type: 'audio/wav' }), 'sentence.wav')
    form.append('pitch', String(params.pitch))
    form.append('index_rate', String(params.indexRate))
    form.append('protect', String(params.protect))

    const response = await fetch(`http://127.0.0.1:${port}/convert`, { method: 'POST', body: form })
    const seconds = (Date.now() - started) / 1000
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      return { ok: false, base64: '', mimeType: '', seconds, error: text.slice(0, 200) || `HTTP ${response.status}` }
    }
    const buffer = Buffer.from(await response.arrayBuffer())
    return { ok: true, base64: buffer.toString('base64'), mimeType: 'audio/wav', seconds }
  } catch (err) {
    return {
      ok: false,
      base64: '',
      mimeType: '',
      seconds: (Date.now() - started) / 1000,
      error: (err as Error).message
    }
  }
}
