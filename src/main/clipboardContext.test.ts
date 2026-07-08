import { describe, expect, it } from 'vitest'
import { extractContextTerms } from './clipboardContext'

describe('extractContextTerms', () => {
  it('ranks identifier-like tokens by frequency, most frequent first', () => {
    const text = 'call getUserData then getUserData again, and check user_id, user_id, user_id'
    expect(extractContextTerms(text)).toEqual(['user_id', 'getUserData'])
  })

  it('filters out plain words that are not identifier-shaped', () => {
    const text = 'the quick brown fox jumps over the lazy dog'
    expect(extractContextTerms(text)).toEqual([])
  })

  it('excludes tokens shorter than 3 characters even if they contain an underscore', () => {
    const text = '_x _x _x fetchData'
    expect(extractContextTerms(text)).toEqual(['fetchData'])
  })

  it('respects a custom maxTerms cap', () => {
    const text = 'alpha_one alpha_two alpha_three alpha_four'
    expect(extractContextTerms(text, 2)).toHaveLength(2)
  })

  it('keeps first-occurrence order among tokens with equal frequency', () => {
    const text = 'zeta_term alpha_term'
    expect(extractContextTerms(text)).toEqual(['zeta_term', 'alpha_term'])
  })

  it('returns an empty array for empty input', () => {
    expect(extractContextTerms('')).toEqual([])
  })

  it('returns an empty array when there are no identifier-shaped tokens', () => {
    expect(extractContextTerms('hello world this is a normal sentence')).toEqual([])
  })

  it('only scans up to the max-scan-chars cutoff, ignoring identifiers past it', () => {
    const padding = 'x'.repeat(20_000)
    const text = `${padding} lateTermFound`
    expect(extractContextTerms(text)).toEqual([])
  })

  it('still finds identifiers that occur before the max-scan-chars cutoff', () => {
    const padding = 'x'.repeat(20_000)
    const text = `earlyTermFound ${padding}`
    expect(extractContextTerms(text)).toEqual(['earlyTermFound'])
  })
})
