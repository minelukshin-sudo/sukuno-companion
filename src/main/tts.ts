import { app } from 'electron'
import { readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { GoogleGenAI } from '@google/genai'
import { EdgeTTS } from 'node-edge-tts'
import type { TtsAudio, VoiceProvider } from '../shared/types'
import { loadConfig } from './config'
import { effectiveSettings, getApiKey } from './settings'
import { describeError } from './brain'

/** Gemini TTS returns raw 16-bit PCM; wrap it so Web Audio can decode it. */
export function pcmToWav(pcm: Buffer, sampleRate = 24000, channels = 1, bitsPerSample = 16): Buffer {
  const header = Buffer.alloc(44)
  const byteRate = (sampleRate * channels * bitsPerSample) / 8
  const blockAlign = (channels * bitsPerSample) / 8
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(bitsPerSample, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

const EDGE_VOICE = /^[a-z]{2}-[A-Z]{2}-\w+Neural$/

interface GeminiAudioPart {
  inlineData?: { data?: string; mimeType?: string }
}

/** Docs: responseModalities AUDIO + speechConfig, audio arrives as base64 PCM. */
async function geminiTts(text: string, model: string, voiceName: string): Promise<TtsAudio> {
  const apiKey = getApiKey()
  if (!apiKey) throw new Error('Нет сохранённого ключа Gemini')
  const ai = new GoogleGenAI({ apiKey })
  const request = {
    model,
    contents: [{ parts: [{ text }] }],
    config: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } }
    }
  }
  const response = (await ai.models.generateContent(request as never)) as unknown as {
    candidates?: { content?: { parts?: GeminiAudioPart[] } }[]
    data?: string
  }
  const part = response.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)
  const data = part?.inlineData?.data ?? response.data
  if (!data) throw new Error('Gemini не вернул аудио')
  const mimeType = part?.inlineData?.mimeType ?? 'audio/L16;codec=pcm;rate=24000'
  const rate = Number(/rate=(\d+)/.exec(mimeType)?.[1] ?? 24000)
  const wav = pcmToWav(Buffer.from(data, 'base64'), rate)
  return { ok: true, provider: 'gemini', mimeType: 'audio/wav', base64: wav.toString('base64') }
}

/** Microsoft Edge neural voices (same service the browser uses). */
async function edgeTts(text: string, voiceName: string): Promise<TtsAudio> {
  const file = join(app.getPath('temp'), `sukuno-tts-${Date.now()}-${Math.random().toString(36).slice(2)}.mp3`)
  try {
    const tts = new EdgeTTS({
      voice: voiceName,
      lang: voiceName.split('-').slice(0, 2).join('-'),
      outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
      timeout: 20000
    })
    await tts.ttsPromise(text, file)
    const audio = await readFile(file)
    if (!audio.length) throw new Error('Edge TTS вернул пустой файл')
    return { ok: true, provider: 'edge', mimeType: 'audio/mpeg', base64: audio.toString('base64') }
  } finally {
    await unlink(file).catch(() => undefined)
  }
}

/** Picks the provider and voice from settings, falling back to the config defaults. */
export async function synthesize(text: string): Promise<TtsAudio> {
  const cfg = loadConfig()
  const settings = effectiveSettings(cfg)
  const provider: VoiceProvider = settings.voiceProvider || cfg.tts.provider
  const clean = text.trim().slice(0, 1200)
  if (!clean) return { ok: false, provider, mimeType: '', base64: '', error: 'Пустой текст' }
  if (provider === 'system') {
    return { ok: false, provider, mimeType: '', base64: '', error: 'Выбран системный голос' }
  }

  // A voice name typed for the other provider must not break synthesis.
  const typed = settings.ttsVoice.trim()
  if (provider === 'edge') {
    const voice = EDGE_VOICE.test(typed) ? typed : cfg.tts.edgeVoice
    try {
      return await edgeTts(clean, voice)
    } catch (err) {
      console.error('[tts:edge]', (err as Error).message)
      return { ok: false, provider, mimeType: '', base64: '', error: describeError(err) }
    }
  }

  const model = settings.ttsModel.trim() || cfg.tts.geminiModel
  const voice = typed && !EDGE_VOICE.test(typed) ? typed : cfg.tts.geminiVoice
  try {
    return await geminiTts(clean, model, voice)
  } catch (err) {
    console.error('[tts:gemini]', (err as Error).message)
    return { ok: false, provider, mimeType: '', base64: '', error: describeError(err, model) }
  }
}
