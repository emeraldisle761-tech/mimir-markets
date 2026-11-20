/**
 * Sports finality detection for the oracle.
 *
 * Pure and deterministic: `now` (epoch seconds) is injected so grace-window
 * boundaries are testable without touching the clock. Evidence text is read
 * with small, explicit heuristics — no LLM, no network — so the oracle's
 * "is the match over?" decision is pinned by tests rather than a model's mood.
 *
 * Sports betting closes at kickoff, so a claim can expire while the match is
 * still live. Settle only once the evidence shows a final result, unless we're
 * past `SPORTS_SETTLE_GRACE_SECS` past the deadline, at which point a data
 * outage must not lock funds forever.
 *
 * Evidence manifest: `buildSportsEvidenceManifest` produces a bounded,
 * auditable record of the evidence items considered for a finality decision
 * (source reference, capture time, content digest). Raw response bodies and
 * any credential-bearing fields are deliberately excluded.
 */

import { createHash } from 'node:crypto'

export const SPORTS_SETTLE_GRACE_HOURS_DEFAULT = 12

/** Maximum number of evidence items retained in a manifest. */
export const SPORTS_EVIDENCE_MANIFEST_MAX_ITEMS = 20

/** Maximum length of a retained source reference string. */
export const SPORTS_EVIDENCE_SOURCE_REF_MAX_LEN = 256

/** Grace window in seconds, honoring SPORTS_SETTLE_GRACE_HOURS (default 12h). */
export const SPORTS_SETTLE_GRACE_SECS =
  Math.max(1, Number(process.env.SPORTS_SETTLE_GRACE_HOURS ?? SPORTS_SETTLE_GRACE_HOURS_DEFAULT)) * 3600

/** Claim fields the check needs. */
export interface SportsClaim {
  /** Settlement deadline, epoch seconds. */
  deadline: number
}

/**
 * True when the oracle should treat the sports event as final and settle.
 *
 *   - past the grace window → true (never lock funds on an outage)
 *   - evidence shows a concluded match → true
 *   - evidence shows live / upcoming / postponed → false (defer)
 *   - anything unrecognised → false (defer; the safe default)
 */
export function isSportsEventFinal(claim: SportsClaim, evidenceText: string, now: number): boolean {
  const pastGrace = now > claim.deadline + SPORTS_SETTLE_GRACE_SECS
  if (pastGrace) return true
  return eventLooksFinal(evidenceText)
}

const NOT_FINAL_MARKERS = /\bpostponed\b|\bdelayed\b|\bsuspended\b|\bupcoming\b|\bscheduled\b|\btbd\b/i
const FINAL_MARKERS = /\bfinal\s*score\b|\bfinal\b|full.?time|\bft\b/i
const LIVE_MARKERS = /\blive\b|\bin progress\b|\bquarter\b|\bhalftime\b|half.?time|\bminute\b/i

/** Heuristic read of the evidence text: is the event conclusively over? */
function eventLooksFinal(text: string): boolean {
  if (text.trim().length === 0) return false
  if (NOT_FINAL_MARKERS.test(text)) return false
  if (FINAL_MARKERS.test(text)) return true
  if (LIVE_MARKERS.test(text)) return false
  return false
}

/** One raw evidence item as fetched by a source adapter. */
export interface SportsEvidenceInput {
  /** Source identifier or URL; may carry credentials and is sanitised. */
  sourceRef: string
  /** Capture time, epoch seconds. */
  capturedAt: number
  /** Raw response body. Never retained in the manifest. */
  body: string
}

/** A single bounded, auditable manifest entry. */
export interface SportsEvidenceManifestItem {
  sourceRef: string
  capturedAt: number
  /** Hex SHA-256 of the raw body; the body itself is not stored. */
  digest: string
}

/** Bounded evidence manifest for a finality decision. */
export interface SportsEvidenceManifest {
  items: SportsEvidenceManifestItem[]
  /** Count of evidence inputs dropped due to the item cap. */
  truncated: number
}

/**
 * Strip userinfo (user:pass@) and query-string secrets from a source reference,
 * then clamp it to the maximum retained length.
 */
export function sanitizeSourceRef(ref: string): string {
  let out = ref.trim()
  out = out.replace(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/@\s]+@/, '$1')
  out = out.replace(/([?&])(api[_-]?key|token|secret|password|access[_-]?token|auth)=[^&\s]*/gi, '$1$2=REDACTED')
  if (out.length > SPORTS_EVIDENCE_SOURCE_REF_MAX_LEN) {
    out = out.slice(0, SPORTS_EVIDENCE_SOURCE_REF_MAX_LEN)
  }
  return out
}

/**
 * Build a bounded evidence manifest. Records source reference, capture time and
 * a content digest per item; never includes raw bodies or credentials. Items
 * beyond `SPORTS_EVIDENCE_MANIFEST_MAX_ITEMS` are counted in `truncated`.
 */
export function buildSportsEvidenceManifest(inputs: SportsEvidenceInput[]): SportsEvidenceManifest {
  const kept = inputs.slice(0, SPORTS_EVIDENCE_MANIFEST_MAX_ITEMS)
  const items: SportsEvidenceManifestItem[] = kept.map((e) => ({
    sourceRef: sanitizeSourceRef(e.sourceRef),
    capturedAt: e.capturedAt,
    digest: createHash('sha256').update(e.body, 'utf8').digest('hex'),
  }))
  return { items, truncated: Math.max(0, inputs.length - kept.length) }
}
