export const REPORTED_FIRE_ACTIVITY_LIFETIME_MS = 24 * 60 * 60 * 1000

const REIGNITION_PATTERN = /(?:reprise(?:s)?\s+de\s+feu|reprise(?:s)?\s+(?:plus\s+)?importante|re-?ignition|flare-?up|wiederaufflammen|erneut(?:es)?\s+aufflammen)/iu
const FIRE_CONTEXT_PATTERN = /(?:incendie|feu|fire|brand|flamme)/iu
const NORTH_EAST_PATTERN = /(?:nord[-\s]?est|north[-\s]?east|nordost)/iu
const EAST_PATTERN = /(?:secteur\s+est|eastern?\s+sector|ostsektor)/iu
const CONTROLLED_PATTERN = /(?:désormais\s+contrôlée?|maintenant\s+contrôlée?|reported\s+controlled|now\s+controlled|unter\s+kontrolle|unter\s+kontrolliert)/iu
const OPERATIONS_PATTERN = /(?:opérations?\s+(?:se\s+)?poursuiv|opérations?\s+de\s+noyage|damping[-\s]down|operations?\s+continu|löscharbeiten\s+(?:gehen|werden)|nachlöscharbeiten)/iu

function eventTimestampMs(event) {
  if (Number.isFinite(event?.timestampMs)) return event.timestampMs
  const parsed = Date.parse(event?.observedAt ?? event?.publishedAt)
  return Number.isFinite(parsed) ? parsed : null
}

function eventText(event) {
  return `${event?.title ?? ''} ${event?.detail ?? ''}`.trim()
}

export function latestReportedFireActivity(
  events,
  selectedTimestampMs,
  lifetimeMs = REPORTED_FIRE_ACTIVITY_LIFETIME_MS,
) {
  if (!Number.isFinite(selectedTimestampMs) || !Number.isFinite(lifetimeMs) || lifetimeMs <= 0) return null

  const candidates = (events ?? []).flatMap((event) => {
    const timestampMs = eventTimestampMs(event)
    const text = eventText(event)
    const ageMs = selectedTimestampMs - timestampMs
    if (!Number.isFinite(timestampMs)
      || ageMs < 0
      || ageMs >= lifetimeMs
      || !FIRE_CONTEXT_PATTERN.test(text)
      || !REIGNITION_PATTERN.test(text)) return []
    return [{ event, text, timestampMs }]
  }).sort((left, right) => left.timestampMs - right.timestampMs)

  const latest = candidates.at(-1)
  if (!latest) return null

  const sector = NORTH_EAST_PATTERN.test(latest.text)
    ? 'north-east sector'
    : EAST_PATTERN.test(latest.text) ? 'eastern sector' : null
  const controlled = CONTROLLED_PATTERN.test(latest.text)
  const operationsContinue = OPERATIONS_PATTERN.test(latest.text)

  return {
    ...latest.event,
    timestampMs: latest.timestampMs,
    headline: `Re-ignition reported${sector ? ` in the ${sector}` : ''}`,
    status: controlled
      ? `Reported controlled${operationsContinue ? '; damping-down operations continue' : ''}.`
      : operationsContinue ? 'Response operations are reported as continuing.' : 'Current extent is not established by this report.',
    controlled,
    sector,
  }
}
