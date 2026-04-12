import {
  lazy,
  Suspense,
  startTransition,
  type ChangeEvent,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  createChatCompletion,
  probeHermes,
  synthesizeSpeech,
  transcribeAudio,
  type HermesSettings,
} from './lib/hermes'
import {
  getStoredVrm,
  listStoredVrms,
  saveStoredVrm,
  type StoredVrmMeta,
} from './lib/vrmLibrary'
import { DEFAULT_VRM_NAME, VRM_ITEMS } from './appConfig'

const VrmStage = lazy(async () => {
  const module = await import('./components/VrmStage')
  return { default: module.VrmStage }
})

type UIMessage = {
  content: string
  id: string
  role: 'assistant' | 'user'
}

type InputMode = 'toggle' | 'ptt'
type RecordingState = 'idle' | 'hold' | 'toggle' | 'transcribing'
type LibraryVrmItem = {
  id: string
  name: string
  source: 'bundled' | 'uploaded'
  url?: string
}

type StoredSettings = HermesSettings & {
  inputMode: InputMode
  pttKey: string
  selectedVrmId: string
  sttEnabled: boolean
  ttsEnabled: boolean
}

type ConnectionState = 'idle' | 'connected' | 'failed'

const SETTINGS_KEY = 'agentvrm.hermes.settings'
const DEFAULT_VRM_ID = `bundled:${DEFAULT_VRM_NAME}`
const BUNDLED_VRM_ITEMS: LibraryVrmItem[] = VRM_ITEMS.map((item) => ({
  id: `bundled:${item.name}`,
  name: item.name,
  source: 'bundled',
  url: item.url,
}))

function defaultBaseUrl(): string {
  return ''
}

function createClientId(): string {
  const webCrypto = globalThis.crypto
  if (webCrypto?.randomUUID) {
    return webCrypto.randomUUID()
  }

  if (webCrypto?.getRandomValues) {
    const bytes = new Uint8Array(16)
    webCrypto.getRandomValues(bytes)
    const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }

  return `msg-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function loadSettings(): StoredSettings {
  const fallback: StoredSettings = {
    apiKey: '',
    baseUrl: defaultBaseUrl(),
    inputMode: 'ptt',
    model: 'hermes-agent',
    pttKey: 'CapsLock',
    selectedVrmId: DEFAULT_VRM_ID,
    sttEnabled: true,
    ttsEnabled: true,
  }

  if (typeof window === 'undefined') {
    return fallback
  }

  const raw = window.localStorage.getItem(SETTINGS_KEY)
  if (!raw) {
    return fallback
  }

  try {
    const parsed = JSON.parse(raw) as Partial<StoredSettings> & {
      selectedVrmName?: string
    }
    const shouldUseSameOriginHttps =
      window.location.protocol === 'https:' &&
      parsed.baseUrl?.trim() === `${window.location.protocol}//${window.location.hostname}:8642`
    const migratedBaseUrl =
      shouldUseSameOriginHttps
        ? window.location.origin
        : parsed.baseUrl?.trim()

    return {
      apiKey: parsed.apiKey ?? fallback.apiKey,
      baseUrl: migratedBaseUrl || fallback.baseUrl,
      inputMode: parsed.inputMode === 'toggle' ? 'toggle' : fallback.inputMode,
      model: fallback.model,
      pttKey: parsed.pttKey?.trim() || fallback.pttKey,
      selectedVrmId: normalizeStoredVrmId(
        typeof parsed.selectedVrmId === 'string' ? parsed.selectedVrmId : parsed.selectedVrmName,
      ) || fallback.selectedVrmId,
      sttEnabled: parsed.sttEnabled ?? fallback.sttEnabled,
      ttsEnabled: parsed.ttsEnabled ?? fallback.ttsEnabled,
    }
  } catch {
    return fallback
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return 'Something failed.'
}

function pickRecorderMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') {
    return undefined
  }

  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate))
}

function normalizeShortcut(shortcut: string): string {
  return shortcut.trim() || 'CapsLock'
}

function normalizeStoredVrmId(value: unknown): string {
  if (typeof value !== 'string') {
    return DEFAULT_VRM_ID
  }
  const trimmed = value.trim()
  if (!trimmed) {
    return DEFAULT_VRM_ID
  }
  if (trimmed.startsWith('bundled:') || trimmed.startsWith('uploaded:')) {
    return trimmed
  }
  return `bundled:${trimmed}`
}

function createUniqueVrmName(name: string, existingNames: Iterable<string>): string {
  const taken = new Set(Array.from(existingNames, (item) => item.toLowerCase()))
  const trimmed = name.trim() || 'avatar.vrm'
  if (!taken.has(trimmed.toLowerCase())) {
    return trimmed
  }

  const dotIndex = trimmed.lastIndexOf('.')
  const hasExtension = dotIndex > 0
  const base = hasExtension ? trimmed.slice(0, dotIndex) : trimmed
  const extension = hasExtension ? trimmed.slice(dotIndex) : ''

  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base} (${index})${extension}`
    if (!taken.has(candidate.toLowerCase())) {
      return candidate
    }
  }

  return `${base} (${Date.now()})${extension}`
}

function mapStoredMetaToLibraryItem(meta: StoredVrmMeta): LibraryVrmItem {
  return {
    id: meta.id,
    name: meta.name,
    source: 'uploaded',
  }
}

function matchesShortcut(event: KeyboardEvent, shortcut: string): boolean {
  const normalized = normalizeShortcut(shortcut).toLowerCase()
  return event.code.toLowerCase() === normalized || event.key.toLowerCase() === normalized
}

function MicIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M12 15a3 3 0 0 0 3-3V7a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3Z" fill="currentColor" />
      <path
        d="M6 11.5a.75.75 0 0 1 .75.75a5.25 5.25 0 0 0 10.5 0a.75.75 0 0 1 1.5 0a6.74 6.74 0 0 1-6 6.7V22h2.5a.75.75 0 0 1 0 1.5h-7a.75.75 0 0 1 0-1.5h2.5v-3.05a6.74 6.74 0 0 1-6-6.7a.75.75 0 0 1 .75-.75Z"
        fill="currentColor"
      />
    </svg>
  )
}

function SendIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path
        d="M3 20.5V14l8-2l-8-2V3.5L22 12L3 20.5Zm1.5-2.2L17.8 12L4.5 5.7V8.8L12 10.7v2.6L4.5 15.2v3.1Z"
        fill="currentColor"
      />
    </svg>
  )
}

function SettingsIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path
        d="M10.6 2h2.8l.5 2.4c.6.2 1.1.4 1.7.7l2.2-1.1l2 2l-1.1 2.2c.3.5.5 1.1.7 1.7L22 10.6v2.8l-2.4.5c-.2.6-.4 1.1-.7 1.7l1.1 2.2l-2 2l-2.2-1.1c-.5.3-1.1.5-1.7.7L13.4 22h-2.8l-.5-2.4a8.1 8.1 0 0 1-1.7-.7l-2.2 1.1l-2-2l1.1-2.2a8.1 8.1 0 0 1-.7-1.7L2 13.4v-2.8l2.4-.5c.2-.6.4-1.1.7-1.7L4 6.2l2-2l2.2 1.1c.5-.3 1.1-.5 1.7-.7L10.6 2Zm1.4 6a4 4 0 1 0 0 8a4 4 0 0 0 0-8Z"
        fill="currentColor"
      />
    </svg>
  )
}

export function App() {
  const [settings, setSettings] = useState<StoredSettings>(() => loadSettings())
  const [messages, setMessages] = useState<UIMessage[]>([])
  const [draft, setDraft] = useState('')
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null)
  const [activeVrmLabel, setActiveVrmLabel] = useState<string | null>(null)
  const [uploadedVrms, setUploadedVrms] = useState<LibraryVrmItem[]>([])
  const [busy, setBusy] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [recordingState, setRecordingState] = useState<RecordingState>('idle')
  const [mouthLevel, setMouthLevel] = useState(0)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTestBusy, setSettingsTestBusy] = useState(false)
  const [settingsTestStatus, setSettingsTestStatus] = useState<string | null>(null)
  const [connectionState, setConnectionState] = useState<ConnectionState>('idle')

  const audioRef = useRef<HTMLAudioElement | null>(null)
  const audioBlobUrlRef = useRef<string | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const meterFrameRef = useRef<number | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const recorderChunksRef = useRef<Blob[]>([])
  const mediaStreamRef = useRef<MediaStream | null>(null)
  const localVrmInputRef = useRef<HTMLInputElement | null>(null)
  const activeUploadedVrmUrlRef = useRef<string | null>(null)
  const pttShortcutActiveRef = useRef(false)

  const vrmItems = useMemo(
    () => [...BUNDLED_VRM_ITEMS, ...uploadedVrms],
    [uploadedVrms],
  )
  const selectedVrm = useMemo(
    () => vrmItems.find((item) => item.id === settings.selectedVrmId) ?? null,
    [settings.selectedVrmId, vrmItems],
  )
  const visibleMessages = useMemo(() => messages.slice(-3), [messages])
  const agentLabel = connectionState === 'connected' ? 'Assistant' : 'Hermes'

  const pendingIndicator = useMemo(() => {
    if (recordingState === 'hold') {
      return `Listening… release ${normalizeShortcut(settings.pttKey)} or the mic button.`
    }
    if (recordingState === 'toggle') {
      return 'Listening… tap the mic again to stop.'
    }
    if (recordingState === 'transcribing') {
      return 'Transcribing…'
    }
    if (busy) {
      return 'Hermes is responding…'
    }
    return null
  }, [busy, recordingState, settings.pttKey])

  useEffect(() => {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
  }, [settings])

  useEffect(() => {
    const audio = new Audio()
    audio.preload = 'auto'
    audioRef.current = audio

    const clearPlayback = () => {
      setMouthLevel(0)
      if (meterFrameRef.current !== null) {
        window.cancelAnimationFrame(meterFrameRef.current)
        meterFrameRef.current = null
      }
      if (audioBlobUrlRef.current) {
        URL.revokeObjectURL(audioBlobUrlRef.current)
        audioBlobUrlRef.current = null
      }
    }

    audio.addEventListener('ended', clearPlayback)
    audio.addEventListener('pause', () => {
      if (audio.ended) {
        clearPlayback()
      }
    })

    return () => {
      clearPlayback()
      audio.pause()
      audio.src = ''
      audio.removeEventListener('ended', clearPlayback)
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach((track) => track.stop())
      }
      if (audioContextRef.current) {
        void audioContextRef.current.close()
      }
      if (activeUploadedVrmUrlRef.current) {
        URL.revokeObjectURL(activeUploadedVrmUrlRef.current)
        activeUploadedVrmUrlRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    if (!settings.ttsEnabled) {
      const audio = audioRef.current
      if (audio) {
        audio.pause()
        audio.currentTime = 0
      }
      setMouthLevel(0)
    }
  }, [settings.ttsEnabled])

  const updateSetting = <K extends keyof StoredSettings>(key: K, value: StoredSettings[K]) => {
    setSettingsTestStatus(null)
    if (key === 'apiKey' || key === 'baseUrl') {
      setConnectionState('idle')
    }
    setSettings((current) => ({ ...current, [key]: value }))
  }

  useEffect(() => {
    let cancelled = false

    const loadUploadedVrms = async () => {
      try {
        const records = await listStoredVrms()
        if (cancelled) {
          return
        }
        setUploadedVrms(records.map(mapStoredMetaToLibraryItem))
      } catch (error) {
        if (!cancelled) {
          setErrorMessage(formatError(error))
        }
      }
    }

    void loadUploadedVrms()

    return () => {
      cancelled = true
    }
  }, [])

  const setActiveAvatar = useEffectEvent(async (item: LibraryVrmItem) => {
    if (activeUploadedVrmUrlRef.current) {
      URL.revokeObjectURL(activeUploadedVrmUrlRef.current)
      activeUploadedVrmUrlRef.current = null
    }

    if (item.source === 'bundled') {
      setAvatarUrl(item.url ?? null)
      setActiveVrmLabel(item.name)
      setErrorMessage(null)
      return
    }

    const record = await getStoredVrm(item.id)
    if (!record) {
      setUploadedVrms((current) => current.filter((entry) => entry.id !== item.id))
      throw new Error(`Stored VRM "${item.name}" is missing.`)
    }

    const objectUrl = URL.createObjectURL(record.file)
    activeUploadedVrmUrlRef.current = objectUrl
    setAvatarUrl(objectUrl)
    setActiveVrmLabel(record.name)
    setErrorMessage(null)
  })

  useEffect(() => {
    const fallback = vrmItems[0] ?? null
    if (!selectedVrm && fallback && fallback.id !== settings.selectedVrmId) {
      setSettings((current) => ({ ...current, selectedVrmId: fallback.id }))
      return
    }
    if (!selectedVrm && !fallback) {
      setErrorMessage('No VRMs available.')
      return
    }
    if (!avatarUrl) {
      const initialVrm = selectedVrm ?? fallback
      if (!initialVrm) {
        return
      }
      void setActiveAvatar(initialVrm).catch((error: unknown) => {
        setErrorMessage(formatError(error))
      })
    }
  }, [avatarUrl, selectedVrm, settings.selectedVrmId, setActiveAvatar, vrmItems])

  const ensureAudioPipeline = useEffectEvent(async () => {
    const audio = audioRef.current
    if (!audio) {
      throw new Error('Audio element is not ready.')
    }

    if (!audioContextRef.current) {
      const context = new AudioContext()
      const analyser = context.createAnalyser()
      analyser.fftSize = 256
      analyser.smoothingTimeConstant = 0.8
      const source = context.createMediaElementSource(audio)
      source.connect(analyser)
      analyser.connect(context.destination)
      audioContextRef.current = context
      analyserRef.current = analyser
    }

    if (audioContextRef.current?.state === 'suspended') {
      await audioContextRef.current.resume()
    }

    return audio
  })

  const testHermesConnection = useEffectEvent(async () => {
    if (settingsTestBusy) {
      return
    }

    if (!settings.baseUrl.trim()) {
      setConnectionState('failed')
      setSettingsTestStatus('Enter a Hermes URL first.')
      return
    }

    setSettingsTestBusy(true)
    setSettingsTestStatus('Testing…')

    try {
      const models = await probeHermes(settings)
      setConnectionState('connected')
      setSettingsTestStatus(models.length > 0 ? `Connected. ${models.length} model${models.length === 1 ? '' : 's'}.` : 'Connected.')
    } catch (error) {
      setConnectionState('failed')
      setSettingsTestStatus(formatError(error))
    } finally {
      setSettingsTestBusy(false)
    }
  })

  const tickMouthMeter = useEffectEvent(() => {
    const analyser = analyserRef.current
    const audio = audioRef.current
    if (!analyser || !audio || audio.paused) {
      setMouthLevel(0)
      return
    }

    const buffer = new Uint8Array(analyser.frequencyBinCount)
    const loop = () => {
      if (!analyserRef.current || !audioRef.current || audioRef.current.paused) {
        setMouthLevel(0)
        meterFrameRef.current = null
        return
      }

      analyser.getByteFrequencyData(buffer)
      const average = buffer.reduce((total, value) => total + value, 0) / (buffer.length * 255)
      setMouthLevel(Math.min(1, average * 2.6))
      meterFrameRef.current = window.requestAnimationFrame(loop)
    }

    if (meterFrameRef.current !== null) {
      window.cancelAnimationFrame(meterFrameRef.current)
    }
    meterFrameRef.current = window.requestAnimationFrame(loop)
  })

  const playSpeech = useEffectEvent(async (text: string) => {
    if (!settings.ttsEnabled || !text.trim()) {
      return
    }

    const audio = await ensureAudioPipeline()
    const blob = await synthesizeSpeech(settings, text)

    if (audioBlobUrlRef.current) {
      URL.revokeObjectURL(audioBlobUrlRef.current)
    }

    audioBlobUrlRef.current = URL.createObjectURL(blob)
    audio.pause()
    audio.src = audioBlobUrlRef.current
    audio.currentTime = 0
    await audio.play()
    tickMouthMeter()
  })

  const sendUserText = useEffectEvent(async (text: string) => {
    const trimmed = text.trim()
    if (!trimmed || busy) {
      return
    }

    if (!settings.baseUrl.trim()) {
      setConnectionState('failed')
      setErrorMessage('Enter a Hermes URL in Settings first.')
      return
    }

    const userMessage: UIMessage = {
      content: trimmed,
      id: createClientId(),
      role: 'user',
    }

    startTransition(() => {
      setMessages((current) => [...current, userMessage])
      setDraft('')
      setBusy(true)
      setErrorMessage(null)
    })

    try {
      const result = await createChatCompletion(settings, trimmed, '', sessionId)
      setConnectionState('connected')
      const assistantMessage: UIMessage = {
        content: result.content || '(No response returned.)',
        id: createClientId(),
        role: 'assistant',
      }

      startTransition(() => {
        setMessages((current) => [...current, assistantMessage])
        setSessionId(result.sessionId ?? sessionId)
      })

      if (settings.ttsEnabled) {
        void playSpeech(assistantMessage.content)
      }
    } catch (error) {
      setConnectionState('failed')
      setErrorMessage(formatError(error))
    } finally {
      setBusy(false)
    }
  })

  const stopRecording = useEffectEvent(() => {
    const recorder = mediaRecorderRef.current
    if (!recorder || recorder.state === 'inactive') {
      return
    }
    recorder.stop()
  })

  const startRecording = useEffectEvent(async (mode: 'hold' | 'toggle') => {
    if (!settings.sttEnabled || busy || recordingState === 'transcribing') {
      return
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setErrorMessage('This browser does not expose microphone capture.')
      return
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      return
    }

    setErrorMessage(null)

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      mediaStreamRef.current = stream
      recorderChunksRef.current = []

      const mimeType = pickRecorderMimeType()
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)
      mediaRecorderRef.current = recorder

      recorder.addEventListener('dataavailable', (event) => {
        if (event.data.size > 0) {
          recorderChunksRef.current.push(event.data)
        }
      })

      recorder.addEventListener(
        'stop',
        () => {
          const blob = new Blob(recorderChunksRef.current, {
            type: recorder.mimeType || 'audio/webm',
          })
          recorderChunksRef.current = []
          mediaRecorderRef.current = null

          if (mediaStreamRef.current) {
            mediaStreamRef.current.getTracks().forEach((track) => track.stop())
            mediaStreamRef.current = null
          }

          if (blob.size === 0) {
            setRecordingState('idle')
            return
          }

          void (async () => {
            try {
              setRecordingState('transcribing')
              const transcript = await transcribeAudio(settings, blob)
              if (!transcript) {
                throw new Error('Hermes returned an empty transcript.')
              }
              await sendUserText(transcript)
            } catch (error) {
              setErrorMessage(formatError(error))
            } finally {
              setRecordingState('idle')
            }
          })()
        },
        { once: true },
      )

      recorder.start()
      setRecordingState(mode)
    } catch (error) {
      setErrorMessage(formatError(error))
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach((track) => track.stop())
        mediaStreamRef.current = null
      }
      setRecordingState('idle')
    }
  })

  useEffect(() => {
    if (!settings.sttEnabled && (recordingState === 'hold' || recordingState === 'toggle')) {
      stopRecording()
    }
  }, [recordingState, settings.sttEnabled, stopRecording])

  useEffect(() => {
    if (!settings.sttEnabled || settings.inputMode !== 'ptt') {
      pttShortcutActiveRef.current = false
      return
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (!matchesShortcut(event, settings.pttKey) || event.repeat || pttShortcutActiveRef.current) {
        return
      }
      event.preventDefault()
      pttShortcutActiveRef.current = true
      void startRecording('hold')
    }

    const onKeyUp = (event: KeyboardEvent) => {
      if (!pttShortcutActiveRef.current || !matchesShortcut(event, settings.pttKey)) {
        return
      }
      event.preventDefault()
      pttShortcutActiveRef.current = false
      stopRecording()
    }

    const onBlur = () => {
      if (pttShortcutActiveRef.current) {
        pttShortcutActiveRef.current = false
        stopRecording()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)

    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [settings.inputMode, settings.pttKey, settings.sttEnabled, startRecording, stopRecording])

  const loadSelectedVrm = useEffectEvent(async () => {
    if (!selectedVrm) {
      setErrorMessage('No VRM is available to load.')
      return
    }
    await setActiveAvatar(selectedVrm)
    setSettingsOpen(false)
  })

  const openLocalVrmPicker = useEffectEvent(() => {
    localVrmInputRef.current?.click()
  })

  const loadLocalVrm = useEffectEvent(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''

    if (!file) {
      return
    }

    if (!file.name.toLowerCase().endsWith('.vrm')) {
      setErrorMessage('Pick a .vrm file.')
      return
    }

    const nextName = createUniqueVrmName(file.name, vrmItems.map((item) => item.name))
    const nextItem: LibraryVrmItem = {
      id: `uploaded:${createClientId()}`,
      name: nextName,
      source: 'uploaded',
    }

    try {
      await saveStoredVrm({
        file,
        id: nextItem.id,
        name: nextName,
        updatedAt: Date.now(),
      })
      setUploadedVrms((current) => [...current, nextItem].sort((left, right) => left.name.localeCompare(right.name)))
      setSettings((current) => ({ ...current, selectedVrmId: nextItem.id }))
      await setActiveAvatar(nextItem)
      setSettingsOpen(false)
    } catch (error) {
      setErrorMessage(formatError(error))
    }
  })

  const micActive = recordingState === 'hold' || recordingState === 'toggle'
  const micDisabled = !settings.sttEnabled || busy || recordingState === 'transcribing'
  const emptyStateLabel =
    connectionState === 'connected' ? 'Hermes is ready.' : 'Hermes not connected.'

  return (
    <main className="app-shell">
      <Suspense fallback={<section className="vrm-stage vrm-stage--loading" />}>
        <VrmStage avatarUrl={avatarUrl} mouthLevel={mouthLevel} />
      </Suspense>

      <button
        className="settings-button"
        onClick={() => setSettingsOpen(true)}
        type="button"
      >
        <SettingsIcon />
        <span>Settings</span>
      </button>

      <section className="chat-strip">
        <div className="chat-strip__gradient" />
        <div className="chat-strip__panel">
          <div className="chat-strip__scroll">
            {visibleMessages.length === 0 ? (
              <div className="chat-strip__empty">{emptyStateLabel}</div>
            ) : (
              visibleMessages.map((message) => (
                <article className={`chat-line chat-line--${message.role}`} key={message.id}>
                  <span className="chat-line__role">{message.role === 'user' ? 'You' : agentLabel}</span>
                  <p>{message.content}</p>
                </article>
              ))
            )}
          </div>
          {pendingIndicator ? <div className="chat-strip__status">{pendingIndicator}</div> : null}
          {errorMessage ? <div className="chat-strip__error">{errorMessage}</div> : null}
        </div>
      </section>

      <form
        className="input-dock"
        onSubmit={(event) => {
          event.preventDefault()
          void sendUserText(draft)
        }}
      >
        <button
          aria-label={settings.inputMode === 'toggle' ? 'Toggle microphone' : 'Push to talk'}
          className={`icon-button ${micActive ? 'is-active' : ''}`}
          disabled={micDisabled}
          onClick={() => {
            if (settings.inputMode !== 'toggle') {
              return
            }
            if (recordingState === 'toggle') {
              stopRecording()
            } else {
              void startRecording('toggle')
            }
          }}
          onPointerDown={() => {
            if (settings.inputMode === 'ptt') {
              void startRecording('hold')
            }
          }}
          onPointerUp={() => {
            if (settings.inputMode === 'ptt') {
              stopRecording()
            }
          }}
          onPointerCancel={() => {
            if (settings.inputMode === 'ptt') {
              stopRecording()
            }
          }}
          type="button"
        >
          <MicIcon />
        </button>

        <input
          autoComplete="off"
          className="input-dock__field"
          placeholder="Message"
          type="text"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />

        <button
          aria-label="Send message"
          className="icon-button"
          disabled={busy || !draft.trim()}
          type="submit"
        >
          <SendIcon />
        </button>
      </form>

      {settingsOpen ? (
        <div
          className="modal-backdrop"
          onClick={() => setSettingsOpen(false)}
          role="presentation"
        >
          <form
            className="settings-modal"
            onClick={(event) => event.stopPropagation()}
            onSubmit={(event) => event.preventDefault()}
          >
            <div className="settings-modal__header">
              <h2>Settings</h2>
              <button
                className="text-button"
                onClick={() => setSettingsOpen(false)}
                type="button"
              >
                Close
              </button>
            </div>

            <label className="field">
              <span>Hermes URL</span>
              <input
                name="hermes-url"
                type="text"
                value={settings.baseUrl}
                onChange={(event) => updateSetting('baseUrl', event.target.value)}
              />
            </label>

            <label className="field">
              <span>Hermes API key</span>
              <input
                autoComplete="off"
                name="hermes-api-key"
                type="password"
                value={settings.apiKey}
                onChange={(event) => updateSetting('apiKey', event.target.value)}
              />
            </label>

            <div className="settings-actions">
              <button
                className="text-button"
                disabled={settingsTestBusy}
                onClick={() => void testHermesConnection()}
                type="button"
              >
                {settingsTestBusy ? 'Testing' : 'Test'}
              </button>
              {settingsTestStatus ? <div className="settings-status">{settingsTestStatus}</div> : null}
            </div>

            <label className="field">
              <span>VRM</span>
              <select
                value={settings.selectedVrmId}
                onChange={(event) => updateSetting('selectedVrmId', event.target.value)}
              >
                {vrmItems.length === 0 ? (
                  <option value="">No VRMs found</option>
                ) : (
                  vrmItems.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))
                )}
              </select>
            </label>

            <div className="settings-button-row">
              <button
                className="text-button text-button--primary"
                disabled={!selectedVrm}
                onClick={() => void loadSelectedVrm()}
                type="button"
              >
                Load Selected
              </button>
              <button
                className="text-button"
                onClick={() => openLocalVrmPicker()}
                type="button"
              >
                Upload VRM
              </button>
            </div>
            <input
              accept=".vrm"
              className="hidden-file-input"
              onChange={(event) => void loadLocalVrm(event)}
              ref={localVrmInputRef}
              type="file"
            />
            {activeVrmLabel ? <div className="settings-status">Loaded: {activeVrmLabel}</div> : null}

            <div className="toggle-grid">
              <label className="check-row">
                <input
                  checked={settings.ttsEnabled}
                  type="checkbox"
                  onChange={(event) => updateSetting('ttsEnabled', event.target.checked)}
                />
                <span>TTS enabled</span>
              </label>

              <label className="check-row">
                <input
                  checked={settings.sttEnabled}
                  type="checkbox"
                  onChange={(event) => updateSetting('sttEnabled', event.target.checked)}
                />
                <span>STT enabled</span>
              </label>
            </div>

            <label className="field">
              <span>Mic mode</span>
              <select
                value={settings.inputMode}
                onChange={(event) => updateSetting('inputMode', event.target.value as InputMode)}
              >
                <option value="toggle">Toggle</option>
                <option value="ptt">Push to talk</option>
              </select>
            </label>

            <label className="field">
              <span>PTT shortcut</span>
              <input
                name="ptt-shortcut"
                type="text"
                value={settings.pttKey}
                onChange={(event) => updateSetting('pttKey', event.target.value)}
              />
            </label>
          </form>
        </div>
      ) : null}
    </main>
  )
}
