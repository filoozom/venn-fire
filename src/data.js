export const FIVE_MINUTES_MS = 5 * 60 * 1000
export const AIRCRAFT_PATH_MAX_GAP_MS = 2 * 60 * 1000
export const AIRCRAFT_PATH_MAX_SPEED_KT = 160

const RMI_STATION_MAX_AGE_MS = 20 * 60 * 1000
const LOCAL_UTC_OFFSET_MS = 2 * 60 * 60 * 1000

const localClockFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Brussels',
  hour: '2-digit',
  minute: '2-digit',
})

const localDayFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Brussels',
  day: '2-digit',
  month: 'short',
})

const localDateFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Brussels',
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
})

function requiredPayload(datasets, key) {
  const payload = datasets?.[key]?.payload
  if (!payload || typeof payload !== 'object') throw new Error(`Database dataset ${key} is unavailable`)
  return payload
}

function optionalPayload(datasets, key, fallback = {}) {
  return datasets?.[key]?.payload ?? fallback
}

export function mergeAreaReports(...reportGroups) {
  const reportsBySourceAndTime = new Map()
  reportGroups.flat().forEach((report) => {
    const timestampMs = Number.isFinite(report?.timestampMs)
      ? report.timestampMs
      : Date.parse(report?.observedAt)
    const reportedHa = Number(report?.reportedHa)
    const source = typeof report?.source === 'string' ? report.source.trim() : ''
    if (!Number.isFinite(timestampMs) || !Number.isFinite(reportedHa) || reportedHa <= 0 || !source) return
    const areaPrefix = ['~', '>', '<', '='].includes(report.areaPrefix) ? report.areaPrefix : '~'
    reportsBySourceAndTime.set(`${source}|${timestampMs}`, {
      ...report,
      timestampMs,
      reportedHa,
      areaPrefix,
      areaLabel: typeof report.areaLabel === 'string' && report.areaLabel.trim()
        ? report.areaLabel.trim()
        : `source report at ${new Date(timestampMs).toISOString()}`,
      source,
      sourceUrl: typeof report.sourceUrl === 'string' ? report.sourceUrl : null,
    })
  })
  const seenSourceValues = new Set()
  return [...reportsBySourceAndTime.values()]
    .sort((left, right) => left.timestampMs - right.timestampMs)
    .filter((report) => {
      const key = `${report.source}|${report.areaPrefix}|${report.reportedHa}`
      if (seenSourceValues.has(key)) return false
      seenSourceValues.add(key)
      return true
    })
}

function normalizeWeatherRows(weatherRows) {
  return weatherRows
    .map((weather) => ({
      ...weather,
      timestampMs: Number.isFinite(weather.timestampMs) ? weather.timestampMs : Date.parse(weather.observedAt),
    }))
    .filter((weather) => Number.isFinite(weather.timestampMs))
    .sort((left, right) => (
      left.timestampMs - right.timestampMs
      || (left.sourceKind === 'station-observation' ? 1 : 0)
        - (right.sourceKind === 'station-observation' ? 1 : 0)
    ))
}

function normalizeRmiWeather(snapshot) {
  const station = snapshot.station ?? {}
  return (snapshot.observations ?? []).map((observation) => ({
    observedAt: observation.observedAt,
    timestampMs: Date.parse(observation.observedAt),
    windSpeed: observation.wind_speed_10m_kmh,
    windDirection: observation.wind_direction,
    gust: observation.wind_gusts_speed_kmh,
    humidity: observation.humidity_rel_shelter_avg,
    temperature: observation.temp_dry_shelter_avg,
    source: 'RMI Mont Rigi automatic weather station',
    sourceKind: 'station-observation',
    cadenceMinutes: snapshot.cadenceMinutes,
    validationStatus: snapshot.validationStatus,
    stationName: station.name,
    stationDistanceKm: station.distanceKmFromDrossart,
    stationPosition: [station.latitude, station.longitude],
    fieldValidation: {
      windSpeed: observation.wind_speed_10m_validated,
      windDirection: observation.wind_direction_validated,
      gust: observation.wind_gusts_speed_validated,
      humidity: observation.humidity_rel_shelter_avg_validated,
      temperature: observation.temp_dry_shelter_avg_validated,
    },
  }))
}

export function buildFireFrames({
  timelineStartMs,
  endMs,
  weatherRows,
  reportRows,
  dwdSnapshot,
  center,
}) {
  const boundedEndMs = Math.max(
    timelineStartMs,
    Math.floor(endMs / FIVE_MINUTES_MS) * FIVE_MINUTES_MS,
  )
  const normalizedWeather = normalizeWeatherRows(weatherRows)
  const normalizedReports = mergeAreaReports(reportRows)
  const dwdStations = dwdSnapshot.stations ?? []
  const dwdRowsByStation = Object.fromEntries(dwdStations.map((station) => [
    station.id,
    (dwdSnapshot.observations ?? [])
      .filter((observation) => observation.stationId === station.id)
      .map((observation) => ({ ...observation, timestampMs: Date.parse(observation.observedAt) })),
  ]))

  return Array.from(
    { length: Math.floor((boundedEndMs - timelineStartMs) / FIVE_MINUTES_MS) + 1 },
    (_, index) => {
      const timestampMs = timelineStartMs + index * FIVE_MINUTES_MS
      const modelWeather = normalizedWeather.findLast((row) => (
        row.sourceKind !== 'station-observation' && row.timestampMs <= timestampMs
      )) || normalizedWeather.find((row) => row.sourceKind !== 'station-observation')
      const stationWeather = normalizedWeather.findLast((row) => (
        row.sourceKind === 'station-observation' && row.timestampMs <= timestampMs
      ))
      const stationAgeMs = stationWeather ? timestampMs - stationWeather.timestampMs : Number.POSITIVE_INFINITY
      const currentStationWeather = stationAgeMs <= RMI_STATION_MAX_AGE_MS ? stationWeather : null
      const weather = currentStationWeather || modelWeather || normalizedWeather[0]
      const dwdWinds = dwdStations.flatMap((station) => {
        const observation = dwdRowsByStation[station.id]
          ?.findLast((row) => row.timestampMs <= timestampMs)
        if (!observation || timestampMs - observation.timestampMs > 90 * 60 * 1000) return []
        return [{
          id: station.id,
          name: station.name,
          position: [station.latitude, station.longitude],
          distanceKm: station.distanceKm,
          altitudeM: station.altitudeM,
          observedAt: observation.observedAt,
          ageMinutes: Math.max(0, Math.round((timestampMs - observation.timestampMs) / 60_000)),
          windSpeed: observation.windSpeedKmh,
          windDirection: observation.windDirection,
          gust: null,
          source: 'DWD ten-minute station observation',
          sourceKind: 'dwd-station-observation',
          qualityLevel: observation.qualityLevel,
          qualityStatus: dwdSnapshot.qualityStatus,
        }]
      })
      const report = normalizedReports.findLast((item) => item.timestampMs <= timestampMs)
      const date = new Date(timestampMs)
      return {
        time: date.toISOString(),
        timestampMs,
        shortTime: localClockFormatter.format(date),
        dayLabel: localDayFormatter.format(date).toUpperCase(),
        dateLabel: localDateFormatter.format(date),
        reportedHa: report?.reportedHa ?? null,
        reportedAreaText: report ? `${report.areaPrefix}${report.reportedHa.toLocaleString('en-GB')}` : '—',
        areaLabel: report?.areaLabel ?? 'no quantified report yet',
        areaSource: report?.source ?? null,
        areaSourceUrl: report?.sourceUrl ?? null,
        confidence: report ? 'Reported' : 'Unknown',
        weatherObservedAt: weather?.observedAt ?? null,
        weatherSource: weather?.source ?? null,
        weatherSourceKind: weather?.sourceKind ?? null,
        weatherCadenceMinutes: weather?.cadenceMinutes ?? null,
        weatherValidationStatus: weather?.validationStatus ?? null,
        weatherFieldValidation: weather?.fieldValidation ?? null,
        weatherStationName: weather?.stationName ?? null,
        weatherStationDistanceKm: weather?.stationDistanceKm ?? null,
        weatherPosition: weather?.stationPosition ?? center,
        weatherAgeMinutes: weather?.timestampMs == null
          ? null
          : Math.max(0, Math.round((timestampMs - weather.timestampMs) / 60_000)),
        drossartWind: modelWeather ? {
          position: modelWeather.stationPosition ?? center,
          observedAt: modelWeather.observedAt,
          ageMinutes: Math.max(0, Math.round((timestampMs - modelWeather.timestampMs) / 60_000)),
          windSpeed: modelWeather.windSpeed,
          windDirection: modelWeather.windDirection,
          gust: modelWeather.gust,
          source: modelWeather.source,
          sourceKind: 'model',
        } : null,
        montRigiWind: currentStationWeather ? {
          position: currentStationWeather.stationPosition,
          observedAt: currentStationWeather.observedAt,
          ageMinutes: Math.max(0, Math.round(stationAgeMs / 60_000)),
          windSpeed: currentStationWeather.windSpeed,
          windDirection: currentStationWeather.windDirection,
          gust: currentStationWeather.gust,
          source: currentStationWeather.source,
          sourceKind: 'station-observation',
          validationStatus: currentStationWeather.validationStatus,
        } : null,
        dwdWinds,
        windSpeed: weather?.windSpeed ?? 0,
        windDirection: weather?.windDirection ?? 0,
        gust: weather?.gust ?? 0,
        humidity: weather?.humidity ?? 0,
        temperature: weather?.temperature ?? 0,
      }
    },
  )
}

function frameAt(timestampMs, timelineStartMs, frameCount) {
  return Math.max(0, Math.min(
    frameCount - 1,
    Math.ceil((timestampMs - timelineStartMs) / FIVE_MINUTES_MS),
  ))
}

function classifiedEventType(content, fallback = 'alert') {
  const normalized = String(content ?? '')
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase('en')
  const explicitlyNotAnOrder = /aucune evacuation|no (?:population|residential) evacuation|evacuation standby/iu.test(normalized)
  if (explicitlyNotAnOrder) {
    return /cleared|seal(?:ed|s)?|must leave the (?:hohes )?venn/iu.test(normalized) ? 'closure' : 'alert'
  }
  if (/evac/iu.test(normalized)) return 'evacuation'
  if (/clos|ferm|gesperrt/iu.test(normalized)) return 'closure'
  return fallback
}

function alertEvents(alerts, timelineStartMs, frameCount) {
  return alerts.flatMap((alert) => {
    const timestampMs = Date.parse(alert.sentAt || alert.publishedAt || alert.startsAt)
    if (!Number.isFinite(timestampMs)) return []
    const content = `${alert.headline || ''} ${alert.title || ''} ${alert.description || ''}`
    return [{
      frame: frameAt(timestampMs, timelineStartMs, frameCount),
      time: localClockFormatter.format(new Date(timestampMs)),
      title: alert.headline || alert.title || 'BE-Alert update',
      detail: alert.capDescription || alert.description || alert.areaDesc || 'Public warning issued',
      type: classifiedEventType(content),
      sourceUrl: alert.link,
      sourceName: 'BE-Alert CAP 1.2',
    }]
  })
}

function normalizeTimelineEvent(event, timelineStartMs, frameCount) {
  const timestampMs = Number.isFinite(event?.timestampMs)
    ? event.timestampMs
    : Date.parse(event?.observedAt)
  if (Number.isFinite(timestampMs)) {
    return {
      ...event,
      timestampMs,
      frame: frameAt(timestampMs, timelineStartMs, frameCount),
      time: localClockFormatter.format(new Date(timestampMs)),
      type: classifiedEventType(`${event.title || ''} ${event.detail || ''}`, event.type),
    }
  }
  return Number.isFinite(event?.frame) && event?.time
    ? { ...event, type: classifiedEventType(`${event.title || ''} ${event.detail || ''}`, event.type) }
    : null
}

export function buildEvents({ reportRows, baseEvents, alerts, timelineStartMs, frameCount }) {
  const areaEvents = mergeAreaReports(reportRows).map((report) => ({
    frame: frameAt(report.timestampMs, timelineStartMs, frameCount),
    time: localClockFormatter.format(new Date(report.timestampMs)),
    title: `${report.areaPrefix}${report.reportedHa.toLocaleString('en-GB')} ha reported affected`,
    detail: `${report.areaLabel} · ${report.source}`,
    type: 'area',
    sourceUrl: report.sourceUrl,
    sourceName: `${report.source}, ${report.areaLabel}`,
  }))
  const candidates = [
    ...areaEvents,
    ...(baseEvents ?? [])
      .filter((event) => event.type !== 'area')
      .map((event) => normalizeTimelineEvent(event, timelineStartMs, frameCount))
      .filter(Boolean),
    ...alertEvents(alerts ?? [], timelineStartMs, frameCount),
  ]
  const unique = new Map()
  for (const event of candidates) {
    const key = event.id || (event.sourceUrl
      ? `${event.sourceUrl}|${event.time}`
      : `${event.sourceName || ''}|${event.time}|${event.title}`)
    if (!unique.has(key)) unique.set(key, event)
  }
  return [...unique.values()]
}

function localDayStartMs(productDate) {
  return Date.parse(`${productDate}T00:00:00+02:00`)
}

function localDateOf(timestampMs) {
  return new Date(timestampMs + LOCAL_UTC_OFFSET_MS).toISOString().slice(0, 10)
}

export function effisAreaForTimestamp(products, timestampMs) {
  let applicable = null
  for (const product of products) {
    if (timestampMs >= localDayStartMs(product.productDate)) applicable = product
  }
  return applicable ?? products[0] ?? null
}

export function effisProductIsCarriedForward(product, timestampMs) {
  return Boolean(product && product.productDate < localDateOf(timestampMs))
}

export function runtimeDataFromResponse(response) {
  if (!response?.ok) throw new Error(response?.error || 'Database response is unavailable')
  const datasets = response.datasets ?? {}
  const incident = requiredPayload(datasets, 'incident-config')
  const openMeteo = requiredPayload(datasets, 'weather-open-meteo')
  const rmi = requiredPayload(datasets, 'weather-rmi')
  const dwd = requiredPayload(datasets, 'weather-dwd')
  const reportsPayload = requiredPayload(datasets, 'reports')
  const firms = requiredPayload(datasets, 'firms')
  const effis = requiredPayload(datasets, 'effis')
  const publicAlerts = optionalPayload(datasets, 'public-alerts', { alerts: [] })
  const aircraft = optionalPayload(datasets, 'aircraft', { observations: [], sources: [] })
  const mediaReports = optionalPayload(datasets, 'media-reports', { articles: [], events: [] })
  const publicOperations = optionalPayload(datasets, 'public-operations', { events: [] })
  const roadEvents = optionalPayload(datasets, 'road-events', { events: [] })
  const officialPerimeter = optionalPayload(datasets, 'official-perimeter', { current: null, snapshots: [] })
  const sentinel2 = optionalPayload(datasets, 'sentinel2', { scenes: [] })
  const ems = optionalPayload(datasets, 'ems', { activations: [], matches: [] })
  const sourceRegistry = optionalPayload(datasets, 'source-registry', { sources: [], coverageGaps: [] })
  const timelineStartMs = Number(incident.timelineStartMs)
  if (!Number.isFinite(timelineStartMs)) throw new Error('Database incident timeline start is invalid')
  const generatedAtMs = Date.parse(response.generatedAt)
  const endMs = Number.isFinite(generatedAtMs) ? generatedAtMs : timelineStartMs
  if (!Array.isArray(incident.incidentCenter) || incident.incidentCenter.length !== 2) {
    throw new Error('Database incident center is unavailable')
  }
  const center = incident.incidentCenter
  const reportRows = mergeAreaReports(incident.areaReports ?? [], reportsPayload.areaReports ?? [])
  const weatherRows = [
    ...(openMeteo.rows ?? []),
    ...normalizeRmiWeather(rmi),
  ]
  const frames = buildFireFrames({
    timelineStartMs,
    endMs,
    weatherRows,
    reportRows,
    dwdSnapshot: dwd,
    center,
  })
  const events = buildEvents({
    reportRows,
    baseEvents: [
      ...(incident.events ?? []),
      ...(reportsPayload.events ?? []),
      ...(mediaReports.events ?? []),
      ...(publicOperations.events ?? []).map((event) => ({
        ...event,
        sourceName: 'Agency-approved public operations feed',
      })),
      ...(roadEvents.events ?? []).filter((event) => (
        (event.distanceKmFromDrossart != null && event.distanceKmFromDrossart <= 40)
        || /baelen|jalhay|waimes|malmedy|sourbrodt|butgenbach|eupen|fagnes/iu.test(
          `${event.roadName || ''} ${event.description || ''}`,
        )
      )).map((event) => ({
        id: `road:${event.id}`,
        observedAt: event.observedAt,
        title: [event.recordType, event.roadName].filter(Boolean).join(' · ') || 'Walloon road event',
        detail: event.description || 'Official DATEX II road event',
        type: 'closure',
        sourceName: 'Walloon DATEX II road events',
        sourceUrl: roadEvents.source?.registryUrl,
      })),
    ],
    alerts: publicAlerts.alerts ?? [],
    timelineStartMs,
    frameCount: frames.length,
  })

  return {
    generatedAt: response.generatedAt,
    database: response.database,
    timelineStartMs,
    frames,
    events,
    flights: incident.flights ?? [],
    incidentAircraftMeta: incident.incidentAircraftMeta ?? { negativeFindings: [] },
    initialLayers: incident.initialLayers ?? {},
    sourceLinks: incident.sourceLinks ?? [],
    protectedArea: incident.protectedArea ?? [],
    mapLabels: incident.mapLabels ?? [],
    incidentCenter: center,
    dwdWindStations: dwd.stations ?? [],
    effisProducts: effis.products ?? [],
    firms,
    aircraft,
    reports: reportsPayload,
    mediaReports,
    publicOperations,
    roadEvents,
    officialPerimeter,
    sentinel2,
    ems,
    sourceRegistry,
  }
}
