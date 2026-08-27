const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

// Map visibility follows the cadence and meaning of each source. These windows
// affect only the public drawing; PostgreSQL keeps the complete source history.
export const SOURCE_FADE_WINDOWS_MS = Object.freeze({
  firmsPolar: 24 * HOUR_MS,
  sentinel3Frp: 24 * HOUR_MS,
  precipitationRadar: 60 * MINUTE_MS,
  camsForecast: 3 * HOUR_MS,
  dailyImagery: 3 * DAY_MS,
  effisGeometry: 3 * DAY_MS,
  sentinel2Change: 30 * DAY_MS,
})

export function timestampMs(value) {
  if (value !== null && value !== '' && Number.isFinite(Number(value))) return Number(value)
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function linearSourceOpacity(observedAt, selectedTimestampMs, lifetimeMs) {
  const observedTimestampMs = timestampMs(observedAt)
  const selected = timestampMs(selectedTimestampMs)
  const lifetime = Number(lifetimeMs)
  if (observedTimestampMs == null || selected == null || !Number.isFinite(lifetime) || lifetime <= 0) return 0
  const ageMs = selected - observedTimestampMs
  if (ageMs < 0 || ageMs >= lifetime) return 0
  return 1 - ageMs / lifetime
}

function effisGeometryKey(product) {
  return (product?.rings ?? [])
    .map((ring) => ring
      .map((point) => `${Number(point?.[0]).toFixed(7)},${Number(point?.[1]).toFixed(7)}`)
      .sort()
      .join('|'))
    .sort()
    .join('||')
}

/**
 * EFFIS may return the exact same retained geometry for successive TIME query
 * dates. A request date is not a new observation. Mark the first date of each
 * exact geometry run so the viewer can age the shape honestly.
 */
export function annotateEffisGeometryFreshness(products = []) {
  let previousKey = null
  let geometryObservedDate = null
  return [...products]
    .sort((left, right) => String(left?.productDate ?? '').localeCompare(String(right?.productDate ?? '')))
    .map((product) => {
      const geometryKey = effisGeometryKey(product)
      const geometryChanged = geometryKey !== previousKey
      if (geometryChanged) geometryObservedDate = product.geometryObservedDate ?? product.productDate
      previousKey = geometryKey
      return {
        ...product,
        geometryObservedDate: geometryObservedDate ?? product.productDate,
        geometryChanged,
      }
    })
}

export function effisGeometryTimestampMs(product) {
  const productDate = product?.geometryObservedDate ?? product?.productDate
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(productDate ?? ''))) return null
  // EFFIS is a daily product. Existing timeline semantics make it available at
  // the start of its local incident day, so use the same Brussels summer offset.
  return Date.parse(`${productDate}T00:00:00+02:00`)
}

export function effisGeometryOpacityAt(product, selectedTimestampMs) {
  return linearSourceOpacity(
    effisGeometryTimestampMs(product),
    selectedTimestampMs,
    SOURCE_FADE_WINDOWS_MS.effisGeometry,
  )
}
