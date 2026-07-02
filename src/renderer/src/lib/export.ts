import type { Segment } from '../../../shared/api'

// Subtitle export. SRT is emitted at word level when whisper.cpp token
// timestamps are available (one cue per word), falling back to segment cues.
// Plain-text export uses the editable textarea contents directly (see
// TranscribeView), so user edits are preserved.

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0')
}

function timestamp(ms: number, msSeparator: string): string {
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  const rest = Math.floor(ms % 1000)
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}${msSeparator}${pad(rest, 3)}`
}

export function toSrt(segments: Segment[]): string {
  const cues: Array<{ start: number; end: number; text: string }> = []
  for (const seg of segments) {
    if (seg.words?.length) {
      for (const w of seg.words) cues.push({ start: w.start, end: w.end, text: w.text })
    } else {
      cues.push({ start: seg.start, end: seg.end, text: seg.text })
    }
  }
  return (
    cues
      .map(
        (c, i) =>
          `${i + 1}\n${timestamp(c.start, ',')} --> ${timestamp(c.end, ',')}\n${c.text}`
      )
      .join('\n\n') + '\n'
  )
}

export function toVtt(segments: Segment[]): string {
  const body = segments
    .map((s) => `${timestamp(s.start, '.')} --> ${timestamp(s.end, '.')}\n${s.text}`)
    .join('\n\n')
  return `WEBVTT\n\n${body}\n`
}
