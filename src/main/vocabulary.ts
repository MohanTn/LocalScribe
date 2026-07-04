import type { Segment, VocabularyEntry } from '../shared/types'

// Post-transcription find/replace so brand names, jargon, or other terms
// whisper.cpp can't spell the way the user wants (e.g. "lama 3.1" -> "Llama
// 3.1") get corrected before the transcript reaches history/paste/export.
// Word-level `words` timestamps are left untouched: a multi-word replacement
// can't be mapped back onto the original per-word timings, so word-level SRT
// export will still show whisper's original wording for affected words.

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function replaceAll(text: string, entries: VocabularyEntry[]): string {
  let result = text
  for (const { from, to } of entries) {
    result = result.replace(new RegExp(`\\b${escapeRegExp(from)}\\b`, 'gi'), to)
  }
  return result
}

// whisper.cpp's own --help caps the initial prompt at roughly n_text_ctx/2
// tokens (~a few hundred characters); this cap keeps the argv sane rather than
// relying on whisper.cpp to silently truncate an arbitrarily long string.
const MAX_PROMPT_CHARS = 400

/**
 * Builds whisper.cpp's `--prompt` argument from the corrected (`to`) side of
 * the vocabulary list, so decoding is biased toward the right spelling instead
 * of only correcting it after the fact (see applyVocabulary above, which still
 * runs regardless — the prompt nudges probabilities, it doesn't guarantee
 * exact output).
 */
export function buildInitialPrompt(entries: VocabularyEntry[]): string | undefined {
  const terms = new Set(
    entries
      .filter((e) => e.from.trim() && e.to.trim())
      .map((e) => e.to.trim())
  )
  if (terms.size === 0) return undefined
  const prompt = [...terms].join(', ')
  return prompt.length > MAX_PROMPT_CHARS ? prompt.slice(0, MAX_PROMPT_CHARS) : prompt
}

export function applyVocabulary<T extends { text: string; segments: Segment[] }>(
  out: T,
  entries: VocabularyEntry[]
): T {
  // Longest phrase first so a multi-word entry wins over a shorter one nested inside it.
  const active = entries
    .map((e) => ({ from: e.from.trim(), to: e.to.trim() }))
    .filter((e) => e.from && e.to)
    .sort((a, b) => b.from.length - a.from.length)
  if (active.length === 0) return out
  // `out.text` is just the segments joined (see whisper.ts), so derive the
  // replaced version from the already-processed segments instead of running
  // every regex a second time over near-duplicate content.
  const segments = out.segments.map((s) => ({ ...s, text: replaceAll(s.text, active) }))
  return {
    ...out,
    text: segments.map((s) => s.text).join(' ').replace(/\s+/g, ' ').trim(),
    segments
  }
}
