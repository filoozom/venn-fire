#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const DEFAULTS = {
  date: '2026-08-14',
  output: '.local-data/effis/2026-08-14',
  minLat: 50.45,
  maxLat: 50.70,
  minLon: 5.90,
  maxLon: 6.25,
}

const SOURCE = {
  name: 'Copernicus EFFIS near-real-time burnt area (VIIRS-derived)',
  endpoint: 'https://maps.effis.emergency.copernicus.eu/effis',
  layer: 'ms:effis.nrt.ba.poly',
  documentation: 'https://forest-fire.emergency.copernicus.eu/applications/data-and-services',
}

const DROSSART = { latitude: 50.54762, longitude: 6.05757 }
const EARTH_RADIUS_M = 6_371_008.8

function parseArgs(argv) {
  const options = { ...DEFAULTS }
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === '--') continue
    const key = argv[index].replace(/^--/, '')
    const value = argv[index + 1]
    if (!(key in options) || value == null) throw new Error(`Unknown or incomplete argument: ${argv[index]}`)
    options[key] = key === 'date' || key === 'output' ? value : Number(value)
    index += 1
  }
  return options
}

function requestUrl(options) {
  const query = new URLSearchParams({
    SERVICE: 'WFS',
    VERSION: '1.1.0',
    REQUEST: 'GetFeature',
    TYPENAME: SOURCE.layer,
    SRSNAME: 'EPSG:4326',
    OUTPUTFORMAT: 'geojson',
    TIME: options.date,
    // WFS 1.1 uses latitude/longitude axis order for EPSG:4326 on this server.
    BBOX: `${options.minLat},${options.minLon},${options.maxLat},${options.maxLon},EPSG:4326`,
  })
  return `${SOURCE.endpoint}?${query}`
}

function ringsFor(geometry) {
  if (geometry.type === 'Polygon') return geometry.coordinates
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.flat()
  return []
}

function pointsFor(geometry) {
  return ringsFor(geometry).flat()
}

function haversineKm([longitude, latitude]) {
  const radians = Math.PI / 180
  const deltaLat = (latitude - DROSSART.latitude) * radians
  const deltaLon = (longitude - DROSSART.longitude) * radians
  const value = Math.sin(deltaLat / 2) ** 2
    + Math.cos(DROSSART.latitude * radians) * Math.cos(latitude * radians) * Math.sin(deltaLon / 2) ** 2
  return EARTH_RADIUS_M / 1000 * 2 * Math.asin(Math.sqrt(value))
}

function ringAreaSquareMetres(ring) {
  if (ring.length < 4) return 0
  const latitudeOrigin = ring.reduce((sum, coordinate) => sum + coordinate[1], 0) / ring.length
  const cosLatitude = Math.cos(latitudeOrigin * Math.PI / 180)
  const projected = ring.map(([longitude, latitude]) => [
    EARTH_RADIUS_M * longitude * Math.PI / 180 * cosLatitude,
    EARTH_RADIUS_M * latitude * Math.PI / 180,
  ])
  return Math.abs(projected.reduce((sum, point, index) => {
    const next = projected[(index + 1) % projected.length]
    return sum + point[0] * next[1] - next[0] * point[1]
  }, 0) / 2)
}

function polygonAreaHectares(coordinates) {
  const [outer, ...holes] = coordinates
  return (ringAreaSquareMetres(outer) - holes.reduce((sum, ring) => sum + ringAreaSquareMetres(ring), 0)) / 10_000
}

function geometryAreaHectares(geometry) {
  if (geometry.type === 'Polygon') return polygonAreaHectares(geometry.coordinates)
  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates.reduce((sum, polygon) => sum + polygonAreaHectares(polygon), 0)
  }
  return 0
}

function geometryBounds(geometry) {
  const points = pointsFor(geometry)
  return {
    minLat: Math.min(...points.map((point) => point[1])),
    maxLat: Math.max(...points.map((point) => point[1])),
    minLon: Math.min(...points.map((point) => point[0])),
    maxLon: Math.max(...points.map((point) => point[0])),
  }
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function main() {
  const options = parseArgs(process.argv)
  const url = requestUrl(options)
  const response = await fetch(url, { headers: { accept: 'application/geo+json, application/json' } })
  if (!response.ok) throw new Error(`EFFIS returned HTTP ${response.status}`)
  const collection = await response.json()
  if (collection.type !== 'FeatureCollection') throw new Error('EFFIS did not return a GeoJSON FeatureCollection')

  const ranked = collection.features
    .filter((feature) => feature.geometry && pointsFor(feature.geometry).length)
    .map((feature) => ({
      feature,
      nearestDrossartKm: Math.min(...pointsFor(feature.geometry).map(haversineKm)),
    }))
    .sort((left, right) => left.nearestDrossartKm - right.nearestDrossartKm)

  const selected = ranked[0]
  if (!selected || selected.nearestDrossartKm > 10) {
    throw new Error('No EFFIS burnt-area feature was found within 10 km of Drossart')
  }

  const outputDir = path.resolve(options.output)
  await mkdir(outputDir, { recursive: true })
  await writeJson(path.join(outputDir, 'source-response.geojson'), collection)

  const normalized = {
    schemaVersion: 1,
    source: SOURCE,
    sourceRequest: url,
    retrievedAt: new Date().toISOString(),
    productDate: options.date,
    locationReference: { name: 'Drossart locality', ...DROSSART },
    searchBounds: {
      minLat: options.minLat,
      maxLat: options.maxLat,
      minLon: options.minLon,
      maxLon: options.maxLon,
    },
    sourceFeatureCount: collection.features.length,
    selectedFeature: {
      ...selected.feature,
      properties: {
        ...selected.feature.properties,
        calculated_area_ha: geometryAreaHectares(selected.feature.geometry),
        nearest_drossart_vertex_km: selected.nearestDrossartKm,
        bounds: geometryBounds(selected.feature.geometry),
        product_date: options.date,
        source: SOURCE.name,
      },
    },
    interpretation: [
      'The polygon is an EFFIS/GWIS near-real-time product derived by clustering VIIRS thermal-anomaly detections.',
      'The area is calculated locally from the published polygon geometry; EFFIS exposes no area attribute for this feature.',
      'The daily product does not expose within-day perimeter timestamps, so it must not be used as five-minute fire progression.',
      'Near-real-time satellite-derived burnt area is not an operational incident-command perimeter.',
    ],
  }

  await writeJson(path.join(outputDir, 'incident-burned-area.geojson'), {
    type: 'FeatureCollection',
    features: [normalized.selectedFeature],
  })
  await writeJson(path.join(outputDir, 'manifest.json'), normalized)
  process.stdout.write(`${JSON.stringify({
    output: outputDir,
    sourceFeatureCount: normalized.sourceFeatureCount,
    areaHa: normalized.selectedFeature.properties.calculated_area_ha,
    nearestDrossartVertexKm: normalized.selectedFeature.properties.nearest_drossart_vertex_km,
    bounds: normalized.selectedFeature.properties.bounds,
  }, null, 2)}\n`)
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`)
  process.exitCode = 1
})
