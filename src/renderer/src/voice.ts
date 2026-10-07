/**
 * Microphone capture (MediaRecorder) converted to WAV, plus speech output:
 * TTS (Gemini / Edge) -> optional RVC conversion -> Web Audio playback,
 * with speechSynthesis only as the fallback. No Web Speech recognition is used.
 */

import { AudioPlayer } from './playback'
import type { TtsAudio } from '../../shared/types'

export interface RecordResult {
  base64: string
  mimeType: string
}

const MAX_RECORD_MS = 30_000

function pickMimeType(): string {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']
  for (const type of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type)) return type
  }
  return ''
}

function writeString(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
}

/** 16-bit mono PCM WAV — a format Gemini accepts directly. */
function encodeWav(audio: AudioBuffer): Blob {
  const channels = Math.min(audio.numberOfChannels, 2)
  const length = audio.length
  const rate = audio.sampleRate
  const mono = new Float32Array(length)
  for (let c = 0; c < channels; c++) {
    const data = audio.getChannelData(c)
    for (let i = 0; i < length; i++) mono[i] += data[i] / channels
  }

  const dataSize = length * 2
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)
  writeString(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeString(view, 8, 'WAVE')
  writeString(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeString(view, 36, 'data')
  view.setUint32(40, dataSize, true)

  let offset = 44
  for (let i = 0; i < length; i++) {
    const sample = Math.max(-1, Math.min(1, mono[i]))
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
    offset += 2
  }
  return new Blob([buffer], { type: 'audio/wav' })
}

async function toWav(blob: Blob): Promise<Blob> {
  const raw = await blob.arrayBuffer()
  const ctx = new AudioContext()
  try {
    const decoded = await ctx.decodeAudioData(raw)
    return encodeWav(decoded)
  } finally {
    void ctx.close()
  }
}

async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  const step = 0x8000
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step))
  }
  return btoa(binary)
}

export class Recorder {
  busy = false
  private recorder: MediaRecorder | null = null
  private stream: MediaStream | null = null
  private chunks: Blob[] = []
  private autoStop: number | null = null

  async start(deviceId: string): Promise<void> {
    if (this.busy) return
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: deviceId ? { deviceId: { exact: deviceId } } : true
    })
    const mimeType = pickMimeType()
    const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)
    this.stream = stream
    this.recorder = recorder
    this.chunks = []
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.chunks.push(event.data)
    }
    recorder.start(200)
    this.busy = true
    this.autoStop = window.setTimeout(() => void this.stop(), MAX_RECORD_MS)
  }

  async stop(): Promise<RecordResult | null> {
    const recorder = this.recorder
    if (!recorder || !this.busy) return null
    this.busy = false
    if (this.autoStop !== null) {
      clearTimeout(this.autoStop)
      this.autoStop = null
    }

    const blob = await new Promise<Blob>((resolve) => {
      recorder.onstop = () => resolve(new Blob(this.chunks, { type: recorder.mimeType || 'audio/webm' }))
      recorder.stop()
    })

    this.stream?.getTracks().forEach((track) => track.stop())
    this.stream = null
    this.recorder = null
    this.chunks = []

    if (blob.size < 1500) return null // too short to be speech
    try {
      const wav = await toWav(blob)
      return { base64: await toBase64(wav), mimeType: 'audio/wav' }
    } catch {
      return null
    }
  }
}

function waitForVoices(): Promise<void> {
  return new Promise((resolve) => {
    const synth = window.speechSynthesis
    if (!synth) return resolve()
    if (synth.getVoices().length) return resolve()
    let done = false
    const finish = (): void => {
      if (!done) {
        done = true
        resolve()
      }
    }
    synth.onvoiceschanged = finish
    window.setTimeout(finish, 1500)
  })
}

/** Cuts a reply into speakable chunks so playback can start before the whole text is rendered. */
export function splitForSpeech(text: string, max = 180): string[] {
  const clean = text
    .replace(/[*_#`>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!clean) return []
  const rough = clean.match(/[^.!?…]+[.!?…]*/g) ?? [clean]
  const parts: string[] = []
  let buffer = ''
  const flush = (): void => {
    if (buffer.trim()) parts.push(buffer.trim())
    buffer = ''
  }
  for (const piece of rough) {
    let rest = piece.trim()
    if (!rest) continue
    if (rest.length > max) {
      flush()
      while (rest.length > max) {
        let cut = rest.lastIndexOf(',', max)
        if (cut < 40) cut = rest.lastIndexOf(' ', max)
        if (cut < 40) cut = max
        parts.push(rest.slice(0, cut + 1).trim())
        rest = rest.slice(cut + 1).trim()
      }
      if (rest) buffer = rest
      continue
    }
    if ((buffer + ' ' + rest).trim().length > max) flush()
    buffer = buffer ? `${buffer} ${rest}` : rest
  }
  flush()
  return parts
}

/**
 * Speech output. Gemini TTS / Edge TTS come from the main process as audio,
 * speechSynthesis is kept only as the fallback.
 */
export class Speaker {
  speaking = false
  private player = new AudioPlayer()
  private generation = 0
  private mouthValue = 0
  private systemPulse = 0
  private systemSpeaking = false

  private pickSystemVoice(): SpeechSynthesisVoice | null {
    const voices = window.speechSynthesis?.getVoices() ?? []
    const russian = voices.filter((v) => v.lang.toLowerCase().startsWith('ru'))
    if (!russian.length) return null
    return russian.find((v) => /irina|milena|svetlana|dariya|russian/i.test(v.name)) ?? russian[0]
  }

  /** Speaks a reply: sentence by sentence, playing the first clip as soon as it arrives. */
  async speak(text: string): Promise<void> {
    const clean = text.trim()
    if (!clean) return
    this.stop()
    const generation = ++this.generation
    const settings = await window.api.getSettings()
    if (generation !== this.generation) return

    if (settings.voiceProvider === 'system') {
      await this.speakSystem(clean, generation)
      return
    }

    const parts = splitForSpeech(clean)
    if (!parts.length) return
    this.speaking = true

    const rvcEnabled = settings.useRvc
    const rvcParams = { pitch: settings.rvcPitch, indexRate: settings.rvcIndexRate, protect: 0.33 }
    const warned = { value: false }

    type Prepared = {
      ok: boolean
      audio: { base64: string; mimeType: string }
      error: string
      provider: string
      ttsMs: number
      rvcMs: number
      note: string
    }

    /** TTS -> (RVC) для одной фразы; конвертация ограничена 5 секундами. */
    const prepare = async (ttsPromise: Promise<TtsAudio>): Promise<Prepared> => {
      const ttsStarted = performance.now()
      const tts = await ttsPromise
      const ttsMs = performance.now() - ttsStarted
      const plain = { base64: tts.base64, mimeType: tts.mimeType }
      if (!tts.ok) {
        return { ok: false, audio: plain, error: tts.error ?? '', provider: tts.provider, ttsMs, rvcMs: 0, note: '' }
      }
      if (!rvcEnabled) {
        return { ok: true, audio: plain, error: '', provider: tts.provider, ttsMs, rvcMs: 0, note: '' }
      }

      const rvcStarted = performance.now()
      const converted = await Promise.race([
        window.api.rvcConvert(tts.base64, rvcParams),
        new Promise<null>((resolve) => window.setTimeout(() => resolve(null), 5000))
      ])
      const rvcMs = performance.now() - rvcStarted
      if (converted === null) {
        return {
          ok: true,
          audio: plain,
          error: '',
          provider: tts.provider,
          ttsMs,
          rvcMs,
          note: `RVC дольше 5 секунд — играю обычный TTS.`
        }
      }
      if (!converted.ok) {
        return {
          ok: true,
          audio: plain,
          error: '',
          provider: tts.provider,
          ttsMs,
          rvcMs,
          note: `RVC не сработал (${converted.error ?? 'ошибка'}) — играю обычный TTS.`
        }
      }
      return {
        ok: true,
        audio: { base64: converted.base64, mimeType: converted.mimeType },
        error: '',
        provider: tts.provider,
        ttsMs,
        rvcMs,
        note: ''
      }
    }

    // Синтез следующей фразы стартует сразу после предыдущего синтеза,
    // а конвертация — сразу после конвертации предыдущей, то есть во время её проигрывания.
    const ttsPromises: Promise<TtsAudio>[] = [window.api.synthesize(parts[0])]
    for (let i = 1; i < parts.length; i++) {
      ttsPromises[i] = ttsPromises[i - 1].then(() => window.api.synthesize(parts[i]))
    }
    const ready: Promise<Prepared>[] = []
    for (let i = 0; i < parts.length; i++) {
      ready.push(i === 0 ? prepare(ttsPromises[0]) : ready[i - 1].then(() => prepare(ttsPromises[i])))
    }

    for (let i = 0; i < parts.length; i++) {
      const prepared = await ready[i]
      if (generation !== this.generation) return

      if (!prepared.ok) {
        window.api.ttsFallback(prepared.error, prepared.provider)
        this.speaking = false
        await this.speakSystem(parts.slice(i).join(' '), generation)
        return
      }
      if (prepared.note && !warned.value) {
        warned.value = true
        window.api.note(prepared.note)
      }

      try {
        const playStarted = performance.now()
        await this.player.play(prepared.audio.base64, prepared.audio.mimeType)
        console.log(
          `[voice] фраза ${i + 1}/${parts.length}: TTS ${prepared.ttsMs.toFixed(0)} мс, ` +
            `RVC ${prepared.rvcMs.toFixed(0)} мс, игра ${(performance.now() - playStarted).toFixed(0)} мс` +
            (prepared.note ? ` — ${prepared.note}` : '')
        )
      } catch (err) {
        window.api.ttsFallback((err as Error).message, prepared.provider)
        this.speaking = false
        await this.speakSystem(parts.slice(i).join(' '), generation)
        return
      }
      if (generation !== this.generation) return
    }
    this.speaking = false
  }

  private speakSystem(text: string, generation: number): Promise<void> {
    return new Promise((resolve) => {
      const synth = window.speechSynthesis
      if (!synth || !text.trim()) return resolve()
      void waitForVoices().then(() => {
        if (generation !== this.generation) return resolve()
        synth.cancel()
        const utterance = new SpeechSynthesisUtterance(text)
        const voice = this.pickSystemVoice()
        if (voice) {
          utterance.voice = voice
          utterance.lang = voice.lang
        } else {
          utterance.lang = 'ru-RU'
        }
        utterance.rate = 1
        utterance.pitch = 1.05
        utterance.onstart = () => {
          this.systemSpeaking = true
          this.speaking = true
          this.systemPulse = 1
        }
        utterance.onboundary = () => {
          this.systemPulse = 1
        }
        const done = (): void => {
          this.systemSpeaking = false
          this.speaking = false
          resolve()
        }
        utterance.onend = done
        utterance.onerror = done
        synth.speak(utterance)
      })
    })
  }

  stop(): void {
    this.generation++
    this.player.stop()
    window.speechSynthesis?.cancel()
    this.systemSpeaking = false
    this.speaking = false
    this.mouthValue = 0
  }

  /** Mouth opening for the current frame, 0..1. */
  mouth(dt: number): number {
    if (this.systemSpeaking) {
      // speechSynthesis gives no audio stream, so the fallback uses a pulse.
      this.systemPulse = Math.max(0, this.systemPulse - dt * 5)
      const base = 0.22 + 0.32 * Math.abs(Math.sin(performance.now() / 55))
      return Math.min(1, base + this.systemPulse * 0.5)
    }
    if (!this.speaking) {
      this.mouthValue = Math.max(0, this.mouthValue - dt * 6)
      return 0
    }
    const target = this.player.amplitude()
    this.mouthValue += (target - this.mouthValue) * Math.min(1, dt * 22)
    return Math.min(1, this.mouthValue * 1.8)
  }
}
