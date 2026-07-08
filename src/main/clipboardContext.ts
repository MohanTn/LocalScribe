// Extracts frequently-occurring, code-like identifier tokens from arbitrary
// clipboard text (e.g. a variable name copied from an editor) so whisper.cpp
// can be biased toward the right spelling even for terms the user never
// added to their persistent vocabulary (see vocabulary.ts). Regex-based, not
// an AST/parser, so it stays language-agnostic and needs no new dependency —
// this only has to look identifier-*shaped*, not be syntactically valid in
// any one language.
//
// Nothing here touches disk, settings, or IPC: the actual clipboard.readText()
// call and the settings.useClipboardContext gate live in ipc.ts, keeping this
// module a pure, trivially-testable function like vocabulary.ts's.

// Guards against pathological huge clipboard content (e.g. an entire file or
// megabytes of copied logs) making token extraction slow.
const MAX_SCAN_CHARS = 20_000

const IDENTIFIER_RE = /\b[A-Za-z_][A-Za-z0-9_]*\b/g

/** True for snake_case/CONSTANT_CASE (contains `_`) or camelCase/PascalCase
 *  (a lowercase-to-uppercase transition), and long enough to not be noise. */
function looksLikeIdentifier(token: string): boolean {
  if (token.length < 3) return false
  return token.includes('_') || /[a-z][A-Z]/.test(token)
}

/**
 * Ranks candidate identifier tokens in `text` by frequency of occurrence (a
 * term appearing many times is more likely a real identifier the user cares
 * about than a one-off typo) and returns the top `maxTerms`, most frequent
 * first. Ties keep first-occurrence order (stable sort).
 */
export function extractContextTerms(text: string, maxTerms = 20): string[] {
  const scanned = text.slice(0, MAX_SCAN_CHARS)
  const counts = new Map<string, number>()
  for (const m of scanned.matchAll(IDENTIFIER_RE)) {
    if (looksLikeIdentifier(m[0])) counts.set(m[0], (counts.get(m[0]) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxTerms)
    .map(([token]) => token)
}
