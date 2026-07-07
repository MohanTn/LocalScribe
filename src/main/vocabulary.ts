import type { Segment } from '../shared/types'

// Post-transcription fuzzy correction so brand names, jargon, or other terms
// whisper.cpp can't spell right (e.g. "ollama" heard as "a llama") get fixed
// before the transcript reaches history/paste/export, without the user having
// to know in advance what wrong spelling whisper will produce. Word-level
// `words` timestamps are left untouched: a replacement can't be mapped back
// onto the original per-word timings, so word-level SRT export will still
// show whisper's original wording for affected words.

// Normalized Levenshtein similarity below this is treated as "not a match" —
// 0.75 tolerates a couple of character-level misses (typo-grade errors) while
// still rejecting unrelated words.
const FUZZY_THRESHOLD = 0.75

// Below this word length, one edit already exceeds the threshold on most
// short words, so fuzzy matching would false-positive constantly on common
// short words; require an exact (case-insensitive) match instead.
const MIN_FUZZY_WORD_LEN = 4

function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const curr = [i]
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
    }
    prev = curr
  }
  return prev[b.length]
}

function similarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length)
  return maxLen === 0 ? 1 : 1 - levenshtein(a, b) / maxLen
}

interface Token {
  raw: string
  start: number
  end: number
}

/** Splits on whitespace while keeping character offsets, so matched spans can
 *  be spliced back into the original text without disturbing surrounding
 *  spacing/newlines. */
function tokenize(text: string): Token[] {
  const tokens: Token[] = []
  const re = /\S+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) tokens.push({ raw: m[0], start: m.index, end: m.index + m[0].length })
  return tokens
}

/** Pulls leading/trailing punctuation off a token so "ollama," compares as
 *  "ollama" but the comma is preserved when splicing the correction back in. */
function splitPunct(raw: string): { pre: string; word: string; post: string } {
  const match = raw.match(/^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/u)
  return match ? { pre: match[1], word: match[2], post: match[3] } : { pre: '', word: raw, post: '' }
}

function correctSegment(text: string, terms: string[]): string {
  const tokens = tokenize(text)
  if (tokens.length === 0) return text

  const consumed = new Array<boolean>(tokens.length).fill(false)
  // Longest phrases first so a multi-word term wins over a shorter one nested inside it.
  const byWordCount = [...terms].sort(
    (a, b) => b.trim().split(/\s+/).length - a.trim().split(/\s+/).length
  )
  const spans: { start: number; end: number; replacement: string }[] = []

  for (const term of byWordCount) {
    const words = term.trim().split(/\s+/).filter(Boolean)
    if (words.length === 0) continue
    const n = words.length
    const termLower = words.join(' ').toLowerCase()
    const minWordLen = Math.min(...words.map((w) => w.length))

    for (let i = 0; i + n <= tokens.length; i++) {
      if (consumed.slice(i, i + n).some(Boolean)) continue
      const window = tokens.slice(i, i + n)
      const parts = window.map((t) => splitPunct(t.raw))
      const candidate = parts.map((p) => p.word).join(' ').toLowerCase()
      if (!candidate) continue

      const exact = candidate === termLower
      if (!exact && minWordLen < MIN_FUZZY_WORD_LEN) continue
      if (!exact && similarity(candidate, termLower) < FUZZY_THRESHOLD) continue

      for (let k = i; k < i + n; k++) consumed[k] = true
      spans.push({
        start: window[0].start,
        end: window[n - 1].end,
        replacement: parts[0].pre + term.trim() + parts[n - 1].post
      })
    }
  }

  if (spans.length === 0) return text
  spans.sort((a, b) => a.start - b.start)
  let result = ''
  let cursor = 0
  for (const span of spans) {
    result += text.slice(cursor, span.start) + span.replacement
    cursor = span.end
  }
  return result + text.slice(cursor)
}

// whisper.cpp's own --help caps the initial prompt at roughly n_text_ctx/2
// tokens (~a few hundred characters); this cap keeps the argv sane rather than
// relying on whisper.cpp to silently truncate an arbitrarily long string.
const MAX_PROMPT_CHARS = 400

/**
 * Builds whisper.cpp's `--prompt` argument from the vocabulary list, so
 * decoding is biased toward the right spelling instead of only correcting it
 * after the fact (see applyVocabulary below, which still runs regardless —
 * the prompt nudges probabilities, it doesn't guarantee exact output).
 */
export function buildInitialPrompt(terms: string[]): string | undefined {
  const clean = [...new Set(terms.map((t) => t.trim()).filter(Boolean))]
  if (clean.length === 0) return undefined
  const prompt = clean.join(', ')
  return prompt.length > MAX_PROMPT_CHARS ? prompt.slice(0, MAX_PROMPT_CHARS) : prompt
}

export function applyVocabulary<T extends { text: string; segments: Segment[] }>(
  out: T,
  terms: string[]
): T {
  const clean = terms.map((t) => t.trim()).filter(Boolean)
  if (clean.length === 0) return out
  // `out.text` is just the segments joined (see whisper.ts), so derive the
  // corrected version from the already-processed segments instead of running
  // every match a second time over near-duplicate content.
  const segments = out.segments.map((s) => ({ ...s, text: correctSegment(s.text, clean) }))
  return {
    ...out,
    text: segments.map((s) => s.text).join(' ').replace(/\s+/g, ' ').trim(),
    segments
  }
}
