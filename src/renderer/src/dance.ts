/**
 * Dance driver: a Web Audio AnalyserNode on the microphone feeds bone motion.
 * Without microphone access it falls back to a synthetic 2 Hz beat so the
 * dance mode still works.
 */
export class DanceAudio {
  private ctx: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private stream: MediaStream | null = null
  private data = new Uint8Array(0)
  private smoothing = 0

  get usingMicrophone(): boolean {
    return !!this.analyser
  }

  /** Returns true when the microphone analyser is live. */
  async start(deviceId: string): Promise<boolean> {
    this.stop()
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: deviceId ? { deviceId: { exact: deviceId } } : true
      })
      const ctx = new AudioContext()
      const source = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 512
      analyser.smoothingTimeConstant = 0.72
      source.connect(analyser)
      this.stream = stream
      this.ctx = ctx
      this.analyser = analyser
      this.data = new Uint8Array(analyser.frequencyBinCount)
      return true
    } catch {
      this.stop()
      return false
    }
  }

  stop(): void {
    this.stream?.getTracks().forEach((track) => track.stop())
    void this.ctx?.close()
    this.stream = null
    this.ctx = null
    this.analyser = null
    this.data = new Uint8Array(0)
  }

  /** 0..1 loudness used to scale the procedural moves. */
  energy(t: number): number {
    if (this.analyser && this.data.length) {
      this.analyser.getByteFrequencyData(this.data)
      let bass = 0
      for (let i = 1; i <= 12; i++) bass += this.data[i]
      let mid = 0
      for (let i = 13; i <= 40; i++) mid += this.data[i]
      bass /= 12 * 255
      mid /= 28 * 255
      const raw = Math.min(1, bass * 0.8 + mid * 0.45)
      this.smoothing += (raw - this.smoothing) * 0.35
      return this.smoothing
    }
    // Fallback beat: 2 Hz pulse, no microphone required.
    const beat = Math.sin(t * Math.PI * 4)
    return 0.4 + 0.35 * Math.max(0, beat)
  }
}
