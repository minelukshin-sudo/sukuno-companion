import * as THREE from 'three'
import './style.css'
import { VrmAvatar } from './vrmAvatar'
import { DanceAudio } from './dance'
import { Recorder, Speaker } from './voice'

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

const loading = $('loading')
const loadText = $('loadText')
const loadBar = $('loadBar')
const bubble = $('bubble')
const statusEl = $('status')
const ptt = $<HTMLButtonElement>('ptt')
const danceBtn = $<HTMLButtonElement>('danceBtn')
const stopBtn = $<HTMLButtonElement>('stopBtn')

const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true })
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
renderer.setSize(window.innerWidth, window.innerHeight)
renderer.outputColorSpace = THREE.SRGBColorSpace
renderer.toneMapping = THREE.NoToneMapping
renderer.setClearColor(0x000000, 0)
renderer.domElement.id = 'gl'
document.body.appendChild(renderer.domElement)

const camera = new THREE.PerspectiveCamera(26, window.innerWidth / window.innerHeight, 0.1, 30)
camera.position.set(0, 1.42, 2.05)
camera.lookAt(0, 1.3, 0)

const avatar = new VrmAvatar()
const dance = new DanceAudio()
const recorder = new Recorder()
const speaker = new Speaker()
const clock = new THREE.Clock()

let cursor = { x: window.innerWidth / 2, y: window.innerHeight - 80 }
let hoverCapture = false
let danceOn = false
let avatarReady = false
let bubbleTimer = 0
let statusTimer = 0

function setStatus(text: string, kind: 'info' | 'error' | 'ok' = 'info', autoClear = 0): void {
  statusEl.textContent = text
  statusEl.className = kind === 'error' ? 'error' : kind === 'ok' ? 'ok' : ''
  if (statusTimer) clearTimeout(statusTimer)
  if (autoClear > 0) {
    statusTimer = window.setTimeout(() => setStatus(''), autoClear)
  }
}

function showBubble(text: string, ms = 7000): void {
  bubble.textContent = text
  bubble.classList.add('show')
  if (bubbleTimer) clearTimeout(bubbleTimer)
  bubbleTimer = window.setTimeout(() => bubble.classList.remove('show'), ms)
}

function setRecordingUi(on: boolean): void {
  ptt.classList.toggle('rec', on)
  ptt.textContent = on ? '⏹' : '🎙'
}

async function toggleRecording(): Promise<void> {
  if (recorder.busy) {
    setRecordingUi(false)
    setStatus('Обрабатываю запись…')
    const result = await recorder.stop()
    if (!result) {
      setStatus('Слишком короткая запись', 'error', 3000)
      return
    }
    const answer = await window.api.sendVoice(result.base64, result.mimeType)
    if (!answer.ok) setStatus(answer.error ?? 'Ошибка', 'error', 6000)
    else setStatus('')
    return
  }
  try {
    const settings = await window.api.getSettings()
    speaker.stop()
    await recorder.start(settings.microphone)
    setRecordingUi(true)
    setStatus('Слушаю… (нажмите ещё раз, чтобы отправить)')
  } catch {
    setRecordingUi(false)
    setStatus('Нет доступа к микрофону', 'error', 5000)
  }
}

async function toggleDance(force?: boolean): Promise<void> {
  const next = force === undefined ? !danceOn : force
  if (next === danceOn) return
  danceOn = next
  avatar.setDanceTarget(danceOn)
  danceBtn.classList.toggle('active', danceOn)
  window.api.setDance(danceOn)
  if (danceOn) {
    const settings = await window.api.getSettings()
    const mic = await dance.start(settings.microphone)
    setStatus(mic ? 'Танцую под музыку из микрофона' : 'Танцую без микрофона', 'ok', 3500)
  } else {
    dance.stop()
    setStatus('', 'info')
  }
}

async function boot(): Promise<void> {
  try {
    const [cfg, models, settings] = await Promise.all([
      window.api.getConfig(),
      window.api.listModels(),
      window.api.getSettings()
    ])
    const file = models.includes(cfg.modelFile) ? cfg.modelFile : models[0]
    if (!file) {
      loading.classList.add('hidden')
      setStatus('Положите .vrm файл в папку models', 'error')
      return
    }
    if (!settings.hasApiKey) setStatus('Нужен ключ Gemini — откройте «Настройки»', 'error')

    loadText.textContent = `Читаю ${file}…`
    loadBar.classList.add('indeterminate')
    const model = await window.api.readModel(file)
    if (!model.ok || !model.data) {
      loading.classList.add('hidden')
      setStatus(model.error ?? `Не удалось прочитать модель: ${model.path}`, 'error')
      return
    }

    loadText.textContent = `Готовлю модель (${Math.round(model.data.byteLength / 1048576)} МБ)…`
    await avatar.load(model.data, model.path)
    loading.classList.add('hidden')
    avatarReady = true
    window.api.ready()
  } catch (err) {
    loading.classList.add('hidden')
    console.error('[avatar] ошибка загрузки', err)
    setStatus(`Ошибка загрузки модели: ${(err as Error).message}`, 'error')
  }
}

function animate(): void {
  requestAnimationFrame(animate)
  const dt = Math.min(clock.getDelta(), 0.05)
  const t = clock.elapsedTime
  if (!avatarReady) {
    renderer.render(avatar.scene, camera)
    return
  }
  const nx = THREE.MathUtils.clamp((cursor.x / window.innerWidth) * 2 - 1, -1, 1)
  const ny = THREE.MathUtils.clamp((cursor.y / window.innerHeight) * 2 - 1, -1, 1)
  avatar.update(dt, {
    t,
    yaw: nx * 0.7,
    pitch: ny * 0.5,
    mouth: speaker.mouth(dt),
    energy: danceOn ? dance.energy(t) : 0
  })
  renderer.render(avatar.scene, camera)
}

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight)
  camera.aspect = window.innerWidth / window.innerHeight
  camera.updateProjectionMatrix()
})

document.addEventListener('contextmenu', (event) => {
  event.preventDefault()
  window.api.contextMenu()
})

ptt.addEventListener('click', () => void toggleRecording())
danceBtn.addEventListener('click', () => void toggleDance())
stopBtn.addEventListener('click', () => {
  speaker.stop()
  setStatus('', 'info')
})

window.api.onRecordToggle(() => void toggleRecording())
window.api.onCursor((pos) => {
  cursor = pos
  // The window ignores mouse events outside the avatar, so buttons must ask for capture.
  const element = document.elementFromPoint(pos.x, pos.y)
  const overButton = !!element?.closest('button')
  if (overButton !== hoverCapture) {
    hoverCapture = overButton
    window.api.setHoverCapture(overButton)
  }
})
window.api.onAssistant((text) => {
  showBubble(text)
  void speaker.speak(text)
})
window.api.onReminder((reminder) => {
  showBubble(`⏰ ${reminder.text}`, 15000)
  void speaker.speak(`Напоминание. ${reminder.text}`)
})
window.api.onStatus((status) => {
  if (!status.text) {
    setStatus('')
    return
  }
  setStatus(status.text, status.kind, status.kind === 'error' ? 6000 : 4000)
})
window.api.onDanceCommand((on) => void toggleDance(on))

void boot()
animate()
