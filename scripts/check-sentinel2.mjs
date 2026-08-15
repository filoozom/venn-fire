#!/usr/bin/env node

// Watches the Copernicus Data Space catalogue for a post-fire Sentinel-2 scene
// over the incident.
//
// Sentinel-2 is the only free source that can produce a real 10-20 m burned-area
// perimeter for this fire. It cannot be tasked, so the useful action is to know
// the moment a usable scene exists. The catalogue search needs no credentials;
// downloading the scene does.
//
// The last pre-fire scene was S2C on 14 Aug at 10:40 UTC, 26 minutes before the
// reported ignition, which makes it the natural pre-fire reference for a dNBR.

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const CATALOGUE_URL = 'https://catalogue.dataspace.copernicus.eu/odata/v1/Products'
const DROSSART = { latitude: 50.54762, longitude: 6.05757 }
const IGNITION_ISO = '2026-08-14T11:06:00.000Z'

const DEFAULTS = {
  output: '.local-data/sentinel2',
  collection: 'SENTINEL-2',
  productType: 'MSIL2A',
  since: '2026-07-25T00:00:00.000Z',
}

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

async function main() {
  const options = parseArgs(process.argv)
  const outputDir = path.resolve(options.output)
  await mkdir(outputDir, { recursive: true })

  const retrievedAt = new Date().toISOString()
  const filter = [
    `Collection/Name eq '${options.collection}'`,
    `OData.CSC.Intersects(area=geography'SRID=4326;POINT(${DROSSART.longitude} ${DROSSART.latitude})')`,
    `ContentDate/Start gt ${options.since}`,
    `contains(Name,'${options.productType}')`,
  ].join(' and ')

  const url = `${CATALOGUE_URL}?${new URLSearchParams({
    $filter: filter,
    $orderby: 'ContentDate/Start asc',
    $top: '50',
  })}`

  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) })
  if (!response.ok) throw new Error(`Copernicus catalogue returned HTTP ${response.status}`)
  const payload = await response.json()

  const scenes = (payload.value ?? []).map((product) => ({
    name: product.Name,
    acquiredAt: product.ContentDate.Start,
    // The relative orbit determines which passes cover this point at all.
    relativeOrbit: /_R(\d+)_/.exec(product.Name)?.[1] ?? null,
    platform: product.Name.slice(0, 3),
    isPostFire: Date.parse(product.ContentDate.Start) > Date.parse(IGNITION_ISO),
  }))

  const preFire = scenes.filter((scene) => !scene.isPostFire)
  const postFire = scenes.filter((scene) => scene.isPostFire)

  // Observed revisit, measured rather than assumed: only certain orbits cover
  // this point, so the real gap pattern is what the catalogue actually shows.
  const gapsDays = []
  for (let index = 1; index < scenes.length; index += 1) {
    const gap = (Date.parse(scenes[index].acquiredAt) - Date.parse(scenes[index - 1].acquiredAt)) / 86_400_000
    gapsDays.push(Number(gap.toFixed(2)))
  }

  const result = {
    schemaVersion: 1,
    source: { name: 'Copernicus Data Space Ecosystem catalogue', url: CATALOGUE_URL, requestUrl: url },
    retrievedAt,
    locationReference: { name: 'Drossart locality', ...DROSSART },
    ignitionReportedAt: IGNITION_ISO,
    sceneCount: scenes.length,
    postFireSceneCount: postFire.length,
    lastPreFireScene: preFire[preFire.length - 1] ?? null,
    firstPostFireScene: postFire[0] ?? null,
    scenes,
    observedGapsDays: gapsDays,
    interpretation: [
      'Catalogue presence means the scene exists, not that it is cloud-free or usable for a burned-area perimeter.',
      'A dNBR perimeter needs both a pre-fire and a post-fire scene; the last pre-fire scene is recorded here as the reference.',
      'Catalogue search is unauthenticated; downloading a scene requires a free Copernicus Data Space account.',
    ],
  }

  await writeFile(path.join(outputDir, 'scenes.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8')

  console.log(`Sentinel-2 ${options.productType} over Drossart: ${scenes.length} scene(s) since ${options.since.slice(0, 10)}`)
  if (result.lastPreFireScene) {
    console.log(`  last pre-fire  ${result.lastPreFireScene.acquiredAt.slice(0, 16)} ${result.lastPreFireScene.platform} (dNBR reference)`)
  }
  if (result.firstPostFireScene) {
    console.log(`  POST-FIRE SCENE AVAILABLE: ${result.firstPostFireScene.acquiredAt.slice(0, 16)} ${result.firstPostFireScene.platform}`)
    console.log('  A real 20 m burned-area perimeter can now be produced.')
  } else {
    console.log('  no post-fire scene yet')
    if (gapsDays.length) {
      console.log(`  observed revisit gaps (days): ${gapsDays.join(', ')}`)
    }
  }
}

main().catch((error) => {
  console.error(error.message ?? error)
  process.exitCode = 1
})
