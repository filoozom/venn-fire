#!/usr/bin/env node

// Watches the Copernicus Emergency Management Service for a Rapid Mapping
// activation covering this fire.
//
// An EMS activation is the highest-quality burned-area source available for an
// incident like this: authorities task satellites and CEMS publishes a
// delineation perimeter, rather than an algorithmic footprint derived from
// coarse thermal detections. It cannot be predicted, so it is polled.
//
// The neighbouring Huertgenwald fire in Germany is EMSR920. That is a different
// incident and is recorded here as context, never as this fire's perimeter.

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const LISTING_URL = 'https://rapidmapping.emergency.copernicus.eu/backend/dashboard-api/public-activations-info/'
const DETAIL_URL = 'https://rapidmapping.emergency.copernicus.eu/backend/dashboard-api/public-activations/?code='
const PORTAL_URL = 'https://mapping.emergency.copernicus.eu/activations/'

const DROSSART = { latitude: 50.54762, longitude: 6.05757 }
const MATCH_RADIUS_KM = 30
const KNOWN_OTHER_INCIDENTS = { EMSR920: 'Forest fire in Huertgen Forest, Germany (separate incident)' }

const DEFAULTS = { output: '.local-data/ems', country: 'Belgium' }

function parseArgs(argv) {
  const options = { ...DEFAULTS }
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === '--') continue
    const key = argv[index].replace(/^--/, '')
    const value = argv[index + 1]
    if (!(key in options) || value == null) throw new Error(`Unknown or incomplete argument: ${argv[index]}`)
    options[key] = value
    index += 1
  }
  return options
}

function haversineKm(latitude, longitude) {
  const radians = Math.PI / 180
  const deltaLat = (latitude - DROSSART.latitude) * radians
  const deltaLon = (longitude - DROSSART.longitude) * radians
  const value = Math.sin(deltaLat / 2) ** 2
    + Math.cos(DROSSART.latitude * radians) * Math.cos(latitude * radians) * Math.sin(deltaLon / 2) ** 2
  return 6371.0088 * 2 * Math.asin(Math.sqrt(value))
}

// CEMS publishes the centroid as a WKT POINT in longitude-latitude order.
function parseCentroid(wkt) {
  const match = /POINT\s*\(([-\d.]+)\s+([-\d.]+)\)/.exec(String(wkt ?? ''))
  if (!match) return null
  return { longitude: Number(match[1]), latitude: Number(match[2]) }
}

async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`)
  return response.json()
}

async function main() {
  const options = parseArgs(process.argv)
  const outputDir = path.resolve(options.output)
  await mkdir(outputDir, { recursive: true })

  const retrievedAt = new Date().toISOString()
  const listing = await fetchJson(LISTING_URL)
  const activations = Array.isArray(listing) ? listing : (listing.results ?? [])

  const scored = activations.map((activation) => {
    const centroid = parseCentroid(activation.centroid)
    return {
      code: activation.code,
      name: activation.name,
      category: activation.category,
      countries: activation.countries ?? [],
      eventTime: activation.eventTime,
      activationTime: activation.activationTime,
      lastUpdate: activation.lastUpdate,
      closed: activation.closed,
      productCount: activation.n_products,
      centroid,
      distanceKm: centroid ? haversineKm(centroid.latitude, centroid.longitude) : null,
    }
  })

  // A match must be a wildfire near this incident. Country alone is too loose and
  // proximity alone would catch the German fire next door, so both are required
  // and any known other incident is excluded by code.
  const matches = scored.filter((activation) => (
    activation.category === 'Wildfire'
    && !KNOWN_OTHER_INCIDENTS[activation.code]
    && (
      activation.countries.includes(options.country)
      || (activation.distanceKm != null && activation.distanceKm <= MATCH_RADIUS_KM)
    )
  ))

  const nearby = scored
    .filter((activation) => activation.distanceKm != null && activation.distanceKm <= 100)
    .sort((first, second) => first.distanceKm - second.distanceKm)

  const details = []
  for (const match of matches) {
    try {
      const payload = await fetchJson(`${DETAIL_URL}${encodeURIComponent(match.code)}`)
      details.push((payload.results ?? [])[0] ?? payload)
    } catch (error) {
      details.push({ code: match.code, error: String(error.message ?? error) })
    }
  }

  const result = {
    schemaVersion: 1,
    source: { name: 'Copernicus EMS Rapid Mapping', url: PORTAL_URL, listingUrl: LISTING_URL },
    retrievedAt,
    locationReference: { name: 'Drossart locality', ...DROSSART },
    matchRule: `Wildfire activation listing ${options.country} or with a centroid within ${MATCH_RADIUS_KM} km of Drossart`,
    knownOtherIncidents: KNOWN_OTHER_INCIDENTS,
    activationFound: matches.length > 0,
    matches,
    matchDetails: details,
    nearbyActivations: nearby,
    listingCount: scored.length,
    interpretation: [
      'The public listing returns only the most recent activations, so absence here is not proof that no activation exists.',
      'An activation for a different nearby incident is recorded as context and must never be shown as this fire perimeter.',
      'Delineation products are produced from tasked satellite imagery and are the authoritative burned-area source when present.',
    ],
  }

  await writeFile(path.join(outputDir, 'activations.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8')

  if (matches.length) {
    console.log(`EMS ACTIVATION FOUND for this incident: ${matches.map((match) => `${match.code} (${match.name})`).join(', ')}`)
    console.log(`Products: ${matches.map((match) => match.productCount).join(', ')} · ${PORTAL_URL}`)
  } else {
    console.log(`No Copernicus EMS activation for this incident (checked ${scored.length} recent activations).`)
    const context = nearby.filter((activation) => KNOWN_OTHER_INCIDENTS[activation.code])
    for (const activation of context) {
      console.log(`  context: ${activation.code} ${activation.name} · ${activation.distanceKm.toFixed(0)} km away`)
    }
  }
}

main().catch((error) => {
  console.error(error.message ?? error)
  process.exitCode = 1
})
