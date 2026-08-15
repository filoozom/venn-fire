import nearbyTrafficSummary from './nearbyTrafficSummary.json'

const CENTER = [50.54762, 6.05757]
const FIVE_MINUTES_MS = 5 * 60 * 1000
export const AIRCRAFT_PATH_MAX_GAP_MS = 2 * 60 * 1000
export const AIRCRAFT_PATH_MAX_SPEED_KT = 160
const TIMELINE_START_MS = Date.parse('2026-08-14T13:00:00+02:00')
const TIMELINE_END_MS = Date.parse('2026-08-15T02:00:00+02:00')
const REPORTED_AREA_AT_MS = Date.parse('2026-08-14T20:32:00+02:00')

export { effisBurnedArea } from './effisBurnedArea'

// Open-Meteo historical-forecast model values for 50.548 N, 6.061 E,
// rechecked at 04:55 CEST on 15 August 2026. Entries run from 13:00 CEST on
// 14 August through 02:00 CEST on 15 August, one value per local clock hour.
const hourlyWeather = [
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
]

function clockLabel(index) {
  const totalMinutes = 13 * 60 + index * 5
  const hours = Math.floor(totalMinutes / 60) % 24
  const minutes = totalMinutes % 60
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

export const fireFrames = Array.from(
  { length: Math.floor((TIMELINE_END_MS - TIMELINE_START_MS) / FIVE_MINUTES_MS) + 1 },
  (_, index) => {
    const timestampMs = TIMELINE_START_MS + index * FIVE_MINUTES_MS
    const weather = hourlyWeather[Math.min(hourlyWeather.length - 1, Math.floor(index / 12))]
    const areaReported = timestampMs >= REPORTED_AREA_AT_MS
    return {
      time: new Date(timestampMs).toISOString(),
      timestampMs,
      shortTime: clockLabel(index),
      dayLabel: timestampMs < Date.parse('2026-08-15T00:00:00+02:00') ? '14 AUG' : '15 AUG',
      dateLabel: timestampMs < Date.parse('2026-08-15T00:00:00+02:00') ? 'Friday, 14 August 2026' : 'Saturday, 15 August 2026',
      reportedHa: areaReported ? 100 : null,
      areaLabel: areaReported ? 'reported by 20:32 CEST' : 'no quantified report yet',
      confidence: areaReported ? 'Reported' : 'Unknown',
      ...weather,
    }
  },
)

function frameAt(isoTimestamp) {
  return Math.max(0, Math.min(
    fireFrames.length - 1,
    Math.ceil((Date.parse(isoTimestamp) - TIMELINE_START_MS) / FIVE_MINUTES_MS),
  ))
}

// There is no bundled FIRMS result. Detections are shown only after a real API
// response is loaded in the browser.
export const hotspots = []

export const nearbyTrafficMeta = {
  schemaVersion: nearbyTrafficSummary.schemaVersion,
  generatedAt: nearbyTrafficSummary.generatedAt,
  incidentDate: nearbyTrafficSummary.incidentDate,
  selection: nearbyTrafficSummary.selection,
  sources: nearbyTrafficSummary.sources,
  aircraftCount: nearbyTrafficSummary.aircraftCount,
  lowLevelAircraftCount: nearbyTrafficSummary.lowLevelAircraftCount,
  overflightAircraftCount: nearbyTrafficSummary.overflightAircraftCount,
  observationCount: nearbyTrafficSummary.observationCount,
  interpretation: nearbyTrafficSummary.interpretation,
}

// Union of every non-incident identifier observed within 5 km of Drossart in
// either retained receiver replay. Geometry is kept to exact source samples
// within 10 km for entry/exit context. G10 is excluded because its more strongly
// sourced incident representation is maintained separately below.
export function normalizeNearbyTrafficSnapshot(snapshot) {
  const trafficSourceById = Object.fromEntries(snapshot.sources.map((source) => [source.id, source]))
  return snapshot.aircraft.map((aircraft) => {
    const source = trafficSourceById[aircraft.geometrySource]
    return {
      ...aircraft,
      label: aircraft.description || aircraft.aircraftType || 'Unclassified receiver-observed aircraft',
      type: 'traffic',
      color: aircraft.classification === 'low-level' ? '#9b6b20' : '#657b88',
      status: `${aircraft.missionStatus}; ${aircraft.classification === 'low-level' ? 'altitude-filtered nearby traffic' : 'high-altitude overflight'}`,
      source: source?.name || aircraft.geometrySource,
      sourceUrl: source?.website || null,
      pathMethod: aircraft.classification === 'low-level'
        ? 'Exact replay samples; links require ≤90 s gap and ≤250 kt implied speed'
        : 'Exact replay samples; links require ≤90 s gap and ≤700 kt implied speed',
      observations: aircraft.observations.map((observation) => ({
        observedAt: observation.observedAt,
        timestampMs: Date.parse(observation.observedAt),
        position: [observation.latitude, observation.longitude],
        altitudeFt: observation.altitudeFt,
        distanceDrossartKm: observation.distanceDrossartKm,
        updateType: 'receiver replay snapshot',
      })),
    }
  })
}

// Exact Airplanes.live MLAT observations inside the broad incident search area.
// They are points, not an interpolated path. The map may join two consecutive
// points with a dashed straight connector only when the gap is <= 2 minutes and
// the implied speed is <= 160 kt. It never bridges a reception gap.
const g10Observations = [
  ['2026-08-14T13:38:15.750Z', 50.521941, 6.078803, 2400],
  ['2026-08-14T13:38:22.460Z', 50.516669, 6.074526, 2400],
  ['2026-08-14T13:38:34.270Z', 50.520168, 6.069050, 2400],
  ['2026-08-14T13:38:44.310Z', 50.538008, 6.070774, 2400],
  ['2026-08-14T13:39:15.950Z', 50.551977, 6.072269, 2300],
  ['2026-08-14T13:39:42.560Z', 50.543633, 6.077209, 2200],
  ['2026-08-14T13:40:58.310Z', 50.520087, 6.057261, 2300],
  ['2026-08-14T13:42:34.620Z', 50.568727, 6.078311, 2200],
  ['2026-08-14T13:43:13.330Z', 50.549070, 6.055296, 2100],
  ['2026-08-14T13:44:33.140Z', 50.550808, 6.061617, 1900],
  ['2026-08-14T13:47:13.260Z', 50.538072, 6.050555, 1900],
  ['2026-08-14T15:55:39.630Z', 50.541514, 6.105832, 2300],
  ['2026-08-14T15:56:03.190Z', 50.554369, 6.099623, 2400],
  ['2026-08-14T15:56:18.690Z', 50.566137, 6.099951, 2500],
  ['2026-08-14T15:56:46.140Z', 50.558978, 6.084347, 2500],
  ['2026-08-14T17:07:32.710Z', 50.517032, 6.110781, 2200],
  ['2026-08-14T17:08:15.120Z', 50.541705, 6.104886, 2200],
  ['2026-08-14T17:08:44.430Z', 50.529479, 6.087585, 2200],
  ['2026-08-14T17:16:51.660Z', 50.564184, 6.102402, 2200],
  ['2026-08-14T17:26:43.490Z', 50.540709, 6.074895, 2400],
  ['2026-08-14T17:27:43.360Z', 50.552538, 6.069688, 2300],
].map(([observedAt, latitude, longitude, altitudeFt]) => ({
  observedAt,
  timestampMs: Date.parse(observedAt),
  position: [latitude, longitude],
  altitudeFt,
  updateType: 'MLAT',
}))

export const flights = [
  {
    id: 'g10-44c1e5',
    callSign: 'G10',
    registration: 'OO-POE',
    icao24: '44c1e5',
    label: 'Belgian Federal Police MD902',
    type: 'helicopter',
    status: 'Observed MLAT; incident role strongly corroborated, not an official mission log',
    color: '#2f80ed',
    source: 'Airplanes.live globe history',
    sourceUrl: 'https://globe.airplanes.live/?icao=44c1e5&showTrace=2026-08-14',
    coverageWindows: ['15:38–15:47', '17:55–17:56', '19:07–19:27'],
    start: '15:38',
    end: '19:27',
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

export const events = [
  {
    frame: frameAt('2026-08-14T13:06:00+02:00'),
    time: '13:06',
    title: 'Fire reported near Drossart',
    detail: 'Reported incident start · Vedia',
    type: 'alert',
    sourceUrl: 'https://www.vedia.be/info/incendie-dans-les-fagnes-de-100-hectares-detruits-la-phase-provinciale-declenchee/213726',
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
    frame: frameAt('2026-08-14T20:32:00+02:00'),
    time: '20:32',
    title: '~100 ha reported affected',
    detail: 'Reported estimate, not a measured perimeter · BRF / Vedia',
    type: 'area',
    sourceUrl: 'https://brf.be/regional/2099996/',
  },
]

// No hand-drawn reserve polygon is bundled. The OpenStreetMap basemap remains the
// source for protected-area boundaries.
export const protectedArea = []

export const mapLabels = [
  { name: 'Drossart · reported fire locality', position: CENTER, kind: 'poi' },
]

export const sourceLinks = [
  {
    name: 'Copernicus EFFIS',
    detail: '14 Aug VIIRS-derived near-real-time footprint',
    cadence: 'Daily reference layer',
    url: 'https://forest-fire.emergency.copernicus.eu/about-effis/technical-background/rapid-damage-assessment',
    tone: 'effis',
  },
  {
    name: 'Airplanes.live',
    detail: 'Historical ADS-B / MLAT observations',
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
    name: 'BRF',
    detail: 'Incident and helicopter reporting',
    cadence: 'Local reporting',
    url: 'https://brf.be/regional/2099996/',
    tone: 'rmi',
  },
  {
    name: 'Vedia',
    detail: 'Incident start and affected-area reporting',
    cadence: 'Local reporting',
    url: 'https://www.vedia.be/info/incendie-dans-les-fagnes-de-100-hectares-detruits-la-phase-provinciale-declenchee/213726',
    tone: 'rmi',
  },
  {
    name: 'Open-Meteo',
    detail: 'Hourly model at Drossart (50.548 N, 6.061 E)',
    cadence: 'Hourly model values',
    url: 'https://open-meteo.com/',
    tone: 'weather',
  },
  {
    name: 'NASA FIRMS',
    detail: 'No bundled detections; connect a MAP_KEY to query',
    cadence: 'Observation dependent',
    url: 'https://firms.modaps.eosdis.nasa.gov/',
    tone: 'nasa',
  },
]

export const initialLayers = {
  perimeter: true,
  hotspots: true,
  aircraft: true,
  traffic: false,
  wind: true,
  protected: false,
}

export const incidentCenter = CENTER
