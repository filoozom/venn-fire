function timestamp(value) {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function latestFrame(rows) {
  return [...rows].sort((left, right) => (
    timestamp(left.validAt) - timestamp(right.validAt)
      || (timestamp(left.retrievedAt) ?? 0) - (timestamp(right.retrievedAt) ?? 0)
  )).at(-1) ?? null
}

// CAMS replaces overlapping valid hours when it publishes a new daily
// forecast cycle. Prefer the newest retained cycle that covers the selected
// time; otherwise preserve compatibility with pre-cycle legacy frames.
export function camsForecastFrameAt(frames, productKey, timestampMs) {
  const eligible = (frames ?? []).filter((frame) => (
    frame.productKey === productKey
      && timestamp(frame.validAt) != null
      && timestamp(frame.validAt) <= timestampMs
  ))
  if (!eligible.length) return null

  const cycleFrames = eligible.filter((frame) => timestamp(frame.forecastRunAt) != null)
  if (!cycleFrames.length) return latestFrame(eligible)
  const newestCycleAtMs = Math.max(...cycleFrames.map((frame) => timestamp(frame.forecastRunAt)))
  return latestFrame(cycleFrames.filter((frame) => timestamp(frame.forecastRunAt) === newestCycleAtMs))
}

export function camsForecastCycleLabel(frame) {
  if (timestamp(frame?.forecastRunAt) == null) return 'forecast cycle unavailable'
  return `cycle ${frame.forecastRunAt.slice(0, 16).replace('T', ' ')} UTC`
}
