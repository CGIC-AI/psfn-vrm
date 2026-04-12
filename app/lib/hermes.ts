export type HermesSettings = {
  apiKey: string
  baseUrl: string
  model: string
}

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export type ChatCompletionResult = {
  content: string
  sessionId: string | null
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`
}

function buildHeaders(settings: HermesSettings, extra: Record<string, string> = {}): Headers {
  const headers = new Headers(extra)
  if (settings.apiKey.trim()) {
    headers.set('Authorization', `Bearer ${settings.apiKey.trim()}`)
  }
  return headers
}

async function parseError(response: Response): Promise<string> {
  const contentType = response.headers.get('content-type') ?? ''
  try {
    if (contentType.includes('application/json')) {
      const body = (await response.json()) as {
        error?: { message?: string }
      }
      return body.error?.message ?? `Hermes returned ${response.status}`
    }
    const text = await response.text()
    return text || `Hermes returned ${response.status}`
  } catch {
    return `Hermes returned ${response.status}`
  }
}

async function ensureOk(response: Response): Promise<Response> {
  if (!response.ok) {
    throw new Error(await parseError(response))
  }
  return response
}

export async function probeHermes(settings: HermesSettings): Promise<string[]> {
  const response = await ensureOk(
    await fetch(joinUrl(settings.baseUrl, '/v1/models'), {
      headers: buildHeaders(settings),
    }),
  )
  const body = (await response.json()) as { data?: Array<{ id?: string }> }
  return (body.data ?? [])
    .map((entry) => entry.id?.trim())
    .filter((value): value is string => Boolean(value))
}

export async function createChatCompletion(
  settings: HermesSettings,
  userText: string,
  systemPrompt: string,
  sessionId: string | null,
): Promise<ChatCompletionResult> {
  const messages: ChatMessage[] = []
  if (systemPrompt.trim()) {
    messages.push({ role: 'system', content: systemPrompt.trim() })
  }
  messages.push({ role: 'user', content: userText })

  const headers = buildHeaders(settings, {
    'Content-Type': 'application/json',
  })
  if (sessionId) {
    headers.set('X-Hermes-Session-Id', sessionId)
  }

  const response = await ensureOk(
    await fetch(joinUrl(settings.baseUrl, '/v1/chat/completions'), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: settings.model,
        stream: false,
        messages,
      }),
    }),
  )

  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>
  }

  return {
    content: body.choices?.[0]?.message?.content?.trim() ?? '',
    sessionId: response.headers.get('X-Hermes-Session-Id'),
  }
}

export async function transcribeAudio(settings: HermesSettings, blob: Blob): Promise<string> {
  const form = new FormData()
  form.append('file', blob, `capture.${blob.type.includes('mp4') ? 'mp4' : 'webm'}`)
  form.append('response_format', 'json')

  const response = await ensureOk(
    await fetch(joinUrl(settings.baseUrl, '/v1/audio/transcriptions'), {
      method: 'POST',
      headers: buildHeaders(settings),
      body: form,
    }),
  )

  const body = (await response.json()) as { text?: string }
  return body.text?.trim() ?? ''
}

export async function synthesizeSpeech(settings: HermesSettings, text: string): Promise<Blob> {
  const response = await ensureOk(
    await fetch(joinUrl(settings.baseUrl, '/v1/audio/speech'), {
      method: 'POST',
      headers: buildHeaders(settings, {
        'Content-Type': 'application/json',
      }),
      body: JSON.stringify({
        model: settings.model,
        input: text,
        response_format: 'mp3',
      }),
    }),
  )

  return await response.blob()
}
