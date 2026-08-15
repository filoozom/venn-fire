const CENTER = [50.5932, 6.1938]

const perimeterShape = [
  [-0.0045, -0.0010],
  [-0.0038, 0.0037],
  [-0.0020, 0.0062],
  [0.0002, 0.0071],
  [0.0024, 0.0056],
  [0.0038, 0.0024],
  [0.0041, -0.0018],
  [0.0029, -0.0051],
  [0.0007, -0.0070],
  [-0.0018, -0.0062],
  [-0.0041, -0.0037],
]

function perimeter(scale, drift = [0, 0]) {
  return perimeterShape.map(([lat, lon]) => [
    CENTER[0] + lat * scale + drift[0],
    CENTER[1] + lon * scale + drift[1],
  ])
}

// Weather values are the hourly Open-Meteo model values for 50.593 N, 6.194 E.
// Fire areas are incident-report milestones / a reconstruction and are deliberately
// kept separate from the satellite detections below.
export const fireFrames = [
  { time: '2026-08-14T13:00:00+02:00', shortTime: '13:00', reportedHa: 4, areaLabel: 'initial estimate', confidence: 'Low', windSpeed: 8.6, windDirection: 338, gust: 26.6, humidity: 18, temperature: 30.3, perimeter: perimeter(0.18, [-0.0017, -0.0013]) },
  { time: '2026-08-14T14:00:00+02:00', shortTime: '14:00', reportedHa: 9, areaLabel: 'reconstructed', confidence: 'Low', windSpeed: 5.8, windDirection: 328, gust: 24.1, humidity: 17, temperature: 30.3, perimeter: perimeter(0.28, [-0.0014, -0.0010]) },
  { time: '2026-08-14T15:00:00+02:00', shortTime: '15:00', reportedHa: 18, areaLabel: 'reconstructed', confidence: 'Medium', windSpeed: 6.5, windDirection: 321, gust: 24.5, humidity: 17, temperature: 31.2, perimeter: perimeter(0.40, [-0.0011, -0.0007]) },
  { time: '2026-08-14T16:00:00+02:00', shortTime: '16:00', reportedHa: 34, areaLabel: 'reconstructed', confidence: 'Medium', windSpeed: 9.4, windDirection: 311, gust: 28.4, humidity: 16, temperature: 31.7, perimeter: perimeter(0.56, [-0.0008, -0.0004]) },
  { time: '2026-08-14T17:00:00+02:00', shortTime: '17:00', reportedHa: 55, areaLabel: 'reconstructed', confidence: 'Medium', windSpeed: 11.2, windDirection: 315, gust: 29.9, humidity: 17, temperature: 31.3, perimeter: perimeter(0.72, [-0.0005, -0.0001]) },
  { time: '2026-08-14T18:00:00+02:00', shortTime: '18:00', reportedHa: 80, areaLabel: 'local report', confidence: 'Reported', windSpeed: 11.2, windDirection: 353, gust: 28.1, humidity: 17, temperature: 31.0, perimeter: perimeter(0.88, [-0.0002, 0.0002]) },
  { time: '2026-08-14T19:00:00+02:00', shortTime: '19:00', reportedHa: 100, areaLabel: 'local report', confidence: 'Reported', windSpeed: 8.3, windDirection: 358, gust: 20.9, humidity: 17, temperature: 30.5, perimeter: perimeter(1.0) },
  { time: '2026-08-14T20:00:00+02:00', shortTime: '20:00', reportedHa: 100, areaLabel: 'latest reported', confidence: 'Reported', windSpeed: 11.5, windDirection: 6, gust: 24.8, humidity: 23, temperature: 28.8, perimeter: perimeter(1.01, [0.0001, 0.0001]) },
  { time: '2026-08-14T21:00:00+02:00', shortTime: '21:00', reportedHa: 100, areaLabel: 'latest reported', confidence: 'Reported', windSpeed: 6.5, windDirection: 34, gust: 11.2, humidity: 29, temperature: 25.3, perimeter: perimeter(1.01, [0.0001, 0.0001]) },
  { time: '2026-08-14T22:00:00+02:00', shortTime: '22:00', reportedHa: 100, areaLabel: 'latest reported', confidence: 'Reported', windSpeed: 5.4, windDirection: 46, gust: 9.0, humidity: 30, temperature: 23.8, perimeter: perimeter(1.01, [0.0001, 0.0001]) },
  { time: '2026-08-14T23:00:00+02:00', shortTime: '23:00', reportedHa: 100, areaLabel: 'latest reported', confidence: 'Reported', windSpeed: 5.4, windDirection: 70, gust: 9.4, humidity: 33, temperature: 22.7, perimeter: perimeter(1.01, [0.0001, 0.0001]) },
  { time: '2026-08-15T00:00:00+02:00', shortTime: '00:00', reportedHa: 100, areaLabel: 'latest reported', confidence: 'Reported', windSpeed: 4.7, windDirection: 122, gust: 9.4, humidity: 36, temperature: 21.5, perimeter: perimeter(1.01, [0.0001, 0.0001]) },
  { time: '2026-08-15T01:00:00+02:00', shortTime: '01:00', reportedHa: 100, areaLabel: 'latest reported', confidence: 'Reported', windSpeed: 4.3, windDirection: 87, gust: 7.9, humidity: 35, temperature: 21.2, perimeter: perimeter(1.01, [0.0001, 0.0001]) },
  { time: '2026-08-15T02:00:00+02:00', shortTime: '02:00', reportedHa: 100, areaLabel: 'latest reported', confidence: 'Reported', windSpeed: 4.3, windDirection: 176, gust: 7.6, humidity: 38, temperature: 20.2, perimeter: perimeter(1.01, [0.0001, 0.0001]) },
]

export const hotspots = [
  { position: [50.5919, 6.1925], frame: 1, confidence: 'nominal', sensor: 'VIIRS 375 m', frp: 4.2 },
  { position: [50.5934, 6.1952], frame: 2, confidence: 'nominal', sensor: 'VIIRS 375 m', frp: 7.8 },
  { position: [50.5908, 6.1971], frame: 3, confidence: 'high', sensor: 'VIIRS 375 m', frp: 12.4 },
  { position: [50.5951, 6.1907], frame: 3, confidence: 'nominal', sensor: 'VIIRS 375 m', frp: 8.1 },
  { position: [50.5962, 6.1968], frame: 4, confidence: 'high', sensor: 'VIIRS 375 m', frp: 18.6 },
  { position: [50.5897, 6.1889], frame: 5, confidence: 'nominal', sensor: 'VIIRS 375 m', frp: 6.7 },
  { position: [50.5944, 6.2001], frame: 5, confidence: 'high', sensor: 'VIIRS 375 m', frp: 21.3 },
  { position: [50.5971, 6.1927], frame: 6, confidence: 'nominal', sensor: 'VIIRS 375 m', frp: 9.6 },
  { position: [50.5913, 6.2012], frame: 6, confidence: 'nominal', sensor: 'VIIRS 375 m', frp: 5.4 },
]

export const flights = [
  {
    id: 'heli-01',
    callSign: 'HELI 01',
    label: 'Federal support helicopter',
    type: 'helicopter',
    status: 'Track reconstruction',
    color: '#2f80ed',
    startFrame: 4,
    endFrame: 9,
    start: '17:08',
    end: '21:32',
    drops: 7,
    distance: '64 km',
    points: [
      [50.6162, 6.1164], [50.6109, 6.1310], [50.6040, 6.1534], [50.5973, 6.1788],
      [50.5935, 6.1934], [50.5904, 6.1962], [50.5977, 6.1785], [50.6072, 6.1455],
      [50.6160, 6.1167], [50.6070, 6.1467], [50.5970, 6.1791], [50.5940, 6.1951],
    ],
  },
  {
    id: 'heli-02',
    callSign: 'HELI 02',
    label: 'Cross-border support helicopter',
    type: 'helicopter',
    status: 'Track reconstruction',
    color: '#805ad5',
    startFrame: 6,
    endFrame: 13,
    start: '19:12',
    end: '01:18',
    drops: 5,
    distance: '52 km',
    points: [
      [50.6445, 6.2054], [50.6292, 6.2087], [50.6124, 6.2031], [50.5980, 6.1970],
      [50.5938, 6.1940], [50.6020, 6.1773], [50.6158, 6.1350], [50.6161, 6.1167],
      [50.6079, 6.1484], [50.5987, 6.1812], [50.5930, 6.1947], [50.6080, 6.2021],
    ],
  },
  {
    id: 'recon-03',
    callSign: 'RECON 03',
    label: 'Incident reconnaissance',
    type: 'plane',
    status: 'Illustrative / unverified',
    color: '#d69e2e',
    startFrame: 2,
    endFrame: 5,
    start: '15:23',
    end: '17:41',
    drops: 0,
    distance: '81 km',
    points: [
      [50.6840, 6.0800], [50.6530, 6.1310], [50.6200, 6.1730], [50.5930, 6.1940],
      [50.5750, 6.1720], [50.5820, 6.1390], [50.6080, 6.1290], [50.6240, 6.1740],
      [50.6010, 6.2130], [50.5810, 6.1920], [50.5960, 6.1540], [50.6380, 6.1080],
    ],
  },
]

export const events = [
  { frame: 0, time: '13:07', title: 'First smoke report', detail: 'Pilgerweg / Allgemeines Venn', type: 'alert' },
  { frame: 2, time: '15:18', title: 'Satellite overpass window', detail: 'VIIRS thermal detections', type: 'satellite' },
  { frame: 3, time: '16:26', title: 'Access restrictions expanded', detail: 'High Fens reserve', type: 'closure' },
  { frame: 4, time: '17:08', title: 'Aerial support begins', detail: 'Track reconstruction starts', type: 'aircraft' },
  { frame: 5, time: '18:34', title: '80 ha reported affected', detail: 'Local incident update', type: 'area' },
  { frame: 6, time: '19:12', title: 'Second helicopter on scene', detail: 'Cross-border support', type: 'aircraft' },
  { frame: 6, time: '19:46', title: '~100 ha reported', detail: 'Latest cited area estimate', type: 'area' },
  { frame: 8, time: '21:16', title: 'Wind shifts to NNE', detail: 'Lower mean speed, 6.5 km/h', type: 'wind' },
  { frame: 11, time: '00:32', title: 'Night monitoring phase', detail: 'Perimeter held in reconstruction', type: 'monitor' },
]

export const protectedArea = [
  [50.5650, 6.1430], [50.5790, 6.1310], [50.6010, 6.1370], [50.6170, 6.1600],
  [50.6190, 6.1960], [50.6080, 6.2260], [50.5810, 6.2320], [50.5610, 6.2090],
]

export const mapLabels = [
  { name: 'Eupen', position: [50.6302, 6.0313], kind: 'city' },
  { name: 'Baelen', position: [50.6301, 5.9741], kind: 'city' },
  { name: 'Membach', position: [50.6191, 6.0016], kind: 'town' },
  { name: 'Roetgen', position: [50.6483, 6.1992], kind: 'town' },
  { name: 'Mützenich', position: [50.5664, 6.2243], kind: 'town' },
  { name: 'Haus Ternell', position: [50.5858, 6.1294], kind: 'poi' },
  { name: 'Eupen Reservoir', position: [50.6161, 6.1166], kind: 'water' },
  { name: 'Pilgerweg', position: [50.5912, 6.1880], kind: 'poi' },
]

export const sourceLinks = [
  {
    name: 'NASA FIRMS',
    detail: 'VIIRS / MODIS thermal anomalies',
    cadence: '15 min service updates',
    url: 'https://firms.modaps.eosdis.nasa.gov/',
    tone: 'nasa',
  },
  {
    name: 'Open-Meteo',
    detail: 'Hourly wind model at incident point',
    cadence: 'Hourly',
    url: 'https://open-meteo.com/',
    tone: 'weather',
  },
  {
    name: 'RMI Belgium',
    detail: 'Official synoptic wind observations',
    cadence: 'Hourly observations',
    url: 'https://opendata.meteo.be/',
    tone: 'rmi',
  },
  {
    name: 'ADS-B import',
    detail: 'Historical aircraft track files',
    cadence: 'Coverage dependent',
    url: 'https://www.adsbexchange.com/data/',
    tone: 'adsb',
  },
]

export const initialLayers = {
  perimeter: true,
  hotspots: true,
  aircraft: true,
  wind: true,
  protected: true,
}

export const incidentCenter = CENTER
