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
 * Evidence acquisition failures are reported as bounded codes so decision
 * journals can record why evidence was unusable. Dependency failures never
 * produce a settled verdict: they defer (skip-and-retry) unless the grace
 * window has elapsed.
 */

export const SPORTS_SETTLE_GRACE_HOURS_DEFAULT = 12

/** Grace window in seconds, honoring SPORTS_SETTLE_GRACE_HOURS (default 12h). */
export const SPORTS_SETTLE_GRACE_SECS =
  Math.max(1, Number(process.env.SPORTS_SETTLE_GRACE_HOURS ?? SPORTS_SETTLE_GRACE_HOURS_DEFAULT)) * 3600

/** Bounded evidence failure classes recorded in decision journals. */
export type EvidenceFailureClass = 'unavailable' | 'stale' | 'malformed' | 'unsupported'

export const EVIDENCE_FAILURE_CLASSES: readonly EvidenceFailureClass[] = [
  'unavailable',
  'stale',
  'malformed',
  'unsupported',
]

/** Claim fields the check needs. */
export interface SportsClaim {
  /** Settlement deadline, epoch seconds. */
  deadline: number
}

/** Structured evidence snapshot as fetched by the oracle. */
export interface SportsEvidence {
  /** Raw evidence text, if the fetch succeeded. */
  text?: string
  /** Epoch seconds at which the evidence was produced, if known. */
  observedAt?: number
  /** Evidence sport/feed identifier, if known. */
  feed?: string
  /** Set when acquisition itself failed (transport error, timeout, etc.). */
  fetchError?: boolean
}

export interface FinalityDecision {
  final: boolean
  /** Present whenever evidence was unusable; absent when evidence was read. */
  failureClass?: EvidenceFailureClass
  /** Short, bounded reason suitable for journals. */
  reason: string
}

/** Maximum age (seconds) of evidence before it is considered stale. */
export const SPORTS_EVIDENCE_MAX_AGE_SECS = 6 * 3600

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

/**
 * Evaluate finality from structured evidence, classifying acquisition failures.
 * Dependency failures defer rather than settle, except past the grace window.
 */
export function evaluateSportsFinality(
  claim: SportsClaim,
  evidence: SportsEvidence,
  now: number,
): FinalityDecision {
  const pastGrace = now > claim.deadline + SPORTS_SETTLE_GRACE_SECS

  if (evidence.fetchError) {
    return {
      final: pastGrace,
      failureClass: 'unavailable',
      reason: pastGrace ? 'unavailable-past-grace' : 'unavailable-defer',
    }
  }
  if (evidence.text === undefined || evidence.text === null) {
    return {
      final: pastGrace,
      failureClass: 'malformed',
      reason: pastGrace ? 'malformed-past-grace' : 'malformed-defer',
    }
  }
  if (evidence.observedAt !== undefined && now - evidence.observedAt > SPORTS_EVIDENCE_MAX_AGE_SECS) {
    return {
      final: pastGrace,
      failureClass: 'stale',
      reason: pastGrace ? 'stale-past-grace' : 'stale-defer',
    }
  }
  if (evidence.feed !== undefined && !SUPPORTED_FEEDS.has(evidence.feed)) {
    return {
      final: pastGrace,
      failureClass: 'unsupported',
      reason: pastGrace ? 'unsupported-past-grace' : 'unsupported-defer',
    }
  }

  const final = isSportsEventFinal(claim, evidence.text, now)
  return { final, reason: final ? 'evidence-final' : 'evidence-not-final' }
}

/** Feeds whose text format the heuristics understand. */
const SUPPORTED_FEEDS: ReadonlySet<string> = new Set(['scores', 'sports-results'])

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
