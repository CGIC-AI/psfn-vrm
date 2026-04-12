import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import {
  VRM,
  VRMExpressionPresetName,
  VRMHumanBoneName,
  VRMLoaderPlugin,
  VRMUtils,
} from '@pixiv/three-vrm'

type VrmStageProps = {
  avatarUrl: string | null
  mouthLevel: number
}

type ViewerRuntime = {
  camera: THREE.PerspectiveCamera
  controls: OrbitControls
  lookTarget: THREE.Object3D
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
}

type IdleBone = {
  node: THREE.Object3D
  restEuler: THREE.Euler
  restPosition: THREE.Vector3
}

type IdleRig = {
  chest: IdleBone | null
  head: IdleBone | null
  hips: IdleBone | null
  leftLowerArm: IdleBone | null
  leftShoulder: IdleBone | null
  leftUpperArm: IdleBone | null
  neck: IdleBone | null
  rightLowerArm: IdleBone | null
  rightShoulder: IdleBone | null
  rightUpperArm: IdleBone | null
  spine: IdleBone | null
}

type FramingState = {
  headY: number
  lookAtY: number
  torsoHeight: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function captureBone(node: THREE.Object3D | null): IdleBone | null {
  if (!node) {
    return null
  }

  return {
    node,
    restEuler: node.rotation.clone(),
    restPosition: node.position.clone(),
  }
}

function resetBone(bone: IdleBone | null) {
  if (!bone) {
    return
  }

  bone.node.position.copy(bone.restPosition)
  bone.node.rotation.copy(bone.restEuler)
}

function offsetRestEuler(bone: IdleBone | null, x: number, y: number, z: number) {
  if (!bone) {
    return
  }

  bone.restEuler.x += x
  bone.restEuler.y += y
  bone.restEuler.z += z
}

function getBoneWorldPosition(vrm: VRM, name: (typeof VRMHumanBoneName)[keyof typeof VRMHumanBoneName]): THREE.Vector3 | null {
  const node = vrm.humanoid.getRawBoneNode(name)
  if (!node) {
    return null
  }

  return node.getWorldPosition(new THREE.Vector3())
}

function fitCameraToAvatar(runtime: ViewerRuntime, vrm: VRM): FramingState {
  vrm.scene.updateMatrixWorld(true)

  const box = new THREE.Box3().setFromObject(vrm.scene)
  const size = box.getSize(new THREE.Vector3())
  const center = box.getCenter(new THREE.Vector3())

  vrm.scene.position.x -= center.x
  vrm.scene.position.y -= box.min.y
  vrm.scene.updateMatrixWorld(true)

  const headPosition =
    getBoneWorldPosition(vrm, VRMHumanBoneName.Head) ??
    new THREE.Vector3(0, size.y * 0.86, 0)
  const hipsPosition =
    getBoneWorldPosition(vrm, VRMHumanBoneName.Hips) ??
    new THREE.Vector3(0, size.y * 0.52, 0)

  const torsoHeight = Math.max(0.7, headPosition.y - hipsPosition.y)
  const targetY = headPosition.y - torsoHeight * 0.14
  const distance = clamp(torsoHeight * 3.15, 2.05, 3.2)

  runtime.camera.position.set(0, targetY, distance)
  runtime.camera.lookAt(0, targetY, 0)

  runtime.controls.target.set(0, targetY, 0)
  runtime.controls.minDistance = distance * 0.65
  runtime.controls.maxDistance = distance * 2.4
  runtime.controls.update()
  runtime.lookTarget.position.set(0, headPosition.y - torsoHeight * 0.08, 0.8)

  return {
    headY: headPosition.y,
    lookAtY: targetY,
    torsoHeight,
  }
}

function computeBlink(timeSeconds: number): number {
  const primary = timeSeconds % 4.8
  const secondary = (timeSeconds + 1.1) % 8.6

  const curve = (phase: number, up: number, down: number) => {
    if (phase < up) {
      return phase / up
    }
    if (phase < up + down) {
      return 1 - (phase - up) / down
    }
    return 0
  }

  return Math.max(curve(primary, 0.065, 0.1), curve(secondary, 0.04, 0.08) * 0.55)
}

export function VrmStage({ avatarUrl, mouthLevel }: VrmStageProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const runtimeRef = useRef<ViewerRuntime | null>(null)
  const currentVrmRef = useRef<VRM | null>(null)
  const mouthLevelRef = useRef(0)
  const idleRigRef = useRef<IdleRig | null>(null)
  const framingRef = useRef<FramingState | null>(null)
  const frameRef = useRef<number | null>(null)
  const [status, setStatus] = useState('Loading avatar…')

  useEffect(() => {
    mouthLevelRef.current = mouthLevel
  }, [mouthLevel])

  useEffect(() => {
    const container = containerRef.current
    if (!container) {
      return
    }

    const scene = new THREE.Scene()
    scene.background = null

    const camera = new THREE.PerspectiveCamera(20, 1, 0.1, 50)
    camera.position.set(0, 1.3, 1.7)

    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.domElement.className = 'vrm-stage__canvas'
    container.replaceChildren(renderer.domElement)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.enablePan = true
    controls.screenSpacePanning = true
    controls.rotateSpeed = 0.55
    controls.zoomSpeed = 0.9
    controls.minPolarAngle = 0.95
    controls.maxPolarAngle = 1.82

    scene.add(new THREE.AmbientLight(0xf4efe8, 1.1))

    const keyLight = new THREE.DirectionalLight(0xfff0d8, 1.65)
    keyLight.position.set(1.5, 2.7, 2.8)
    scene.add(keyLight)

    const fillLight = new THREE.DirectionalLight(0xbfd7ff, 0.85)
    fillLight.position.set(-1.6, 1.85, 1.2)
    scene.add(fillLight)

    const rimLight = new THREE.DirectionalLight(0x7ba6ff, 0.48)
    rimLight.position.set(-1.3, 1.9, -1.8)
    scene.add(rimLight)

    const lookTarget = new THREE.Object3D()
    lookTarget.position.set(0, 1.35, 0.8)
    scene.add(lookTarget)

    const resize = () => {
      const width = Math.max(container.clientWidth, 320)
      const height = Math.max(container.clientHeight, 320)
      camera.aspect = width / height
      camera.updateProjectionMatrix()
      renderer.setSize(width, height, false)
    }

    resize()
    window.addEventListener('resize', resize)

    const clock = new THREE.Clock()
    const lookTargetPosition = new THREE.Vector3()
    const renderFrame = () => {
      const runtime = runtimeRef.current
      const vrm = currentVrmRef.current
      frameRef.current = window.requestAnimationFrame(renderFrame)

      if (vrm && runtime) {
        const elapsed = clock.elapsedTime
        const delta = clock.getDelta()
        const idleRig = idleRigRef.current
        const framing = framingRef.current

        resetBone(idleRig?.hips ?? null)
        resetBone(idleRig?.spine ?? null)
        resetBone(idleRig?.chest ?? null)
        resetBone(idleRig?.neck ?? null)
        resetBone(idleRig?.head ?? null)
        resetBone(idleRig?.leftShoulder ?? null)
        resetBone(idleRig?.rightShoulder ?? null)
        resetBone(idleRig?.leftUpperArm ?? null)
        resetBone(idleRig?.rightUpperArm ?? null)
        resetBone(idleRig?.leftLowerArm ?? null)
        resetBone(idleRig?.rightLowerArm ?? null)

        const breath = Math.sin(elapsed * 1.35)
        const sway = Math.sin(elapsed * 0.8)
        const swaySlow = Math.sin(elapsed * 0.42 + 0.8)
        const headFloat = Math.sin(elapsed * 0.58 + 1.4)
        const blink = computeBlink(elapsed)
        const mouth = clamp(mouthLevelRef.current, 0, 1)

        if (idleRig?.hips) {
          idleRig.hips.node.position.y += breath * 0.006
          idleRig.hips.node.rotation.z += sway * 0.028
          idleRig.hips.node.rotation.y += swaySlow * 0.03
        }
        if (idleRig?.spine) {
          idleRig.spine.node.rotation.z -= sway * 0.016
          idleRig.spine.node.rotation.x += breath * 0.012
        }
        if (idleRig?.chest) {
          idleRig.chest.node.rotation.z -= sway * 0.022
          idleRig.chest.node.rotation.x += breath * 0.02
          idleRig.chest.node.rotation.y += swaySlow * 0.018
        }
        if (idleRig?.neck) {
          idleRig.neck.node.rotation.y += swaySlow * 0.022
          idleRig.neck.node.rotation.x += headFloat * 0.01
        }
        if (idleRig?.head) {
          idleRig.head.node.rotation.y += swaySlow * 0.03
          idleRig.head.node.rotation.z -= sway * 0.018
          idleRig.head.node.rotation.x += headFloat * 0.012
        }
        if (idleRig?.leftShoulder) {
          idleRig.leftShoulder.node.rotation.z += sway * 0.01
        }
        if (idleRig?.rightShoulder) {
          idleRig.rightShoulder.node.rotation.z -= sway * 0.01
        }
        if (idleRig?.leftUpperArm) {
          idleRig.leftUpperArm.node.rotation.y += swaySlow * 0.02
        }
        if (idleRig?.rightUpperArm) {
          idleRig.rightUpperArm.node.rotation.y -= swaySlow * 0.02
        }

        vrm.expressionManager?.setValue(VRMExpressionPresetName.Aa, mouth)
        vrm.expressionManager?.setValue(VRMExpressionPresetName.Oh, mouth * 0.32)
        vrm.expressionManager?.setValue(VRMExpressionPresetName.Ou, mouth * 0.12)
        vrm.expressionManager?.setValue(VRMExpressionPresetName.Blink, blink)
        vrm.expressionManager?.setValue(VRMExpressionPresetName.BlinkLeft, blink * 0.65)
        vrm.expressionManager?.setValue(VRMExpressionPresetName.BlinkRight, blink * 0.65)

        if (vrm.lookAt && framing) {
          lookTargetPosition.set(
            Math.sin(elapsed * 0.33) * 0.06,
            framing.headY - 0.08 + Math.cos(elapsed * 0.29) * 0.03,
            0.82 + Math.sin(elapsed * 0.18) * 0.04,
          )
          runtime.lookTarget.position.lerp(lookTargetPosition, 0.08)
          vrm.lookAt.target = runtime.lookTarget
        }

        vrm.update(delta)
      } else {
        clock.getDelta()
      }

      runtime?.controls.update()
      renderer.render(scene, camera)
    }

    runtimeRef.current = { camera, controls, lookTarget, renderer, scene }
    renderFrame()

    return () => {
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current)
      }
      window.removeEventListener('resize', resize)
      if (currentVrmRef.current) {
        scene.remove(currentVrmRef.current.scene)
        VRMUtils.deepDispose(currentVrmRef.current.scene)
        currentVrmRef.current = null
      }
      controls.dispose()
      renderer.dispose()
      container.replaceChildren()
      runtimeRef.current = null
    }
  }, [])

  useEffect(() => {
    const runtime = runtimeRef.current
    if (!runtime) {
      return
    }

    if (!avatarUrl) {
      if (currentVrmRef.current) {
        runtime.scene.remove(currentVrmRef.current.scene)
        VRMUtils.deepDispose(currentVrmRef.current.scene)
        currentVrmRef.current = null
      }
      setStatus('No avatar loaded.')
      return
    }

    let cancelled = false
    const loader = new GLTFLoader()
    loader.register((parser) => new VRMLoaderPlugin(parser))
    setStatus('Loading avatar…')

    loader.load(
      avatarUrl,
      (gltf: GLTF) => {
        if (cancelled) {
          return
        }

        const vrm = gltf.userData.vrm as VRM | undefined
        if (!vrm) {
          setStatus('This file is not a VRM.')
          return
        }

        if (currentVrmRef.current) {
          runtime.scene.remove(currentVrmRef.current.scene)
          VRMUtils.deepDispose(currentVrmRef.current.scene)
        }

        VRMUtils.removeUnnecessaryVertices(gltf.scene)
        VRMUtils.removeUnnecessaryJoints(gltf.scene)
        VRMUtils.rotateVRM0(vrm)

        vrm.scene.position.set(0, 0, 0)
        vrm.scene.rotation.set(0, Math.PI, 0)
        runtime.scene.add(vrm.scene)
        vrm.scene.updateMatrixWorld(true)

        framingRef.current = fitCameraToAvatar(runtime, vrm)
        const idleRig: IdleRig = {
          chest: captureBone(vrm.humanoid.getNormalizedBoneNode(VRMHumanBoneName.UpperChest) ?? vrm.humanoid.getNormalizedBoneNode(VRMHumanBoneName.Chest)),
          head: captureBone(vrm.humanoid.getNormalizedBoneNode(VRMHumanBoneName.Head)),
          hips: captureBone(vrm.humanoid.getNormalizedBoneNode(VRMHumanBoneName.Hips)),
          leftLowerArm: captureBone(vrm.humanoid.getNormalizedBoneNode(VRMHumanBoneName.LeftLowerArm)),
          leftShoulder: captureBone(vrm.humanoid.getNormalizedBoneNode(VRMHumanBoneName.LeftShoulder)),
          leftUpperArm: captureBone(vrm.humanoid.getNormalizedBoneNode(VRMHumanBoneName.LeftUpperArm)),
          neck: captureBone(vrm.humanoid.getNormalizedBoneNode(VRMHumanBoneName.Neck)),
          rightLowerArm: captureBone(vrm.humanoid.getNormalizedBoneNode(VRMHumanBoneName.RightLowerArm)),
          rightShoulder: captureBone(vrm.humanoid.getNormalizedBoneNode(VRMHumanBoneName.RightShoulder)),
          rightUpperArm: captureBone(vrm.humanoid.getNormalizedBoneNode(VRMHumanBoneName.RightUpperArm)),
          spine: captureBone(vrm.humanoid.getNormalizedBoneNode(VRMHumanBoneName.Spine)),
        }
        offsetRestEuler(idleRig.leftShoulder, 0, 0, 0.08)
        offsetRestEuler(idleRig.rightShoulder, 0, 0, -0.08)
        offsetRestEuler(idleRig.leftUpperArm, 0, 0.12, 1.18)
        offsetRestEuler(idleRig.rightUpperArm, 0, -0.12, -1.18)
        offsetRestEuler(idleRig.leftLowerArm, -0.08, 0, 0.34)
        offsetRestEuler(idleRig.rightLowerArm, -0.08, 0, -0.34)
        idleRigRef.current = idleRig

        currentVrmRef.current = vrm
        setStatus('Avatar ready.')
      },
      undefined,
      (error) => {
        if (!cancelled) {
          setStatus(error instanceof Error ? error.message : 'Failed to load avatar.')
        }
      },
    )

    return () => {
      cancelled = true
    }
  }, [avatarUrl])

  return (
    <section className="vrm-stage">
      <div className="vrm-stage__backdrop" />
      <div className="vrm-stage__viewport" ref={containerRef} />
      {status !== 'Avatar ready.' ? <div className="vrm-stage__status">{status}</div> : null}
    </section>
  )
}
