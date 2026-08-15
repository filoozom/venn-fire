import incidentAircraftSnapshot from './incidentAircraftSnapshot.json'
import montRigiSnapshot from './montRigiObservations.json'
import dwdWindSnapshot from './dwdWindObservations.json'
import {
  effisAreaForTimestamp,
  effisBurnedArea,
  effisBurnedAreas,
  effisProductIsCarriedForward,
} from './effisBurnedArea'

const CENTER = [50.54762, 6.05757]
export const FIVE_MINUTES_MS = 5 * 60 * 1000
const RMI_STATION_MAX_AGE_MS = 20 * 60 * 1000
export const AIRCRAFT_PATH_MAX_GAP_MS = 2 * 60 * 1000
export const AIRCRAFT_PATH_MAX_SPEED_KT = 160
export const TIMELINE_START_MS = Date.parse('2026-08-14T13:00:00+02:00')
export const BUNDLED_TIMELINE_END_MS = Date.parse('2026-08-15T15:00:00+02:00')

export { effisAreaForTimestamp, effisBurnedArea, effisBurnedAreas, effisProductIsCarriedForward }

// Open-Meteo historical-forecast model values for 50.548 N, 6.061 E,
// retrieved at 11:30 CEST on 15 August 2026. Entries run from 13:00 CEST on
// 14 August through 12:00 CEST on 15 August, one value per local clock hour.
const bundledHourlyWeatherValues = [
  { windSpeed: 7.6, windDirection: 335, gust: 27.4, humidity: 16, temperature: 30.7 },
  { windSpeed: 6.5, windDirection: 339, gust: 27.0, humidity: 15, temperature: 30.9 },
  { windSpeed: 7.2, windDirection: 333, gust: 27.4, humidity: 16, temperature: 31.9 },
  { windSpeed: 10.8, windDirection: 310, gust: 33.1, humidity: 15, temperature: 32.0 },
  { windSpeed: 11.5, windDirection: 320, gust: 32.8, humidity: 15, temperature: 31.8 },
  { windSpeed: 10.1, windDirection: 347, gust: 28.8, humidity: 17, temperature: 31.8 },
  { windSpeed: 6.8, windDirection: 356, gust: 20.9, humidity: 17, temperature: 31.1 },
  { windSpeed: 9.7, windDirection: 2, gust: 22.7, humidity: 20, temperature: 30.2 },
  { windSpeed: 6.8, windDirection: 42, gust: 14.4, humidity: 26, temperature: 27.5 },
  { windSpeed: 7.2, windDirection: 107, gust: 12.2, humidity: 27, temperature: 25.7 },
  { windSpeed: 8.6, windDirection: 126, gust: 15.5, humidity: 29, temperature: 24.8 },
  { windSpeed: 8.3, windDirection: 135, gust: 13.3, humidity: 33, temperature: 23.8 },
  { windSpeed: 9.7, windDirection: 135, gust: 16.2, humidity: 29, temperature: 24.0 },
  { windSpeed: 11.2, windDirection: 141, gust: 18.0, humidity: 32, temperature: 23.6 },
  { windSpeed: 11.9, windDirection: 135, gust: 21.6, humidity: 33, temperature: 23.8 },
  { windSpeed: 11.2, windDirection: 147, gust: 20.5, humidity: 28, temperature: 24.3 },
  { windSpeed: 14.0, windDirection: 137, gust: 28.1, humidity: 27, temperature: 24.2 },
  { windSpeed: 11.2, windDirection: 146, gust: 21.6, humidity: 29, temperature: 23.7 },
  { windSpeed: 8.3, windDirection: 139, gust: 20.9, humidity: 32, temperature: 23.5 },
  { windSpeed: 4.0, windDirection: 67, gust: 18.4, humidity: 41, temperature: 22.8 },
  { windSpeed: 5.0, windDirection: 143, gust: 18.4, humidity: 38, temperature: 25.7 },
  { windSpeed: 9.4, windDirection: 287, gust: 26.6, humidity: 37, temperature: 26.0 },
  { windSpeed: 4.3, windDirection: 305, gust: 27.0, humidity: 32, temperature: 25.7 },
  { windSpeed: 8.3, windDirection: 303, gust: 25.2, humidity: 25, temperature: 28.2 },
]

export const bundledHourlyWeather = bundledHourlyWeatherValues.map((weather, index) => ({
  ...weather,
  timestampMs: TIMELINE_START_MS + index * 60 * 60 * 1000,
  observedAt: new Date(TIMELINE_START_MS + index * 60 * 60 * 1000).toISOString(),
  source: 'Open-Meteo hourly model',
  sourceKind: 'model',
  cadenceMinutes: 60,
  validationStatus: 'not-applicable',
  stationPosition: [50.548, 6.061],
}))

// Exact ten-minute automatic-weather-station values published by RMI for Mont
// Rigi, 4.2 km from Drossart. RMI had not yet quality-validated any field in
// this near-real-time window, so that status travels into every timeline frame.
export const bundledRmiWeather = montRigiSnapshot.observations.map((observation) => ({
  observedAt: observation.observedAt,
  timestampMs: Date.parse(observation.observedAt),
  windSpeed: observation.wind_speed_10m_kmh,
  windDirection: observation.wind_direction,
  gust: observation.wind_gusts_speed_kmh,
  humidity: observation.humidity_rel_shelter_avg,
  temperature: observation.temp_dry_shelter_avg,
  source: 'RMI Mont Rigi automatic weather station',
  sourceKind: 'station-observation',
  cadenceMinutes: montRigiSnapshot.cadenceMinutes,
  validationStatus: montRigiSnapshot.validationStatus,
  stationName: montRigiSnapshot.station.name,
  stationDistanceKm: montRigiSnapshot.station.distanceKmFromDrossart,
  stationPosition: [montRigiSnapshot.station.latitude, montRigiSnapshot.station.longitude],
  fieldValidation: {
    windSpeed: observation.wind_speed_10m_validated,
    windDirection: observation.wind_direction_validated,
    gust: observation.wind_gusts_speed_validated,
    humidity: observation.humidity_rel_shelter_avg_validated,
    temperature: observation.temp_dry_shelter_avg_validated,
  },
}))

export const bundledWeatherRows = [...bundledHourlyWeather, ...bundledRmiWeather]

export const dwdWindStations = dwdWindSnapshot.stations
const dwdWindRowsByStation = Object.fromEntries(dwdWindStations.map((station) => [
  station.id,
  dwdWindSnapshot.observations
    .filter((observation) => observation.stationId === station.id)
    .map((observation) => ({ ...observation, timestampMs: Date.parse(observation.observedAt) })),
]))

export const areaReports = [
  {
    timestampMs: Date.parse('2026-08-14T16:00:00+02:00'),
    reportedHa: 60,
    areaPrefix: '~',
    areaLabel: 'official estimate at 16:00 CEST',
    source: 'Governor of Liège',
    sourceUrl: 'https://gouverneur.provincedeliege.be/fr/node/7923',
  },
  {
    timestampMs: Date.parse('2026-08-14T20:00:00+02:00'),
    reportedHa: 100,
    areaPrefix: '~',
    areaLabel: 'official estimate at 20:00 CEST',
    source: 'Governor of Liège',
    sourceUrl: 'https://gouverneur.provincedeliege.be/fr/node/7923',
  },
  {
    timestampMs: Date.parse('2026-08-15T07:00:00+02:00'),
    reportedHa: 850,
    areaPrefix: '~',
    areaLabel: 'official estimate at 07:00 CEST',
    source: 'Governor of Liège',
    sourceUrl: 'https://gouverneur.provincedeliege.be/fr/node/7923',
  },
  {
    timestampMs: Date.parse('2026-08-15T11:28:00+02:00'),
    reportedHa: 900,
    areaPrefix: '>',
    areaLabel: 'local reporting updated at 11:28 CEST',
    source: 'BRF',
    sourceUrl: 'https://brf.be/regional/2100196/',
  },
  {
    timestampMs: Date.parse('2026-08-15T14:30:00+02:00'),
    reportedHa: 1500,
    areaPrefix: '>',
    areaLabel: 'BRF update at 14:30 CEST',
    source: 'BRF',
    sourceUrl: 'https://brf.be/regional/2100196/',
  },
]

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
      // BRF exposes a page-wide last-edited timestamp. If the article is later
      // edited without changing its hectare statement, that is not a new fire-
      // size observation and must not move an already known transition.
      const key = `${report.source}|${report.areaPrefix}|${report.reportedHa}`
      if (seenSourceValues.has(key)) return false
      seenSourceValues.add(key)
      return true
    })
}

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

function normalizedWeatherRows(weatherRows) {
  return weatherRows
    .map((weather) => ({
      ...weather,
      timestampMs: Number.isFinite(weather.timestampMs) ? weather.timestampMs : Date.parse(weather.observedAt),
    }))
    .filter((weather) => Number.isFinite(weather.timestampMs))
    .sort((left, right) => (
      left.timestampMs - right.timestampMs
      // Prefer a station observation to a model value at the same timestamp.
      || (left.sourceKind === 'station-observation' ? 1 : 0)
        - (right.sourceKind === 'station-observation' ? 1 : 0)
    ))
}

export function buildFireFrames({
  endMs = BUNDLED_TIMELINE_END_MS,
  weatherRows = bundledWeatherRows,
  reportRows = areaReports,
} = {}) {
  const boundedEndMs = Math.max(
    TIMELINE_START_MS,
    Math.floor(endMs / FIVE_MINUTES_MS) * FIVE_MINUTES_MS,
  )
  const normalizedWeather = normalizedWeatherRows(weatherRows)
  const normalizedReports = mergeAreaReports(reportRows)

  return Array.from(
    { length: Math.floor((boundedEndMs - TIMELINE_START_MS) / FIVE_MINUTES_MS) + 1 },
    (_, index) => {
      const timestampMs = TIMELINE_START_MS + index * FIVE_MINUTES_MS
      const modelWeather = normalizedWeather.findLast((row) => (
        row.sourceKind !== 'station-observation' && row.timestampMs <= timestampMs
      )) || normalizedWeather.find((row) => row.sourceKind !== 'station-observation')
      const stationWeather = normalizedWeather.findLast((row) => (
        row.sourceKind === 'station-observation' && row.timestampMs <= timestampMs
      ))
      const stationAgeMs = stationWeather ? timestampMs - stationWeather.timestampMs : Number.POSITIVE_INFINITY
      const currentStationWeather = stationAgeMs <= RMI_STATION_MAX_AGE_MS ? stationWeather : null
      const weather = currentStationWeather || modelWeather || normalizedWeather[0]
      const dwdWinds = dwdWindStations.flatMap((station) => {
        const observation = dwdWindRowsByStation[station.id]
          .findLast((row) => row.timestampMs <= timestampMs)
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
          qualityStatus: dwdWindSnapshot.qualityStatus,
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
        weatherPosition: weather?.stationPosition ?? CENTER,
        weatherAgeMinutes: weather?.timestampMs == null
          ? null
          : Math.max(0, Math.round((timestampMs - weather.timestampMs) / 60_000)),
        drossartWind: modelWeather ? {
          position: modelWeather.stationPosition ?? [50.548, 6.061],
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

export const fireFrames = buildFireFrames()

function frameAt(isoTimestamp) {
  return Math.max(0, Math.min(
    fireFrames.length - 1,
    Math.ceil((Date.parse(isoTimestamp) - TIMELINE_START_MS) / FIVE_MINUTES_MS),
  ))
}

// Exact Airplanes.live MLAT observations from the checked-in provenance
// snapshot. They are points, not an interpolated path. The map may join two
// consecutive points only when the gap and implied speed pass the published
// thresholds; reception gaps and the known Aachen/Walheim artifact stay open.
export const incidentAircraftMeta = {
  schemaVersion: incidentAircraftSnapshot.schemaVersion,
  generatedAt: incidentAircraftSnapshot.generatedAt,
  selection: incidentAircraftSnapshot.selection,
  sources: incidentAircraftSnapshot.sources,
  negativeFindings: incidentAircraftSnapshot.negativeFindings,
}

const incidentSourceById = Object.fromEntries(
  incidentAircraftSnapshot.sources.map((source) => [source.id, source]),
)

function incidentObservations(icao24) {
  const aircraft = incidentAircraftSnapshot.aircraft.find((item) => item.icao24 === icao24)
  return (aircraft?.observations || []).map(([observedAt, latitude, longitude, altitudeFt, sourceId]) => ({
    observedAt,
    timestampMs: Date.parse(observedAt),
    position: [latitude, longitude],
    altitudeFt,
    sourceId,
    sourceUrl: incidentSourceById[sourceId]?.url,
    updateType: sourceId.includes('replay') ? 'MLAT · 30 s replay snapshot' : 'MLAT · audited daily trace',
  }))
}

const g10Observations = incidentObservations('44c1e5')
const g17Observations = incidentObservations('44c1ea')

export const flights = [
  {
    id: 'g10-44c1e5',
    callSign: 'G10',
    registration: 'OO-POE',
    icao24: '44c1e5',
    label: 'Belgian Federal Police MD902',
    type: 'helicopter',
    status: 'Observed MLAT on 14 and 15 August; 15 August is a single-provider 30 s replay pending the full daily trace',
    color: '#2f80ed',
    source: 'Airplanes.live globe history',
    sourceUrl: 'https://globe.airplanes.live/?icao=44c1e5&showTrace=2026-08-15',
    sourceRetrievedAt: '2026-08-15T09:32:08.676Z',
    coverageWindows: ['14 Aug 15:38–15:47', '14 Aug 17:55–17:56', '14 Aug 19:07–19:27', '15 Aug 07:13–09:19'],
    start: '14 Aug 15:38',
    end: '15 Aug 09:19',
    drops: null,
    distance: null,
    pathMethod: 'Dashed straight connectors: ≤2 min gap and ≤160 kt implied speed',
    evidenceObservations: [
      {
        observedAt: '2026-08-14T15:37:08+02:00',
        timestampMs: Date.parse('2026-08-14T15:37:08+02:00'),
        kind: 'photo',
        state: 'airborne',
        label: 'G-10 visibly identified in BRF incident photo',
        sourceUrl: 'https://brf.be/regional/2099996/',
      },
    ],
    observations: g10Observations,
  },
  {
    id: 'g17-44c1ea',
    callSign: 'G17',
    registration: 'OO-POJ',
    icao24: '44c1ea',
    label: 'Belgian Federal Police MD902',
    type: 'helicopter',
    status: 'Observed by Airplanes.live MLAT over the incident area on 15 August; single-provider 30 s replay pending the full daily trace',
    color: '#137a9d',
    source: 'Airplanes.live globe history',
    sourceUrl: 'https://globe.airplanes.live/?icao=44c1ea&showTrace=2026-08-15',
    sourceRetrievedAt: '2026-08-15T09:32:08.676Z',
    coverageWindows: ['15 Aug 08:08–10:43'],
    start: '15 Aug 08:08',
    end: '15 Aug 10:43',
    drops: null,
    distance: null,
    pathMethod: 'Dashed straight connectors: ≤2 min gap and ≤160 kt implied speed',
    evidenceObservations: [],
    observations: g17Observations,
  },
  {
    id: 'g12-44c1e8',
    callSign: 'G12',
    registration: 'OO-POH',
    icao24: '44c1e8',
    label: 'Belgian Federal Police MD902',
    type: 'helicopter',
    status: 'Visibly identified landed in a timestamped BRF incident photo; no incident-area receiver path was found',
    color: '#7454b8',
    source: 'BRF incident photography',
    sourceUrl: 'https://brf.be/regional/2099996/',
    coverageWindows: [],
    start: '16:30',
    end: '16:30',
    drops: null,
    distance: null,
    evidenceObservations: [
      {
        observedAt: '2026-08-14T16:30:54+02:00',
        timestampMs: Date.parse('2026-08-14T16:30:54+02:00'),
        kind: 'photo',
        state: 'landed',
        label: 'G-12 photographed landed near the camera position',
        // This is the photographer's embedded GPS position, not a surveyed
        // helicopter coordinate. The aircraft is visibly nearby in the frame.
        cameraPosition: [50.5183972, 6.0637861],
        sourceUrl: 'https://brf.be/regional/2099996/',
      },
    ],
    observations: [],
  },
]

const narrativeEvents = [
  // No town or village was evacuated. The provincial order cleared the moorland
  // itself, and two hospitality businesses standing in it were evacuated. The
  // commune of Baelen's explicit denial is kept alongside them, because without
  // it the two evacuations read as the start of a residential evacuation.
  {
    frame: frameAt('2026-08-14T16:34:00+02:00'),
    time: '16:34',
    title: 'Venn ordered cleared, BE-Alert issued',
    detail: 'Liège provincial authorities seal the Venn areas of Baelen, Jalhay, Waimes and Malmedy: everyone present must leave the Hohes Venn immediately. No residential evacuation ordered.',
    type: 'evacuation',
    sourceUrl: 'https://www.vrt.be/vrtnws/de/2026/08/14/brand-im-hohen-venn-in-ostbelgien-provinzialer-notfallplan-aus/',
    sourceName: 'VRT NWS (DE), published 16:34, updated 18:34',
  },
  {
    frame: frameAt('2026-08-14T17:00:00+02:00'),
    time: '17:00',
    title: 'Baraque Michel and Mont Rigi evacuated',
    detail: 'The Baraque Michel restaurant and the Mont Rigi hotel-restaurant are evacuated on police instruction. Owner Nicolas Clinet: “On a commencé à évacuer les clients dès 17h.” Both are isolated businesses in the moorland, not settlements.',
    type: 'evacuation',
    sourceUrl: 'https://www.lavenir.net/regions/verviers/waimes/2026/08/14/le-mont-rigi-et-la-baraque-michel-evacues-a-cause-de-lincendie-dans-les-hautes-fagnes-la-nuit-va-etre-decisive-LOCGEEQ7EFFTXHCGJVWN354UVM/',
    sourceName: 'L’Avenir, published 14 Aug 22:30',
  },
  {
    frame: frameAt('2026-08-15T14:06:00+02:00'),
    time: '14:06',
    title: 'Regional nature park closed',
    detail: 'Official BE-Alert from Pv Liège, severity Severe: closure of the regional nature park. “Fermeture parc naturel régional — Naturpark geschlossen — natuurpark gesloten.” In force until 16:06 CEST.',
    type: 'closure',
    sourceUrl: 'https://publicalerts.be/CapGateway/alert/6a8056610ffd7333d4c0db68',
    sourceName: 'BE-Alert CAP 1.2, sent 15 Aug 14:06 CEST',
  },
  {
    frame: frameAt('2026-08-15T13:50:00+02:00'),
    time: '13:50',
    title: 'Sourbrodt put on evacuation standby',
    detail: 'Official BE-Alert, severity Severe, certainty Observed: “Par mesure de précaution, il est demandé aux habitants de préparer les effets essentiels à emporter en cas d’évacuation. Aucune évacuation n’est actuellement ordonnée.” In force until 14:50 CEST.',
    type: 'evacuation',
    sourceUrl: 'https://publicalerts.be/CapGateway/alert/6a8052880ffd7333d4bfbe69',
    sourceName: 'BE-Alert CAP 1.2, sent 15 Aug 13:50 CEST',
  },
  {
    frame: frameAt('2026-08-14T19:24:00+02:00'),
    time: '19:24',
    title: 'No population evacuation ordered',
    detail: 'The commune of Baelen states “Aucune évacuation n’a, pour l’heure, été ordonnée à Baelen.” Only the Fagnes itself is affected by the flames.',
    type: 'evacuation',
    sourceUrl: 'https://www.lalibre.be/dernieres-depeches/2026/08/14/secheresse-incendie-dans-les-fagnes-aucune-evacuation-de-la-population-na-ete-ordonnee-LMPG5PIWVZF6ZFVIDQHDFKLSI4/',
    sourceName: 'Belga via La Libre, 14 Aug 19:24',
  },
  {
    frame: frameAt('2026-08-14T13:06:00+02:00'),
    time: '13:06',
    title: 'Fire reported near Drossart',
    detail: 'Official incident start time · Governor of Liège',
    type: 'alert',
    sourceUrl: 'https://gouverneur.provincedeliege.be/fr/node/7923',
  },
  {
    frame: frameAt('2026-08-14T14:29:00+02:00'),
    time: '14:29',
    title: 'Two police helicopters reported',
    detail: 'Federal Police helicopters with Bambi Buckets · BRF',
    type: 'aircraft',
    sourceUrl: 'https://brf.be/regional/2099996/',
  },
  {
    frame: frameAt('2026-08-14T15:37:08+02:00'),
    time: '15:37',
    title: 'G10 photographed airborne',
    detail: 'Visible G-10 marking; timestamped incident photo · BRF',
    type: 'aircraft',
    sourceUrl: 'https://brf.be/regional/2099996/',
  },
  {
    frame: frameAt('2026-08-14T15:38:15+02:00'),
    time: '15:38',
    title: 'G10 MLAT observations begin',
    detail: 'First incident-area observation cluster · Airplanes.live',
    type: 'aircraft',
  },
  {
    frame: frameAt('2026-08-14T16:30:54+02:00'),
    time: '16:30',
    title: 'G12 photographed landed',
    detail: 'Visible G-12 marking; timestamped incident photo · BRF',
    type: 'aircraft',
    sourceUrl: 'https://brf.be/regional/2099996/',
  },
  {
    frame: frameAt('2026-08-14T17:55:39+02:00'),
    time: '17:55',
    title: 'G10 observed again',
    detail: 'Second MLAT observation cluster · Airplanes.live',
    type: 'aircraft',
  },
  {
    frame: frameAt('2026-08-14T19:07:32+02:00'),
    time: '19:07',
    title: 'G10 final observed cluster',
    detail: 'Coverage continues intermittently to 19:27 · Airplanes.live',
    type: 'aircraft',
  },
  {
    frame: frameAt('2026-08-15T07:13:00+02:00'),
    time: '07:13',
    title: 'G10 observations resume',
    detail: '15 Aug incident-area MLAT observations · Airplanes.live',
    type: 'aircraft',
  },
  {
    frame: frameAt('2026-08-15T08:08:00+02:00'),
    time: '08:08',
    title: 'G17 observations begin',
    detail: 'Federal Police helicopter over incident area · Airplanes.live',
    type: 'aircraft',
  },
  {
    frame: frameAt('2026-08-15T09:19:00+02:00'),
    time: '09:19',
    title: 'G10 last receiver observation',
    detail: 'No position or airborne state inferred after this fix',
    type: 'aircraft',
  },
  {
    frame: frameAt('2026-08-15T10:43:00+02:00'),
    time: '10:43',
    title: 'G17 last receiver observation',
    detail: 'No position or airborne state inferred after this fix',
    type: 'aircraft',
  },
  {
    frame: frameAt('2026-08-15T11:28:00+02:00'),
    time: '11:28',
    title: 'Firefighting helicopters operating',
    detail: 'Operational status reported; no drop coordinates published · BRF',
    type: 'aircraft',
    sourceUrl: 'https://brf.be/regional/2100196/',
  },
]

// Area figures are published once, in areaReports, and the incident log derives
// its entries from them. They used to be written twice -- once for the card and
// chart, once by hand for the log -- and drifted: the >1,500 ha update reached
// the card but never the log.
export function buildEvents(reportRows = areaReports) {
  const areaReportEvents = mergeAreaReports(reportRows).map((report) => ({
    frame: frameAt(new Date(report.timestampMs).toISOString()),
    time: localClockFormatter.format(new Date(report.timestampMs)),
    title: `${report.areaPrefix}${report.reportedHa.toLocaleString('en-GB')} ha reported affected`,
    detail: `${report.areaLabel} · ${report.source}`,
    type: 'area',
    sourceUrl: report.sourceUrl,
    sourceName: `${report.source}, ${report.areaLabel}`,
  }))
  return [...areaReportEvents, ...narrativeEvents]
}

export const events = buildEvents()


// No hand-drawn reserve polygon is bundled. The OpenStreetMap basemap remains the
// source for protected-area boundaries.
export const protectedArea = []

// The Drossart locality marker was removed. It plotted the place name used in
// the incident reports, not any fire measurement, and read as an ignition point.
// CENTER remains the measurement datum for every distance in this project: the
// ADS-B selection radii, the FIRMS bounding box and the station offsets all
// still reference it. Only the map marker is gone.
export const mapLabels = []

export const sourceLinks = [
  {
    name: 'Copernicus EFFIS',
    detail: '14/15 Aug VIIRS-derived daily geometry; calculated polygon area is not official fire size',
    cadence: 'Daily, no within-day acquisition time',
    url: 'https://forest-fire.emergency.copernicus.eu/about-effis/technical-background/rapid-damage-assessment',
    tone: 'effis',
  },
  {
    name: 'EFFIS 15 Aug WFS response',
    detail: 'Exact geometry response used for the locally calculated 4,857 ha polygon area',
    cadence: 'Retrieved 15 Aug 11:33 CEST',
    url: effisBurnedArea.sourceRequestUrl,
    tone: 'effis',
  },
  {
    name: 'EFFIS Current Situation Viewer',
    detail: 'Official map context; its sentinel2 URL parameter selects the Sentinel-2 Cloudless 2020 basemap, not an incident perimeter',
    cadence: 'Viewer reference',
    url: 'https://forest-fire.emergency.copernicus.eu/apps/effis.csv/?c=629562.19,6608535.18&z=8.544845581054688&t=sentinel2',
    tone: 'effis',
  },
  {
    name: 'Airplanes.live',
    detail: 'Historical ADS-B / MLAT observations for G10 and G17',
    cadence: '30 s replay slices; reception varies',
    url: 'https://airplanes.live/api/',
    tone: 'adsb',
  },
  {
    name: 'ADSB.lol',
    detail: 'Independent historical receiver-replay cross-check',
    cadence: '10 s retained replay slices',
    url: 'https://www.adsb.lol/docs/open-data/historical/',
    tone: 'adsb',
  },
  {
    name: 'Federal Police',
    detail: 'Official G10 fleet identity',
    cadence: 'Reference',
    url: 'https://www.police.be/5998/fr/a-propos/police-federale/police-administrative/appui-aerien',
    tone: 'adsb',
  },
  {
    name: 'Governor of Liège',
    detail: 'Official 13:06 incident start and dated ~60, ~100 and ~850 ha situation reports',
    cadence: 'Official situation reports',
    url: 'https://gouverneur.provincedeliege.be/fr/node/7923',
    tone: 'official',
  },
  {
    name: 'BRF',
    detail: 'Updated >900 ha report and helicopter operational context',
    cadence: 'Local reporting',
    url: 'https://brf.be/regional/2100196/',
    tone: 'report',
  },
  {
    name: 'Vedia',
    detail: 'Incident start and affected-area reporting',
    cadence: 'Local reporting',
    url: 'https://www.vedia.be/info/incendie-dans-les-fagnes-de-100-hectares-detruits-la-phase-provinciale-declenchee/213726',
    tone: 'report',
  },
  {
    name: 'DWD nearby wind stations',
    detail: 'Ten-minute observations from Aachen-Orsbach, Kall-Sistig and Roth bei Prüm, the complete DWD set within 40 km',
    cadence: '10 min values · preliminary recent/now feeds',
    url: dwdWindSnapshot.source.documentationUrl,
    tone: 'weather',
  },
  {
    name: 'RMI Mont Rigi station 6494',
    detail: 'Ten-minute station observations 4.2 km from Drossart; this near-real-time window is still awaiting RMI quality validation',
    cadence: '10 min · none of the bundled fields yet validated',
    url: montRigiSnapshot.source.requestUrl,
    tone: 'rmi',
  },
  {
    name: 'Open-Meteo',
    detail: 'Hourly Drossart grid model retained as fallback outside station coverage',
    cadence: 'Hourly model fallback',
    url: 'https://open-meteo.com/',
    tone: 'weather',
  },
  {
    name: 'NASA FIRMS',
    detail: 'Audited thermal-anomaly snapshot from four sensors; VIIRS hectares are confidence-sensitive footprint estimates',
    cadence: 'Satellite overpasses · server refresh every 15 min when configured',
    url: 'https://firms.modaps.eosdis.nasa.gov/',
    tone: 'nasa',
  },
]

export const initialLayers = {
  perimeter: true,
  aircraft: true,
  wind: true,
  rmiWind: true,
  protected: false,
}

export const incidentCenter = CENTER
