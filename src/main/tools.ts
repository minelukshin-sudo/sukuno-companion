import { app } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { loadConfig } from './config'
import { addFact } from './memory'
import { pushMessage } from './chatlog'
import { toAvatar } from './context'

const run = promisify(execFile)

export interface ToolDecl {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface ToolContext {
  confirm(title: string, detail: string): Promise<boolean>
}

export const toolDeclarations: ToolDecl[] = [
  {
    name: 'open_app',
    description:
      'Запустить приложение из белого списка пользователя. Доступны только приложения из списка ниже.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Название приложения из белого списка, например «Блокнот».' }
      },
      required: ['name']
    }
  },
  {
    name: 'open_url',
    description: 'Открыть ссылку в браузере по умолчанию.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Полный URL, начинающийся с http:// или https://' } },
      required: ['url']
    }
  },
  {
    name: 'search_files',
    description: 'Найти файлы по части имени в папках Документы, Загрузки и Рабочий стол.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Часть имени файла для поиска.' },
        location: {
          type: 'string',
          enum: ['documents', 'downloads', 'desktop', 'all'],
          description: 'Где искать. По умолчанию all.'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'press_keys',
    description:
      'Отправить нажатия клавиш в активное окно Windows. Используй синтаксис SendKeys: обычный текст пишется как есть, ' +
      'специальные клавиши — в фигурных скобках: {ENTER}, {TAB}, {ESC}, {BACKSPACE}, {DEL}, {UP}, {DOWN}, {LEFT}, {RIGHT}, ' +
      '{HOME}, {END}, {PGUP}, {PGDN}, {F1}…{F12}. Модификаторы перед обычным символом: ^ = Ctrl, % = Alt, + = Shift.',
    parameters: {
      type: 'object',
      properties: { keys: { type: 'string', description: 'Строка SendKeys, например ^s или {ENTER}' } },
      required: ['keys']
    }
  },
  {
    name: 'set_reminder',
    description: 'Поставить напоминание: через указанное число минут персонаж сам напомнит вслух.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Что напомнить.' },
        minutes: { type: 'number', description: 'Через сколько минут напомнить (по умолчанию 5).' }
      },
      required: ['text']
    }
  },
  {
    name: 'dance',
    description: 'Включить или выключить режим танца под музыку из микрофона.',
    parameters: {
      type: 'object',
      properties: { on: { type: 'boolean', description: 'true — танцевать, false — остановиться.' } },
      required: ['on']
    }
  },
  {
    name: 'remember_fact',
    description: 'Запомнить факт о пользователе в долговременную память (имя, привычки, предпочтения).',
    parameters: {
      type: 'object',
      properties: { fact: { type: 'string', description: 'Короткий факт, например «любит кофе без сахара».' } },
      required: ['fact']
    }
  }
]

function ok(data: Record<string, unknown> = {}): Record<string, unknown> {
  return { ok: true, ...data }
}

function fail(error: string): Record<string, unknown> {
  return { ok: false, error }
}

// ---------------------------------------------------------------- open_app

async function openApp(name: string, ctx: ToolContext): Promise<Record<string, unknown>> {
  const cfg = loadConfig()
  const wanted = name.trim().toLowerCase()
  const list = cfg.appWhitelist
  const entry = list.find((a) => a.name.toLowerCase() === wanted) ?? list.find((a) => a.name.toLowerCase().includes(wanted))
  if (!entry) {
    return fail(`Приложение «${name}» нет в белом списке. Доступно: ${list.map((a) => a.name).join(', ')}`)
  }
  if (cfg.confirm.open_app) {
    const agreed = await ctx.confirm('Запустить приложение?', `«${entry.name}»\n${entry.path}`)
    if (!agreed) return fail('Пользователь отклонил запуск приложения.')
  }
  const target = entry.path
  if (/^[a-z]:[\\/]/i.test(target) && !existsSync(target)) {
    return fail(`Файл не найден: ${target}. Поправьте путь в config.json.`)
  }
  try {
    const child = /\.(cmd|bat)$/i.test(target)
      ? spawn('cmd.exe', ['/c', target], { detached: true, stdio: 'ignore', windowsHide: true })
      : spawn(target, [], { detached: true, stdio: 'ignore', windowsHide: true })
    child.unref()
    return ok({ launched: entry.name })
  } catch (e) {
    return fail(`Не удалось запустить: ${(e as Error).message}`)
  }
}

// ---------------------------------------------------------------- open_url

async function openUrl(rawUrl: string, ctx: ToolContext): Promise<Record<string, unknown>> {
  const url = rawUrl.trim()
  if (!/^https?:\/\/[^\s]+$/i.test(url)) return fail('Разрешены только ссылки http:// и https://')
  if (loadConfig().confirm.open_url) {
    const agreed = await ctx.confirm('Открыть ссылку?', url)
    if (!agreed) return fail('Пользователь отклонил открытие ссылки.')
  }
  const { shell } = await import('electron')
  await shell.openExternal(url)
  return ok({ opened: url })
}

// ------------------------------------------------------------ search_files

interface Found {
  name: string
  path: string
}

const SKIP_DIRS = new Set(['node_modules', '$recycle.bin', 'appdata', '.git', 'windows', 'program files'])

function searchDir(dir: string, needle: string, out: Found[], depth: number, deadline: number): void {
  if (out.length >= 30 || depth > 4 || Date.now() > deadline) return
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (out.length >= 30 || Date.now() > deadline) return
    if (e.name.startsWith('.') || e.name.startsWith('~$')) continue
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name.toLowerCase())) continue
      searchDir(full, needle, out, depth + 1, deadline)
    } else if (e.name.toLowerCase().includes(needle)) {
      out.push({ name: e.name, path: full })
    }
  }
}

function searchFiles(query: string, location = 'all'): Record<string, unknown> {
  const needle = query.trim().toLowerCase()
  if (needle.length < 2) return fail('Слишком короткий запрос — нужно минимум 2 символа.')
  const roots: string[] = []
  const want = (loc: string): boolean => location === 'all' || location === loc
  if (want('documents')) roots.push(app.getPath('documents'))
  if (want('downloads')) roots.push(app.getPath('downloads'))
  if (want('desktop')) roots.push(app.getPath('desktop'))
  const out: Found[] = []
  const deadline = Date.now() + 5000
  for (const root of roots) searchDir(root, needle, out, 0, deadline)
  return ok({ count: out.length, files: out })
}

// ------------------------------------------------------------- press_keys

const NAMED_KEYS = new Set([
  'ENTER', 'TAB', 'ESC', 'ESCAPE', 'BACKSPACE', 'BS', 'DEL', 'DELETE', 'INSERT', 'INS', 'SPACE',
  'UP', 'DOWN', 'LEFT', 'RIGHT', 'HOME', 'END', 'PGUP', 'PGDN', 'CAPSLOCK', 'NUMLOCK', 'SCROLLLOCK',
  'ADD', 'SUBTRACT', 'MULTIPLY', 'DIVIDE',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12'
])

const LITERAL = /^[A-Za-z0-9А-Яа-яЁё .,!?@#\-_=:'"\\/|;:<>]$/
const SPECIAL = '+^%~()[]{}'

/** Converts a SendKeys-ish string into a safe SendKeys string, or null when unsafe. */
function escapeSendKeys(input: string): string | null {
  if (!input || input.length > 400) return null
  const out: string[] = []
  const re = /\{([A-Za-z0-9]+)\}|([\s\S])/g
  let m: RegExpExecArray | null
  while ((m = re.exec(input)) !== null) {
    if (m[1]) {
      const token = m[1].toUpperCase()
      if (!NAMED_KEYS.has(token)) return null
      out.push(`{${token}}`)
      continue
    }
    const ch = m[2]
    if (ch === '^' || ch === '%' || ch === '+') {
      out.push(ch) // modifier prefix
      continue
    }
    if (!LITERAL.test(ch)) return null
    out.push(SPECIAL.includes(ch) ? `{${ch}}` : ch)
  }
  return out.length ? out.join('') : null
}

// Minimal user32 bindings so confirm dialogs do not steal the keystrokes target.
const WIN_API = `Add-Type -Namespace Win -Name Fg -MemberDefinition '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);'`

async function foregroundWindow(): Promise<number> {
  try {
    const { stdout } = await run(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `${WIN_API}; [Win.Fg]::GetForegroundWindow().ToInt64()`],
      { windowsHide: true, timeout: 8000 }
    )
    return Number(String(stdout).trim()) || 0
  } catch {
    return 0
  }
}

async function sendKeysTo(hwnd: number, keys: string): Promise<void> {
  const b64 = Buffer.from(keys, 'utf8').toString('base64')
  const cmd =
    `${WIN_API}; Add-Type -AssemblyName System.Windows.Forms; ` +
    `if (${hwnd} -ne 0) { [void][Win.Fg]::SetForegroundWindow([IntPtr]${hwnd}) }; ` +
    `Start-Sleep -Milliseconds 200; ` +
    `$t = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')); ` +
    `[System.Windows.Forms.SendKeys]::SendWait($t)`
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { windowsHide: true, timeout: 15000 })
}

async function pressKeys(keys: string, ctx: ToolContext): Promise<Record<string, unknown>> {
  const safe = escapeSendKeys(keys)
  if (!safe) return fail('Недопустимая комбинация клавиш. Разрешены буквы, цифры, знаки и клавиши вида {ENTER}, {TAB}, {F5}.')
  if (loadConfig().confirm.press_keys) {
    const hwnd = await foregroundWindow()
    const agreed = await ctx.confirm('Отправить нажатия клавиш?', `${keys}`)
    if (!agreed) return fail('Пользователь отклонил отправку клавиш.')
    try {
      await sendKeysTo(hwnd, safe)
    } catch (e) {
      return fail(`Не удалось отправить клавиши: ${(e as Error).message}`)
    }
    return ok({ sent: keys })
  }
  try {
    await sendKeysTo(0, safe)
    return ok({ sent: keys })
  } catch (e) {
    return fail(`Не удалось отправить клавиши: ${(e as Error).message}`)
  }
}

// ------------------------------------------------------------ set_reminder

function setReminder(text: string, minutes: number): Record<string, unknown> {
  const clean = text.trim().slice(0, 200)
  if (!clean) return fail('Пустой текст напоминания.')
  const mins = Math.min(Math.max(Number(minutes) || 5, 0.05), 1440)
  const delay = Math.round(mins * 60_000)
  setTimeout(() => {
    const at = Date.now()
    toAvatar('reminder', { text: clean, at })
    pushMessage('system', `⏰ Напоминание: ${clean}`)
  }, delay)
  return ok({ scheduled: clean, inMinutes: mins })
}

// ------------------------------------------------------------------ router

export async function runTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<Record<string, unknown>> {
  const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)
  try {
    switch (name) {
      case 'open_app':
        return await openApp(str(args.name), ctx)
      case 'open_url':
        return await openUrl(str(args.url), ctx)
      case 'search_files':
        return searchFiles(str(args.query), str(args.location, 'all') || 'all')
      case 'press_keys':
        return await pressKeys(str(args.keys), ctx)
      case 'set_reminder':
        return setReminder(str(args.text), Number(args.minutes))
      case 'dance': {
        const on = args.on !== false
        toAvatar('avatar:dance-command', on)
        return ok({ dancing: on })
      }
      case 'remember_fact': {
        const facts = addFact(str(args.fact))
        return ok({ remembered: str(args.fact), total: facts.length })
      }
      default:
        return fail(`Неизвестный инструмент: ${name}`)
    }
  } catch (e) {
    return fail(`Ошибка инструмента ${name}: ${(e as Error).message}`)
  }
}
