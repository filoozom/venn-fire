import { FIVE_MINUTES_MS } from '../src/data.js'
import { FIRMS_SENSORS } from '../src/firmsDetections.js'

export const WMS_MAX_SIZE = 2048
export const WMS_MAX_PIXELS = 2_097_152
export const WMS_CRS = ['CRS:84', 'EPSG:4326', 'EPSG:3857']
export const MERCATOR_LIMIT = 20037508.342789244

export function xml(value) {
  return String(value).replace(/[&<>"']/gu, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character])
}

export function wmsError(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status })
}

export function exceptionXml(error) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ServiceExceptionReport version="1.3.0" xmlns="http://www.opengis.net/ogc"><ServiceException code="${xml(error.code)}">${xml(error.message)}</ServiceException></ServiceExceptionReport>`
}

export function wmsParameters(url) {
  if (url.length > 16_384) throw wmsError('InvalidParameterValue', 'Request URL is too long', 414)
  const parameters = new Map()
  for (const [key, value] of new URL(url, 'http://localhost').searchParams) {
    const name = key.toUpperCase()
    if (parameters.has(name)) throw wmsError('InvalidParameterValue', `Repeated parameter: ${name}`)
    parameters.set(name, value)
  }
  if (parameters.get('SERVICE')?.toUpperCase() !== 'WMS') throw wmsError('InvalidParameterValue', 'SERVICE must be WMS')
  const operation = parameters.get('REQUEST')?.toLowerCase()
  if (!['getcapabilities', 'getmap'].includes(operation)) throw wmsError('OperationNotSupported', 'Supported requests: GetCapabilities, GetMap')
  return { parameters, operation }
}

function boundsFor(positions, fallback) {
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity
  for (const point of positions) {
    const [latitude, longitude] = point ?? []
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue
    west = Math.min(west, longitude)
    south = Math.min(south, latitude)
    east = Math.max(east, longitude)
    north = Math.max(north, latitude)
  }
  if (!Number.isFinite(west)) return fallback
  return [Math.max(-180, west - 0.01), Math.max(-90, south - 0.01), Math.min(180, east + 0.01), Math.min(90, north + 0.01)]
}

const SENSOR_NAMES = { viirsSnpp: 'viirs_snpp', viirsNoaa20: 'viirs_noaa20', viirsNoaa21: 'viirs_noaa21', modis: 'modis', meteosat: 'meteosat' }

export function wmsLayers(runtime, flights, detections) {
  const [latitude, longitude] = runtime.incidentCenter
  const incidentBounds = [longitude - 0.4, latitude - 0.3, longitude + 0.4, latitude + 0.3]
  const rasterBounds = (source) => boundsFor([
    ...(source.bounds ?? []),
    ...(source.frames ?? source.images ?? []).flatMap((row) => row.bounds ?? []),
  ], incidentBounds)
  const layers = [
    { name: 'best_estimate', key: 'fireOutline', title: 'Best estimate outline', type: 'estimate', abstract: 'Derived 50 m evidence union: black retained footprint under 30 days; red recent thermal or aircraft evidence under 24 hours. Not a field-confirmed perimeter.' },
    { name: 'effis_activity', key: 'perimeter', title: 'EFFIS activity envelope', type: 'effis', bounds: boundsFor(runtime.effisProducts.flatMap((row) => (row.rings ?? []).flat()), incidentBounds), abstract: 'Daily EFFIS activity envelope, fading over 72 hours since geometry changed. Not an official burned-area perimeter.' },
    { name: 'sentinel2_change', key: 'sentinel2BurnChange', title: 'Sentinel-2 observed change', type: 'sentinel2', abstract: 'Cloud-masked observed change, fading over 30 days. Cloud-obscured pixels remain unknown.' },
    { name: 'sentinel3_frp', key: 'sentinel3Frp', title: 'Sentinel-3 FRP measurements', type: 'sentinel3', abstract: 'Coordinate measurements only, fading over 24 hours. Catalogue previews are not detections; snapshots are empty when measurements are unavailable.' },
    { name: 'precipitation', key: 'rmiRadar', title: 'Precipitation radar', type: 'raster', bounds: rasterBounds(runtime.rmiRadar), abstract: 'RMI categorical radar or DWD RADOLAN YW five-minute precipitation, using the viewer selection and 60-minute fade.' },
    { name: 'gibs_true_color', key: 'gibsTrueColor', title: 'NASA VIIRS true colour', type: 'raster', bounds: rasterBounds(runtime.nasaGibs), abstract: 'NASA EOSDIS GIBS daily visual imagery, fading over 72 hours.' },
    { name: 'gibs_false_color', key: 'gibsFalseColor', title: 'NASA VIIRS false colour', type: 'raster', bounds: rasterBounds(runtime.nasaGibs), abstract: 'NASA EOSDIS GIBS daily short-wave-infrared imagery, fading over 72 hours.' },
    { name: 'cams_pm25', key: 'camsPm2p5', title: 'CAMS PM2.5 model', type: 'raster', bounds: rasterBounds(runtime.cams), abstract: 'Hourly valid time from the newest retained covering forecast cycle. Regional model, not a local measurement; three-hour fade.' },
    { name: 'cams_wildfire_pm10', key: 'camsWildfirePm10', title: 'CAMS wildfire-only PM10 model', type: 'raster', bounds: rasterBounds(runtime.cams), abstract: 'Experimental wildfire-only PM10 forecast. Hourly valid time from the newest retained covering cycle; three-hour fade.' },
    ...FIRMS_SENSORS.flatMap((sensor) => {
      const name = `firms_${SENSOR_NAMES[sensor.key]}`
      const bounds = boundsFor(detections.filter((row) => row.sensorKey === sensor.key).flatMap((row) => row.footprint ?? [row.position]), incidentBounds)
      const definition = { name, key: `firms:${sensor.key}`, title: sensor.name, type: 'firms', sensorKey: sensor.key, bounds, abstract: `NASA FIRMS thermal observations. ${sensor.key === 'meteosat' ? 'Approximate ground footprints; 15-minute fade.' : 'Sensor footprints; 24-hour fade.'} Not burned-area polygons. The parent includes all confidence levels.` }
      return [definition, ...['high', 'nominal', 'low'].map((confidence) => ({
        ...definition, name: `${name}_${confidence}`, title: `${sensor.name}: ${confidence} confidence`, confidence,
      }))]
    }),
    { name: 'aircraft', key: 'aircraft', title: 'Aircraft observations', type: 'aircraft', bounds: boundsFor(flights.flatMap((flight) => flight.observations?.map((row) => row.position) ?? flight.points ?? []), incidentBounds), abstract: 'Retained incident aircraft: exact fixes and plausible connectors, fading over 24 hours. Last observed position does not assert current airborne status.' },
    { name: 'wind_model', key: 'wind', title: 'Drossart model wind', type: 'wind', abstract: 'Open-Meteo hourly model wind, using the latest valid hour at or before TIME.' },
    { name: 'wind_mont_rigi', key: 'rmiWind', title: 'Mont Rigi station wind', type: 'wind', abstract: 'RMI station wind; observations older than 45 minutes are hidden.' },
    ...runtime.dwdWindStations.map((station) => ({
      name: `wind_dwd_${station.id}`, key: `dwdWind:${station.id}`, title: `${station.name} wind`, type: 'wind', stationId: station.id,
      bounds: boundsFor([[station.latitude, station.longitude]], incidentBounds), abstract: 'DWD ten-minute station wind; observations older than 90 minutes are hidden.',
    })),
    { name: 'protected_area', key: 'protected', title: 'High Fens protected area', type: 'protected', static: true, bounds: boundsFor(runtime.protectedArea, incidentBounds), abstract: 'Indicative reserve extent; static reference geometry.' },
  ]
  return layers.map((layer) => ({ bounds: incidentBounds, ...layer }))
}

export function mapRequest(parameters, layers, runtime) {
  const required = (key) => {
    if (!parameters.has(key)) throw wmsError('MissingParameterValue', `${key} is required`)
    return parameters.get(key)
  }
  if (required('VERSION') !== '1.3.0') throw wmsError('InvalidParameterValue', 'Supported WMS version: 1.3.0')
  const names = required('LAYERS').split(',')
  if (names.length > 32) throw wmsError('InvalidParameterValue', 'At most 32 layers per map')
  const selectedLayers = names.map((name) => {
    const layer = layers.find((entry) => entry.name === name)
    if (!layer) throw wmsError('LayerNotDefined', `Unknown layer: ${name}`)
    return layer
  })
  const styles = required('STYLES')
  if (styles && (styles.split(',').length !== names.length || styles.split(',').some((style) => style && style !== 'default'))) {
    throw wmsError('StyleNotDefined', 'Use the empty or default style for each layer')
  }
  if (parameters.has('SLD') || parameters.has('SLD_BODY')) throw wmsError('StyleNotDefined', 'Remote and inline styles are not supported')
  if (required('FORMAT') !== 'image/png') throw wmsError('InvalidFormat', 'Supported format: image/png')
  if (parameters.has('EXCEPTIONS') && parameters.get('EXCEPTIONS') !== 'XML') throw wmsError('InvalidFormat', 'Supported exception format: XML')
  const crs = required('CRS').toUpperCase()
  if (!WMS_CRS.includes(crs)) throw wmsError('InvalidCRS', `Supported CRS: ${WMS_CRS.join(', ')}`)
  const bboxParts = required('BBOX').split(',')
  let bbox = bboxParts.map(Number)
  if (bboxParts.length !== 4 || bboxParts.some((value) => !value.trim()) || !bbox.every(Number.isFinite)) throw wmsError('InvalidParameterValue', 'BBOX needs four finite numbers')
  // WMS 1.3 EPSG:4326 uses latitude,longitude; internal boxes always use x,y.
  if (crs === 'EPSG:4326') bbox = [bbox[1], bbox[0], bbox[3], bbox[2]]
  const [west, south, east, north] = bbox
  const maxX = crs === 'EPSG:3857' ? MERCATOR_LIMIT : 180
  const maxY = crs === 'EPSG:3857' ? MERCATOR_LIMIT : 90
  if (east <= west || north <= south || west < -maxX || east > maxX || south < -maxY || north > maxY) throw wmsError('InvalidParameterValue', 'BBOX is outside the CRS domain or has non-positive extent')
  const size = (key) => {
    const value = required(key)
    if (!/^\d+$/u.test(value) || Number(value) < 1 || Number(value) > WMS_MAX_SIZE) throw wmsError('InvalidParameterValue', `${key} must be between 1 and ${WMS_MAX_SIZE}`)
    return Number(value)
  }
  const width = size('WIDTH'), height = size('HEIGHT')
  if (width * height > WMS_MAX_PIXELS) throw wmsError('InvalidParameterValue', `Map exceeds ${WMS_MAX_PIXELS} pixels`)
  const transparent = (parameters.get('TRANSPARENT') ?? 'FALSE').toUpperCase()
  if (!['TRUE', 'FALSE'].includes(transparent)) throw wmsError('InvalidParameterValue', 'TRANSPARENT must be TRUE or FALSE')
  const background = parameters.get('BGCOLOR') ?? '0xFFFFFF'
  if (!/^0x[0-9a-f]{6}$/iu.test(background)) throw wmsError('InvalidParameterValue', 'BGCOLOR must be 0xRRGGBB')
  const start = runtime.timelineStartMs, end = runtime.frames.at(-1).timestampMs
  const time = parameters.get('TIME') ?? 'current'
  let timestampMs = end
  if (time !== 'current') {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(time)) throw wmsError('InvalidDimensionValue', 'TIME must be current or a single full UTC timestamp; ranges and daily aggregates are not supported')
    timestampMs = Date.parse(time)
    const normalized = time.length === 20 ? time.replace('Z', '.000Z') : time
    if (!Number.isFinite(timestampMs) || new Date(timestampMs).toISOString() !== normalized) throw wmsError('InvalidDimensionValue', 'Invalid UTC date')
  }
  if (timestampMs < start || timestampMs > end || (timestampMs - start) % FIVE_MINUTES_MS !== 0) {
    throw wmsError('InvalidDimensionValue', 'TIME must be an advertised five-minute snapshot between the timeline start and latest frame')
  }
  return { layers: selectedLayers, crs, bbox, width, height, timestampMs, transparent: transparent === 'TRUE', background: `#${background.slice(2)}` }
}

export function capabilitiesXml(layers, runtime, endpoint) {
  const start = new Date(runtime.timelineStartMs).toISOString()
  const end = new Date(runtime.frames.at(-1).timestampMs).toISOString()
  const online = `<OnlineResource xmlns:xlink="http://www.w3.org/1999/xlink" xlink:type="simple" xlink:href="${xml(endpoint)}?"/>`
  const operation = (name, format) => `<${name}><Format>${format}</Format><DCPType><HTTP><Get>${online}</Get></HTTP></DCPType></${name}>`
  const layerXml = (layer) => {
    const [west, south, east, north] = layer.bounds
    return `<Layer queryable="0" opaque="0"><Name>${xml(layer.name)}</Name><Title>${xml(layer.title)}</Title><Abstract>${xml(layer.abstract)} Snapshot reconstruction from currently retained evidence; missing or expired evidence is transparent.</Abstract>
<EX_GeographicBoundingBox><westBoundLongitude>${west}</westBoundLongitude><eastBoundLongitude>${east}</eastBoundLongitude><southBoundLatitude>${south}</southBoundLatitude><northBoundLatitude>${north}</northBoundLatitude></EX_GeographicBoundingBox>
<BoundingBox CRS="CRS:84" minx="${west}" miny="${south}" maxx="${east}" maxy="${north}"/>
<BoundingBox CRS="EPSG:4326" minx="${south}" miny="${west}" maxx="${north}" maxy="${east}"/>
${layer.static ? '' : `<Dimension name="time" units="ISO8601" default="${end}" multipleValues="0" nearestValue="0" current="1">${start}/${end}/PT5M</Dimension>`}
<Style><Name>default</Name><Title>Viewer style</Title></Style></Layer>`
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<WMS_Capabilities version="1.3.0" xmlns="http://www.opengis.net/wms" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.opengis.net/wms https://schemas.opengis.net/wms/1.3.0/capabilities_1_3_0.xsd">
<Service><Name>WMS</Name><Title>Venn Fire Watch</Title><Abstract>Independent incident overlays with five-minute historical map states. TIME describes observation/forecast validity, not what was known when the page was first published.</Abstract>${online}<Fees>none</Fees><AccessConstraints>Source attribution and source data terms apply.</AccessConstraints><LayerLimit>32</LayerLimit><MaxWidth>${WMS_MAX_SIZE}</MaxWidth><MaxHeight>${WMS_MAX_SIZE}</MaxHeight></Service>
<Capability><Request>${operation('GetCapabilities', 'text/xml')}${operation('GetMap', 'image/png')}</Request><Exception><Format>XML</Format></Exception>
<Layer><Title>Venn Fire Watch overlays</Title>${WMS_CRS.map((crs) => `<CRS>${crs}</CRS>`).join('')}${layers.map(layerXml).join('')}</Layer></Capability></WMS_Capabilities>`
}
