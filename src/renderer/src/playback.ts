/**
 * Audio playback through Web Audio: the sound goes BufferSource -> Analyser -> destination,
 * so the avatar's mouth can be driven by the real amplitude of the voice.
 */

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export class AudioPlayer {
  private ctx: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private data = new Uint8Array(0)
  private source: AudioBufferSourceNode | null = null

  private ensureContext(): AudioContext {
    if (!this.ctx) {
      const ctx = new AudioContext()
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 1024
      analyser.smoothingTimeConstant = 0.25
      analyser.connect(ctx.destination)
      this.ctx = ctx
      this.analyser = analyser
      this.data = new Uint8Array(analyser.fftSize)
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume()
    return this.ctx
  }

  /** Plays one clip and resolves when it finished (or was stopped). */
  async play(base64: string, mimeType: string): Promise<void> {
    const ctx = this.ensureContext()
    const bytes = base64ToBytes(base64)
    let buffer: AudioBuffer
    try {
      buffer = await ctx.decodeAudioData(bytes.buffer as ArrayBuffer)
    } catch (err) {
      throw new Error(`не удалось декодировать ${mimeType || 'аудио'}: ${(err as Error).message}`)
    }
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(this.analyser ?? ctx.destination)
    this.source = source
    await new Promise<void>((resolve) => {
      source.onended = () => {
        if (this.source === source) this.source = null
        resolve()
      }
      source.start()
    })
  }

  stop(): void {
    const source = this.source
    this.source = null
    if (source) {
      try {
        source.stop()
      } catch {
        // already finished
      }
    }
  }

  /** 0..1 loudness of the audio playing right now (measured, not a timer). */
  amplitude(): number {
    const analyser = this.analyser
    if (!analyser || !this.data.length) return 0
    analyser.getByteTimeDomainData(this.data)
    let sum = 0
    for (let i = 0; i < this.data.length; i++) {
      const value = (this.data[i] - 128) / 128
      sum += value * value
    }
    return Math.min(1, Math.sqrt(sum / this.data.length) * 3.2)
  }

  close(): void {
    this.stop()
    void this.ctx?.close()
    this.ctx = null
    this.analyser = null
    this.data = new Uint8Array(0)
  }
}
