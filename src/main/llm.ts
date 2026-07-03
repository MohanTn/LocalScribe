import Anthropic from '@anthropic-ai/sdk'
import type { LlmSettings, PolishPromptMode } from '../shared/types'

const OLLAMA_DEFAULT_MODEL = 'llama3.2'

const PROMPTS: Record<PolishPromptMode, string> = {
  default:
    'Fix the grammar and punctuation of the following transcribed speech, format it into ' +
    'clear bullet points where appropriate, and add a one-sentence summary at the top. ' +
    'Reply with only the polished text, no preamble.\n\nTranscript:\n',
  coding:
    'The following transcribed speech describes a code change or investigation to carry out. ' +
    'Rewrite it as a clear, well-structured prompt that could be handed directly to an LLM coding ' +
    'assistant to execute: state the concrete task in imperative form, and preserve any files, ' +
    'symbols, or constraints mentioned. Fix grammar and drop filler speech. ' +
    'Reply with only the rewritten prompt, no preamble.\n\nTranscript:\n'
}

/**
 * Sends raw transcript text to the configured LLM for cleanup.
 * Anthropic uses the official SDK; OpenAI and Ollama speak their native
 * HTTP APIs directly (no SDK dependency needed for a single endpoint each).
 */
export async function polish(text: string, llm: LlmSettings): Promise<string> {
  const prompt = PROMPTS[llm.promptMode] ?? PROMPTS.default
  switch (llm.provider) {
    case 'anthropic':
      return polishAnthropic(text, llm, prompt)
    case 'openai':
      return polishOpenAi(text, llm, prompt)
    case 'ollama':
      return polishOllama(text, llm, prompt)
    default:
      throw new Error('Configure an LLM provider in Settings to use Polish.')
  }
}

async function polishAnthropic(text: string, llm: LlmSettings, prompt: string): Promise<string> {
  if (!llm.apiKey) throw new Error('Add your Anthropic API key in Settings.')
  const client = new Anthropic({ apiKey: llm.apiKey })
  try {
    const response = await client.messages.create({
      model: llm.model || 'claude-opus-4-8',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt + text }]
    })
    const out = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim()
    if (!out) throw new Error('The model returned an empty response. Try again.')
    return out
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      throw new Error('Anthropic rejected the API key. Check it in Settings.')
    }
    if (err instanceof Anthropic.RateLimitError) {
      throw new Error('Anthropic rate limit reached. Wait a moment and try again.')
    }
    if (err instanceof Anthropic.APIConnectionError) {
      throw new Error('Could not reach Anthropic. Check your internet connection.')
    }
    throw err
  }
}

async function polishOpenAi(text: string, llm: LlmSettings, prompt: string): Promise<string> {
  if (!llm.apiKey) throw new Error('Add your OpenAI API key in Settings.')
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${llm.apiKey}` },
    body: JSON.stringify({
      model: llm.model || 'gpt-4o',
      messages: [{ role: 'user', content: prompt + text }]
    })
  })
  if (res.status === 401) throw new Error('OpenAI rejected the API key. Check it in Settings.')
  if (!res.ok) throw new Error(`OpenAI request failed (HTTP ${res.status}).`)
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
  const out = data.choices?.[0]?.message?.content?.trim()
  if (!out) throw new Error('The model returned an empty response. Try again.')
  return out
}

async function polishOllama(text: string, llm: LlmSettings, prompt: string): Promise<string> {
  const base = (llm.endpoint || 'http://localhost:11434').replace(/\/$/, '')
  let res: Response
  try {
    res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: llm.model || OLLAMA_DEFAULT_MODEL,
        stream: false,
        messages: [{ role: 'user', content: prompt + text }]
      })
    })
  } catch {
    throw new Error(`Could not reach Ollama at ${base}. Is it running?`)
  }
  if (!res.ok) throw new Error(`Ollama request failed (HTTP ${res.status}). Is the model pulled?`)
  const data = (await res.json()) as { message?: { content?: string } }
  const out = data.message?.content?.trim()
  if (!out) throw new Error('The model returned an empty response. Try again.')
  return out
}

/**
 * Best-effort: asks Ollama to load the configured model into memory ahead of
 * time (an empty-prompt /api/generate call loads without generating), so the
 * first real Polish request after app start isn't stuck waiting on a cold
 * model load. Ollama not running / model not pulled yet are expected and
 * silently ignored here — polishOllama() surfaces those errors when the user
 * actually clicks Polish.
 */
export function warmupOllama(llm: LlmSettings): void {
  if (llm.provider !== 'ollama') return
  const base = (llm.endpoint || 'http://localhost:11434').replace(/\/$/, '')
  fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: llm.model || OLLAMA_DEFAULT_MODEL })
  }).catch(() => undefined)
}

// Ollama defaults the tag to "latest" when a model is referenced without one.
function withTag(model: string): string {
  return model.includes(':') ? model : `${model}:latest`
}

/**
 * Checks whether the configured Ollama model is already pulled.
 * Returns the model name if Ollama is reachable but the model is missing,
 * or null if it's present or Ollama isn't reachable (that failure surfaces
 * elsewhere, when Polish is actually used).
 */
export async function getMissingOllamaModel(llm: LlmSettings): Promise<string | null> {
  if (llm.provider !== 'ollama') return null
  const model = llm.model || OLLAMA_DEFAULT_MODEL
  const base = (llm.endpoint || 'http://localhost:11434').replace(/\/$/, '')
  try {
    const res = await fetch(`${base}/api/tags`)
    if (!res.ok) return null
    const data = (await res.json()) as { models?: Array<{ name: string }> }
    const installed = data.models?.map((m) => m.name) ?? []
    return installed.includes(withTag(model)) ? null : model
  } catch {
    return null
  }
}

/**
 * Streams `ollama pull` progress via Ollama's NDJSON /api/pull endpoint.
 * onProgress receives a 0..1 fraction, or null once the pull completes.
 */
export async function pullOllamaModel(
  llm: LlmSettings,
  onProgress: (fraction: number | null) => void
): Promise<void> {
  const model = llm.model || OLLAMA_DEFAULT_MODEL
  const base = (llm.endpoint || 'http://localhost:11434').replace(/\/$/, '')
  let res: Response
  try {
    res = await fetch(`${base}/api/pull`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, stream: true })
    })
  } catch {
    throw new Error(`Could not reach Ollama at ${base}. Is it running?`)
  }
  if (!res.ok || !res.body) throw new Error(`Ollama pull failed (HTTP ${res.status}).`)

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const consumeLine = (line: string): void => {
    if (!line.trim()) return
    const evt = JSON.parse(line) as { status?: string; completed?: number; total?: number; error?: string }
    if (evt.error) throw new Error(evt.error)
    onProgress(evt.total && evt.completed ? evt.completed / evt.total : null)
  }
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) consumeLine(line)
  }
  consumeLine(buffer) // the stream may end without a trailing newline
  onProgress(null)
}
