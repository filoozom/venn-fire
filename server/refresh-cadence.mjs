// Refresh cadence, kept free of any queue or platform dependency so both the
// Vercel scheduler and the self-hosted server can share one definition of when
// a refresh is due.
export const REFRESH_INTERVAL_MS = 5 * 60_000
export const REFRESH_OFFSET_MS = 2 * 60_000

// Sources publish on five-minute boundaries and need a moment to land, so the
// wake-ups sit two minutes past each boundary.
export function nextRefreshWakeAt(nowMs = Date.now()) {
  const slot = Math.floor((nowMs - REFRESH_OFFSET_MS) / REFRESH_INTERVAL_MS) + 1
  return slot * REFRESH_INTERVAL_MS + REFRESH_OFFSET_MS
}
