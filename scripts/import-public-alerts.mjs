#!/usr/bin/env node

// Official Belgian public alerts (BE-Alert) from the national CAP gateway.
//
// This is the most authoritative source in the project: alerts are issued by the
// crisis centre and provincial authorities themselves, carry OASIS CAP 1.2
// severity and certainty fields, and include the official area geometry.
//
// Alerts EXPIRE, usually within one or two hours, and the feed lists only those
// currently in force. An alert not captured before it expires is gone. This
// importer therefore accumulates: every alert it has ever seen is retained and
// merged, so the incident record keeps them after they lapse.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const FEED_URL = 'https://publicalerts.be/CapGateway/feed'
const ALERT_URL = 'https://publicalerts.be/CapGateway/alert/'
const PORTAL_URL = 'https://publicalerts.be/CapGateway/#!/?lang=en'
const DROSSART = { latitude: 50.54762, longitude: 6.05757 }
const CONTEXT_RADIUS_KM = 40

const DEFAULTS = {
  output: '.local-data/public-alerts',
  snapshot: 'src/publicAlerts.json',
  // Normalize a retained feed document instead of fetching. Alerts expire out of
  // the live feed within the hour, so a capture taken before this importer
  // existed can still be folded in through exactly the same code path.
  feedFile: '',
}

function parseArgs(argv) {
  const options = { ...DEFAULTS, dryRun: false, writeSnapshot: false }
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--') continue
    if (token === '--dry-run') { options.dryRun = true; continue }
    if (token === '--write-snapshot') { options.writeSnapshot = true; continue }
    const key = token.replace(/^--/, '')
    const value = argv[index + 1]
    if (!(key in options) || value == null) throw new Error(`Unknown or incomplete argument: ${token}`)
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

// The feed nests each geometry's points as {x, y} objects rather than pairs.
function normalizeGeometries(areas) {
  return (areas ?? []).flatMap((area) => (area.coordinates ?? []).flatMap((geometry) => {
    const points = (geometry.coordinates ?? [])
      .map((point) => (Array.isArray(point) ? point : [point.x, point.y]))
      .filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat))
    if (points.length < 2) return []
    // Leaflet latitude/longitude order, matching the rest of the project.
    return [{ type: geometry.type, ring: points.map(([lon, lat]) => [lat, lon]) }]
  }))
}

// CAP 1.2 fields the JSON feed does not carry. The documents are small, flat and
// machine-generated, so a targeted read of single elements is adequate; anything
// missing is reported as null rather than guessed.
function readCapField(xml, name) {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml)
  if (!match) return null
  return match[1].trim().replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>') || null
}

async function main() {
  const options = parseArgs(process.argv)

  if (options.dryRun) {
    console.log('Planned request, no network access:')
    console.log(`  ${FEED_URL}`)
    console.log(`\nOutput would be written to ${options.output}/`)
    console.log(`Bundled snapshot ${options.writeSnapshot ? 'WOULD' : 'would NOT'} be replaced (${options.snapshot}).`)
    return
  }

  const outputDir = path.resolve(options.output)
  await mkdir(path.join(outputDir, 'raw'), { recursive: true })

  const retrievedAt = new Date().toISOString()
  let body
  if (options.feedFile) {
    body = await readFile(path.resolve(options.feedFile), 'utf8')
    console.log(`Normalizing retained feed ${options.feedFile} (no network)`)
  } else {
    const response = await fetch(FEED_URL, { signal: AbortSignal.timeout(30_000) })
    if (!response.ok) throw new Error(`CAP gateway returned HTTP ${response.status}`)
    body = await response.text()
    await writeFile(path.join(outputDir, 'raw', 'feed.json'), body, 'utf8')
  }

  const feed = JSON.parse(body)
  const items = feed.items ?? []

  const seen = []
  for (const item of items) {
    const geometries = normalizeGeometries(item.area)
    const distancesKm = geometries.flatMap((geometry) => geometry.ring.map(([lat, lon]) => haversineKm(lat, lon)))
    const nearestKm = distancesKm.length ? Math.min(...distancesKm) : null

    // The CAP document carries the fields that make an alert actionable.
    let cap = {}
    try {
      const capResponse = await fetch(`${ALERT_URL}${item.guid}`, { signal: AbortSignal.timeout(20_000) })
      if (capResponse.ok) {
        const capXml = await capResponse.text()
        await writeFile(path.join(outputDir, 'raw', `${item.guid}.xml`), capXml, 'utf8')
        cap = {
          identifier: readCapField(capXml, 'identifier'),
          sender: readCapField(capXml, 'sender'),
          sentAt: readCapField(capXml, 'sent'),
          status: readCapField(capXml, 'status'),
          msgType: readCapField(capXml, 'msgType'),
          urgency: readCapField(capXml, 'urgency'),
          severity: readCapField(capXml, 'severity'),
          certainty: readCapField(capXml, 'certainty'),
          headline: readCapField(capXml, 'headline'),
          capDescription: readCapField(capXml, 'description'),
          areaDesc: readCapField(capXml, 'areaDesc'),
        }
      }
    } catch (error) {
      cap = { capError: String(error.message ?? error) }
    }

    seen.push({
      guid: item.guid,
      title: (item.title ?? '').replace(/\s+/g, ' ').trim(),
      description: (item.description ?? '').replace(/\s+/g, ' ').trim(),
      categories: item.category ?? [],
      language: item.lang ?? null,
      publishedAt: item.pubDate ?? null,
      startsAt: item.startDate ?? null,
      expiresAt: item.expirationDate ?? null,
      link: item.link ?? `${ALERT_URL}${item.guid}`,
      nearestKmFromDrossart: nearestKm,
      isNearIncident: nearestKm != null && nearestKm <= CONTEXT_RADIUS_KM,
      geometries,
      firstRetrievedAt: retrievedAt,
      lastRetrievedAt: retrievedAt,
      ...cap,
    })
  }

  // Merge with anything captured before, because expired alerts leave the feed.
  const snapshotPath = path.resolve(options.snapshot)
  let previous = { alerts: [] }
  try {
    previous = JSON.parse(await readFile(snapshotPath, 'utf8'))
  } catch {
    // No snapshot yet.
  }
  const byGuid = new Map((previous.alerts ?? []).map((alert) => [alert.guid, alert]))
  let added = 0
  for (const alert of seen) {
    const existing = byGuid.get(alert.guid)
    if (existing) {
      byGuid.set(alert.guid, { ...existing, ...alert, firstRetrievedAt: existing.firstRetrievedAt })
    } else {
      byGuid.set(alert.guid, alert)
      added += 1
    }
  }
  const alerts = [...byGuid.values()].sort((left, right) => String(right.publishedAt).localeCompare(String(left.publishedAt)))

  const result = {
    schemaVersion: 1,
    generatedAt: retrievedAt,
    source: {
      name: 'BE-Alert public alerts (Belgian CAP gateway)',
      url: PORTAL_URL,
      feedUrl: FEED_URL,
      standard: 'OASIS CAP 1.2',
    },
    locationReference: { name: 'Drossart locality', ...DROSSART },
    contextRadiusKm: CONTEXT_RADIUS_KM,
    currentlyInForce: seen.map((alert) => alert.guid),
    alertCount: alerts.length,
    nearIncidentCount: alerts.filter((alert) => alert.isNearIncident).length,
    alerts,
    interpretation: [
      'Alerts are issued by Belgian authorities and are the authoritative record of what the public was told.',
      'The feed lists only alerts currently in force; expired alerts are retained here from earlier retrievals and must be read with their expiry time.',
      'An alert area is the zone the message was addressed to. It is not a fire perimeter and must never be drawn as one.',
      'Absence of an alert is not evidence that nothing happened: an alert may have expired before this importer first ran.',
    ],
  }

  await writeFile(path.join(outputDir, 'manifest.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8')

  console.log(`${items.length} alert(s) in force, ${added} new, ${alerts.length} retained in total`)
  for (const alert of seen) {
    const near = alert.nearestKmFromDrossart == null ? '—' : `${alert.nearestKmFromDrossart.toFixed(1)} km`
    console.log(`  ${alert.publishedAt?.slice(0, 16)}  ${near.padStart(8)}  ${alert.severity ?? '?'}  ${alert.title.slice(0, 70)}`)
  }

  if (!options.writeSnapshot) {
    console.log('\nBundled snapshot left untouched. Re-run with --write-snapshot to replace it.')
    return
  }
  await writeFile(snapshotPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  console.log(`\nWrote bundled snapshot ${options.snapshot}`)
}

main().catch((error) => {
  console.error(error.message ?? error)
  process.exitCode = 1
})
