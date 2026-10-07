import * as THREE from 'three'
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm'

type BoneName = Parameters<VRM['humanoid']['getNormalizedBoneNode']>[0]

/** ~70 degrees down from the T-pose, plus a slight elbow bend. */
const ARM_DOWN = 1.22
const ELBOW_BEND = 0.3

export interface AvatarState {
  /** seconds since start */
  t: number
  /** -1..1, cursor to the right */
  yaw: number
  /** -1..1, cursor below */
  pitch: number
  /** 0..1 mouth opening while speaking */
  mouth: number
  /** 0..1 audio energy from the analyser */
  energy: number
}

/**
 * Wraps a VRM model: idle breathing/blinking, mouse look-at, lip-sync and the
 * procedural dance driven by the analyser energy.
 * Works for both VRM 0.x and 1.0 models (three-vrm migrates 0.x on load).
 */
export class VrmAvatar {
  readonly scene = new THREE.Scene()
  vrm: VRM | null = null

  private lookTarget = new THREE.Object3D()
  private expr: Record<'mouth' | 'blink' | 'happy', string | null> = { mouth: null, blink: null, happy: null }
  private blinkTimer = 1.5 + Math.random() * 3
  private blinkProgress = -1
  private yawSign = 1
  private pitchSign = 1
  private danceAmt = 0
  private danceTarget = 0

  constructor() {
    // MToon models are easy to overexpose: one key light plus soft ambient.
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.6))
    const key = new THREE.DirectionalLight(0xffffff, 1.0)
    key.position.set(1, 2, 1.5)
    this.scene.add(key)
    this.scene.add(this.lookTarget)
  }

  /** Parses .vrm bytes that were read by the main process. */
  async load(data: ArrayBuffer, sourcePath: string): Promise<void> {
    const loader = new GLTFLoader()
    loader.register((parser) => new VRMLoaderPlugin(parser))

    let gltf: GLTF
    try {
      gltf = await loader.parseAsync(data, '')
    } catch (err) {
      console.error('[vrm] не удалось разобрать модель', sourcePath, err)
      throw new Error(`${(err as Error)?.message ?? String(err)} (файл: ${sourcePath})`)
    }

    const vrm = gltf.userData.vrm as VRM | undefined
    if (!vrm) throw new Error(`В файле нет VRM-данных: ${sourcePath}`)

    // VRM 0.x models face the other way: rotateVRM0() is a no-op for VRM 1.0.
    VRMUtils.rotateVRM0(vrm)

    // Geometry optimisations from the three-vrm docs (morphs are left untouched,
    // combineMorphs would merge the blendshape targets lip-sync relies on).
    VRMUtils.removeUnnecessaryVertices(gltf.scene)
    VRMUtils.combineSkeletons(gltf.scene)
    gltf.scene.traverse((obj) => {
      obj.frustumCulled = false
    })

    this.vrm = vrm
    this.scene.add(vrm.scene)
    vrm.scene.updateMatrixWorld(true)

    if (vrm.lookAt) {
      vrm.lookAt.target = this.lookTarget
      vrm.lookAt.autoUpdate = true
    }

    this.resolveExpressions()
    this.computeLookSigns()
    this.logMaterials()
    this.applyIdlePose()
  }

  /** Prints what the loader actually produced, so missing textures are visible. */
  private logMaterials(): void {
    const seen = new Map<string, number>()
    this.vrm?.scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh
      if (!mesh.isMesh) return
      const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const material of list) {
        const mat = material as THREE.Material & { map?: THREE.Texture | null; color?: THREE.Color }
        const key =
          `${mat.type} "${mat.name}" map=${!!mat.map} image=${!!mat.map?.image} ` +
          `color=#${mat.color ? mat.color.getHexString() : 'n/a'}`
        seen.set(key, (seen.get(key) ?? 0) + 1)
      }
    })
    for (const [key, count] of seen) console.log(`[vrm] материал: ${key} (x${count})`)
  }

  /** Relaxed A-pose: VRoid exports a T-pose, so the arms hang down. */
  private applyIdlePose(): void {
    const set = (name: BoneName, x: number, y: number, z: number): void => {
      const bone = this.vrm?.humanoid.getNormalizedBoneNode(name)
      if (bone) bone.rotation.set(x, y, z)
    }
    set('leftUpperArm', 0, 0, ARM_DOWN)
    set('rightUpperArm', 0, 0, -ARM_DOWN)
    set('leftLowerArm', 0, 0, ELBOW_BEND)
    set('rightLowerArm', 0, 0, -ELBOW_BEND)
  }

  setDanceTarget(on: boolean): void {
    this.danceTarget = on ? 1 : 0
  }

  /** VRM 1.0 renamed the presets, VRM 0.x keeps A/Blink/Joy. Resolve whichever exists. */
  private resolveExpressions(): void {
    const manager = this.vrm?.expressionManager
    const pick = (...names: string[]): string | null => {
      if (!manager) return null
      for (const name of names) if (manager.getExpression(name)) return name
      return null
    }
    this.expr = {
      mouth: pick('aa', 'A'),
      blink: pick('blink', 'Blink'),
      happy: pick('happy', 'Joy')
    }
    console.log(`[vrm] мимика: рот=${this.expr.mouth} моргание=${this.expr.blink} радость=${this.expr.happy}`)
  }

  /** Derives bone-space signs from the loaded rig so mouse look works for any export. */
  private computeLookSigns(): void {
    const head = this.vrm?.humanoid.getNormalizedBoneNode('head')
    if (!head) return
    const q = new THREE.Quaternion()
    head.getWorldQuaternion(q)
    const localX = new THREE.Vector3(1, 0, 0).applyQuaternion(q)
    const noseLocal = new THREE.Vector3(0, 0, 1).applyQuaternion(q.invert())
    const zSign = Math.sign(noseLocal.z) || 1
    this.yawSign = zSign * (Math.sign(localX.x) || 1)
    this.pitchSign = zSign
  }

  private rot(name: BoneName, x: number, y: number, z: number, dt: number, speed: number): void {
    const bone = this.vrm?.humanoid.getNormalizedBoneNode(name)
    if (!bone) return
    const k = Math.min(1, dt * speed)
    bone.rotation.x += (x - bone.rotation.x) * k
    bone.rotation.y += (y - bone.rotation.y) * k
    bone.rotation.z += (z - bone.rotation.z) * k
  }

  private computeBlink(dt: number): number {
    this.blinkTimer -= dt
    if (this.blinkTimer <= 0) {
      this.blinkTimer = 2 + Math.random() * 4
      this.blinkProgress = 0
    }
    if (this.blinkProgress < 0) return 0
    this.blinkProgress += dt / 0.13
    if (this.blinkProgress >= 1) {
      this.blinkProgress = -1
      return 0
    }
    return Math.sin(this.blinkProgress * Math.PI)
  }

  update(dt: number, state: AvatarState): void {
    const vrm = this.vrm
    if (!vrm) return
    const t = state.t

    this.danceAmt += (this.danceTarget - this.danceAmt) * Math.min(1, dt * 3)
    const dance = this.danceAmt
    const idle = 1 - dance
    const energy = state.energy

    // Eyes (and the head, via the model's own look-at rig).
    this.lookTarget.position.set(state.yaw * 1.7, 1.38 - state.pitch * 1.1, 1.4)

    const breathe = Math.sin(t * 1.5)
    const sway = Math.sin(t * 0.55)
    const beat = t * 8
    const amp = dance * (0.4 + 0.6 * energy)

    let headX = 0.02 * breathe * idle + state.pitch * this.pitchSign * 0.3
    let headY = state.yaw * this.yawSign * 0.4
    let headZ = 0.02 * sway * idle
    let chestX = 0.015 * breathe * idle
    let spineZ = 0.01 * sway * idle
    let hipsY = 0
    let hipsZ = 0
    let lArmX = 0.02 * breathe * idle
    let rArmX = 0.02 * breathe * idle
    // Idle keeps the arms down; dance blends towards a raised-arm pose.
    let lArmZ = ARM_DOWN * idle
    let rArmZ = -ARM_DOWN * idle
    let lElbow = ELBOW_BEND * idle
    let rElbow = -ELBOW_BEND * idle

    if (dance > 0.001) {
      headY += 0.3 * amp * Math.sin(beat * 0.5)
      headX += 0.1 * amp * Math.sin(beat)
      headZ += 0.14 * amp * Math.sin(beat)
      chestX += 0.06 * amp * Math.sin(beat * 2)
      spineZ += 0.12 * amp * Math.sin(beat * 0.5)
      hipsY += 0.08 * amp * Math.sin(beat * 0.5)
      hipsZ += 0.08 * amp * Math.sin(beat)
      lArmZ = -0.9 * amp * (0.55 + 0.45 * Math.sin(beat))
      rArmZ = 0.9 * amp * (0.55 + 0.45 * Math.sin(beat + Math.PI))
      lArmX = 0.4 * amp * Math.sin(beat * 0.5)
      rArmX = 0.4 * amp * Math.sin(beat * 0.5 + 1.7)
      lElbow = -0.7 * amp
      rElbow = 0.7 * amp
    }

    this.rot('hips', 0, hipsY, hipsZ, dt, 8)
    this.rot('spine', 0, 0, spineZ, dt, 8)
    this.rot('chest', chestX, 0, 0, dt, 8)
    this.rot('head', headX, headY, headZ, dt, 14)
    this.rot('leftUpperArm', lArmX, 0, lArmZ, dt, 10)
    this.rot('rightUpperArm', rArmX, 0, rArmZ, dt, 10)
    this.rot('leftLowerArm', lElbow, 0, 0, dt, 10)
    this.rot('rightLowerArm', rElbow, 0, 0, dt, 10)

    vrm.scene.position.y = dance * Math.abs(Math.sin(beat * 0.5)) * 0.03

    const manager = vrm.expressionManager
    if (manager) {
      if (this.expr.mouth) manager.setValue(this.expr.mouth, THREE.MathUtils.clamp(state.mouth, 0, 1))
      if (this.expr.blink) manager.setValue(this.expr.blink, this.computeBlink(dt))
      if (this.expr.happy) manager.setValue(this.expr.happy, dance * 0.85)
    }

    vrm.update(dt)
  }
}
