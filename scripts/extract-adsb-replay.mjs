#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const MAGIC = 0x0e7f7c9d
const DEFAULT_SOURCE_ROOT = 'https://globe.airplanes.live/globe_history'
const DEFAULT_BOUNDS = {
  minLat: 50.47,
  maxLat: 50.61,
  minLon: 5.96,
  maxLon: 6.22,
}

function parseArgs(argv) {
  const values = {
    date: '2026-08-14',
    sourceRoot: DEFAULT_SOURCE_ROOT,
    output: '.local-data/airplanes-live/2026-08-14/area-scan.json',
    firstChunk: 22,
    lastChunk: 22,
    ...DEFAULT_BOUNDS,
  }

  for (let index = 2; index < argv.length; index += 1) {
    const key = argv[index].replace(/^--/, '')
    const value = argv[index + 1]
    if (!(key in values) || value == null) continue
    values[key] = ['date', 'sourceRoot', 'output'].includes(key) ? value : Number(value)
    index += 1
  }
  return values
}

function decodeCallsign(bytes, offset) {
  let value = ''
  for (let index = 0; index < 8; index += 1) {
    const byte = bytes[offset + index]
    if (byte) value += String.fromCharCode(byte)
  }
  return value.trim()
}

function parseReplay(buffer, bounds, metadata) {
  if (buffer.byteLength % 16 !== 0) throw new Error('Replay payload is not aligned to 16-byte records')

  const points = new Int32Array(buffer)
  const pointsU = new Uint32Array(buffer)
  const pointsU8 = new Uint8Array(buffer)
  const slices = []
  const observations = []

  for (let index = 0; index < points.length; index += 4) {
    if (points[index] === MAGIC) slices.push(index)
  }
  if (!slices.length) throw new Error('Replay payload does not contain the expected magic header')

  for (const sliceStart of slices) {
    const observedAt = pointsU[sliceStart + 2] / 1000 + pointsU[sliceStart + 1] * 4294967.296
    const interval = (pointsU[sliceStart + 3] & 65535) / 1000

    for (let index = sliceStart + 4; index < points.length && points[index] !== MAGIC; index += 4) {
      const latRaw = points[index + 1]
      const lonRaw = points[index + 2]
      const rawHex = points[index] & 0xffffff
      const hex = `${(points[index] & (1 << 24)) ? '~' : ''}${rawHex.toString(16).padStart(6, '0')}`

      if (latRaw >= 1073741824) {
        const callsign = pointsU8[4 * (index + 2)] ? decodeCallsign(pointsU8, 4 * (index + 2)) : ''
        const squawk = (latRaw & 0xffff).toString(10).padStart(4, '0')
        metadata.set(hex, { ...metadata.get(hex), callsign, squawk })
        continue
      }

      const lat = latRaw / 1e6
      const lon = lonRaw / 1e6
      if (lat < bounds.minLat || lat > bounds.maxLat || lon < bounds.minLon || lon > bounds.maxLon) continue

      let altitude = points[index + 3] & 65535
      if (altitude & 32768) altitude |= -65536
      if (altitude === -123) altitude = 'ground'
      else if (altitude === -124) altitude = null
      else altitude *= 25

      let groundSpeed = points[index + 3] >> 16
      groundSpeed = groundSpeed === -1 ? null : groundSpeed / 10

      observations.push({
        hex,
        observedAt,
        interval,
        lat,
        lon,
        altitude,
        groundSpeed,
      })
    }
  }

  return observations
}

function summarize(observations, metadata) {
  const aircraft = new Map()
  for (const observation of observations) {
    if (!aircraft.has(observation.hex)) {
      aircraft.set(observation.hex, {
        hex: observation.hex,
        count: 0,
        first: observation.observedAt,
        last: observation.observedAt,
        minAltitude: Number.POSITIVE_INFINITY,
        maxAltitude: Number.NEGATIVE_INFINITY,
        minSpeed: Number.POSITIVE_INFINITY,
        maxSpeed: Number.NEGATIVE_INFINITY,
      })
    }
    const item = aircraft.get(observation.hex)
    item.count += 1
    item.first = Math.min(item.first, observation.observedAt)
    item.last = Math.max(item.last, observation.observedAt)
    if (typeof observation.altitude === 'number') {
      item.minAltitude = Math.min(item.minAltitude, observation.altitude)
      item.maxAltitude = Math.max(item.maxAltitude, observation.altitude)
    }
    if (typeof observation.groundSpeed === 'number') {
      item.minSpeed = Math.min(item.minSpeed, observation.groundSpeed)
      item.maxSpeed = Math.max(item.maxSpeed, observation.groundSpeed)
    }
  }

  return [...aircraft.values()]
    .map((item) => ({
      ...item,
      ...metadata.get(item.hex),
      first: new Date(item.first * 1000).toISOString(),
      last: new Date(item.last * 1000).toISOString(),
      minAltitude: Number.isFinite(item.minAltitude) ? item.minAltitude : null,
      maxAltitude: Number.isFinite(item.maxAltitude) ? item.maxAltitude : null,
      minSpeed: Number.isFinite(item.minSpeed) ? item.minSpeed : null,
      maxSpeed: Number.isFinite(item.maxSpeed) ? item.maxSpeed : null,
    }))
    .sort((left, right) => right.count - left.count)
}

async function main() {
  const options = parseArgs(process.argv)
  const datePath = options.date.replaceAll('-', '/')
  const metadata = new Map()
  const observations = []

  for (let chunk = options.firstChunk; chunk <= options.lastChunk; chunk += 1) {
    const url = `${options.sourceRoot.replace(/\/$/, '')}/${datePath}/heatmap/${String(chunk).padStart(2, '0')}.bin.ttf`
    process.stderr.write(`Fetching ${url}\n`)
    const response = await fetch(url)
    if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`)
    const buffer = await response.arrayBuffer()
    const parsed = parseReplay(buffer, options, metadata)
    observations.push(...parsed)
    process.stderr.write(`Parsed ${parsed.length} in-bounds observations from ${(buffer.byteLength / 1024 / 1024).toFixed(1)} MiB\n`)
  }

  const result = {
    schemaVersion: 1,
    source: options.sourceRoot,
    retrievedAt: new Date().toISOString(),
    date: options.date,
    chunks: [options.firstChunk, options.lastChunk],
    bounds: {
      minLat: options.minLat,
      maxLat: options.maxLat,
      minLon: options.minLon,
      maxLon: options.maxLon,
    },
    aircraft: summarize(observations, metadata),
    observations: observations
      .map((observation) => ({
        ...observation,
        observedAt: new Date(observation.observedAt * 1000).toISOString(),
        ...metadata.get(observation.hex),
      }))
      .sort((left, right) => left.observedAt.localeCompare(right.observedAt)),
    interpretation: [
      'Each timestamp is the replay-slice timestamp; it is not interpolated between source samples.',
      'Presence inside the geographic bounds does not establish a firefighting assignment.',
      'Historical receiver coverage is incomplete, especially for low-level Mode S aircraft.',
    ],
  }

  const outputPath = path.resolve(options.output)
  await mkdir(path.dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify({
    output: outputPath,
    chunks: result.chunks,
    aircraftCount: result.aircraft.length,
    observationCount: result.observations.length,
    aircraft: result.aircraft,
  }, null, 2)}\n`)
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`)
  process.exitCode = 1
})
