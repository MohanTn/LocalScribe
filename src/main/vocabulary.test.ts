import { describe, expect, it } from 'vitest'
import type { Segment } from '../shared/types'
import { applyVocabulary, buildInitialPrompt } from './vocabulary'

function out(text: string): { text: string; segments: Segment[] } {
  return { text, segments: [{ start: 0, end: 1000, text }] }
}

describe('buildInitialPrompt', () => {
  it('joins correct terms into a single hint string', () => {
    expect(buildInitialPrompt(['Ollama', 'whisper.cpp'])).toBe('Ollama, whisper.cpp')
  })

  it('trims, drops empties, and dedupes', () => {
    expect(buildInitialPrompt([' Ollama ', '', 'Ollama', '  '])).toBe('Ollama')
  })

  it('returns undefined when there are no terms', () => {
    expect(buildInitialPrompt([])).toBeUndefined()
  })

  it('truncates to stay well under whisper.cpp\'s prompt token cap', () => {
    const prompt = buildInitialPrompt(['x'.repeat(500)])
    expect(prompt?.length).toBe(400)
  })
})

describe('applyVocabulary', () => {
  it('returns the input unchanged when there are no terms', () => {
    const input = out('a llama did something')
    expect(applyVocabulary(input, [])).toBe(input)
  })

  it('exact-matches case-insensitively', () => {
    const result = applyVocabulary(out('i started ollama today'), ['Ollama'])
    expect(result.text).toBe('i started Ollama today')
  })

  it('fuzzy-corrects a near-miss spelling of a long-enough term', () => {
    // "olama" is one edit away from "ollama" (missing a repeated letter).
    const result = applyVocabulary(out('please launch olama now'), ['Ollama'])
    expect(result.text).toBe('please launch Ollama now')
  })

  it('does not correct unrelated words', () => {
    const result = applyVocabulary(out('please launch the browser now'), ['Ollama'])
    expect(result.text).toBe('please launch the browser now')
  })

  it('requires an exact match for short terms even against a longer near-miss candidate', () => {
    // "cars" is one edit from "car" and would clear the similarity threshold
    // (maxLen 4 => 0.75) if short terms weren't forced to match exactly.
    const result = applyVocabulary(out('the cars are red'), ['car'])
    expect(result.text).toBe('the cars are red')
  })

  it('matches multi-word terms as a phrase', () => {
    const result = applyVocabulary(out('please open claude code now'), ['Claude Code'])
    expect(result.text).toBe('please open Claude Code now')
  })

  it('preserves surrounding punctuation', () => {
    const result = applyVocabulary(out('run olama, then check logs.'), ['Ollama'])
    expect(result.text).toBe('run Ollama, then check logs.')
  })

  it('prefers the longest matching phrase so it wins over a nested single-word term', () => {
    const result = applyVocabulary(out('please open claude code now'), ['Code', 'Claude Code'])
    expect(result.text).toBe('please open Claude Code now')
  })
})
