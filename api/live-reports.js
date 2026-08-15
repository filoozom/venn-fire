import { loadDataset, setNoStoreHeaders } from '../server/database.mjs'

export const LIVE_REPORT_SOURCES = [
  {
    id: 'governor-liege',
    name: 'Governor of Liège',
    url: 'https://gouverneur.provincedeliege.be/fr/node/7923',
    parser: parseGovernorAreaReports,
    eventParser: parseGovernorSituationEvents,
  },
  {
    id: 'brf',
    name: 'BRF',
    url: 'https://brf.be/regional/2100196/',
    parser: parseBrfAreaReport,
  },
]

const BLOCK_TAG_PATTERN = /<\/?(?:article|aside|blockquote|br|div|figcaption|figure|footer|h[1-6]|header|li|main|p|section|table|td|th|tr)[^>]*>/giu

function decodeHtmlEntities(value) {
  const namedEntities = {
    amp: '&',
    apos: "'",
    gt: '>',
    hellip: '…',
    laquo: '«',
    lt: '<',
    nbsp: ' ',
    ndash: '–',
    mdash: '—',
    quot: '"',
    raquo: '»',
  }

  return String(value).replace(/&(#x[\da-f]+|#\d+|[a-z]+);/giu, (entity, key) => {
    if (key[0] === '#') {
      const radix = key[1]?.toLowerCase() === 'x' ? 16 : 10
      const digits = radix === 16 ? key.slice(2) : key.slice(1)
      const codePoint = Number.parseInt(digits, radix)
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : entity
    }
    return namedEntities[key.toLowerCase()] ?? entity
  })
}

export function htmlToSourceText(html) {
  return decodeHtmlEntities(String(html))
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, ' ')
    .replace(BLOCK_TAG_PATTERN, '\n')
    .replace(/<[^>]+>/gu, ' ')
    .split(/\r?\n/gu)
    .map((line) => line.replace(/[\s\u00a0\u202f]+/gu, ' ').trim())
    .filter(Boolean)
    .join('\n')
}

function localizedNumber(value) {
  const normalized = String(value).trim().replace(/[\s\u00a0\u202f]/gu, '')
  if (/^\d{1,3}(?:\.\d{3})+$/u.test(normalized)) return Number(normalized.replaceAll('.', ''))
  const number = Number(normalized.replace(',', '.'))
  return Number.isFinite(number) ? number : null
}

function brusselsTimestamp(day, month, year, hour, minute = '00') {
  const iso = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+02:00`
  const timestampMs = Date.parse(iso)
  return Number.isFinite(timestampMs) ? timestampMs : null
}

function clockLabel(timestampMs) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Brussels',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestampMs))
}

const GOVERNOR_SOURCE_URL = 'https://gouverneur.provincedeliege.be/fr/node/7923'

const PREVENTIVE_EVACUATION_AREAS = [
  {
    municipality: 'Waimes',
    streets: [
      "Rue d'Averscheidt",
      'Rue Haute',
      'Rue du Bouvier',
      'Rue de Bosfagne',
      'Rue coin du bois',
      'Rue Sainte Apolline',
      'Chemin des Champs',
      'Rue de la Roer',
      'Voie des Hôtes',
      'Rue Pré Louis',
      'Rue Clair Chêne',
      'Rue des Tourbières',
      'Rue des Tchenas',
      'Rue de la Station',
      'Am Rurbusch',
      'Rue du camp',
      'À la croix Marquet',
    ],
  },
  {
    municipality: 'Bütgenbach',
    streets: [
      'Rurstraße',
      'Leykaul',
      'Am Breitenbach',
      'Schieferweg',
      'Auf dem Hau',
      'Rickshelderweg',
      'Am Schwarzbach',
    ],
  },
]

function governorSections(html) {
  const text = htmlToSourceText(html)
  const headingPattern = /(?:POINT DE SITUATION|D[ÉE]CLENCHEMENT PHASE PROVINCIALE|INCENDIE DANS LES HAUTES FAGNES[^\n]*?COMMUNIQU[ÉE] DE PRESSE)[^\n]*?(\d{1,2})\/(\d{1,2})\/(\d{4})\s*(?:-\s*)?(\d{1,2})\s*[hH:]\s*(\d{2})?/giu
  const headings = [...text.matchAll(headingPattern)]
  return headings.flatMap((heading, index) => {
    const timestampMs = brusselsTimestamp(heading[1], heading[2], heading[3], heading[4], heading[5])
    if (!Number.isFinite(timestampMs)) return []
    return [{
      timestampMs,
      day: heading[1],
      month: heading[2],
      year: heading[3],
      text: text.slice(heading.index, headings[index + 1]?.index ?? text.length),
    }]
  })
}

function comparableSourceText(value) {
  return String(value)
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/ß/gu, 'ss')
    .replace(/[^a-z0-9]+/giu, ' ')
    .trim()
    .toLocaleLowerCase('fr')
}

function numericAreaFromFrenchSection(section) {
  const hectares = section.match(/(?:(plus de|au moins|pr[eè]s de|environ|approximativement|quelque|estim[ée]e? [àa])\s+)?(\d[\d.\s\u00a0\u202f]*(?:,\d+)?)\s*hectares?\b/iu)
  if (hectares) {
    const reportedHa = localizedNumber(hectares[2])
    if (!Number.isFinite(reportedHa) || reportedHa <= 0) return null
    const qualifier = hectares[1]?.toLocaleLowerCase('fr') || ''
    return {
      reportedHa,
      areaPrefix: /plus de|au moins/iu.test(qualifier) ? '>' : '~',
    }
  }

  if (/une centaine d['’]hectares/iu.test(section)) {
    return { reportedHa: 100, areaPrefix: '~' }
  }

  const squareMetres = section.match(/(?:surface\s+)?(?:estim[ée]e?\s+[àa]\s+)?(\d[\d.\s\u00a0\u202f]*)\s*m(?:[èe]tres?)?\s*carr[ée]s?/iu)
  if (!squareMetres) return null
  const areaSquareMetres = localizedNumber(squareMetres[1])
  if (!Number.isFinite(areaSquareMetres) || areaSquareMetres < 10_000) return null
  return { reportedHa: areaSquareMetres / 10_000, areaPrefix: '~' }
}

function effectiveAreaTimestamp(section, publication) {
  const areaLine = section
    .split('\n')
    .find((line) => numericAreaFromFrenchSection(line))
  const statedTime = areaLine?.match(/^[ÀA]\s+(\d{1,2})\s*[hH:]\s*(\d{2})?\b/iu)
  if (!statedTime) return publication.timestampMs
  const timestampMs = brusselsTimestamp(
    publication.day,
    publication.month,
    publication.year,
    statedTime[1],
    statedTime[2],
  )
  return Number.isFinite(timestampMs) && timestampMs <= publication.timestampMs
    ? timestampMs
    : publication.timestampMs
}

export function parseGovernorAreaReports(html) {
  return governorSections(html).flatMap((publication) => {
    const { timestampMs: publishedAtMs, text } = publication
    const area = numericAreaFromFrenchSection(text)
    if (!area) return []
    const effectiveTimestampMs = effectiveAreaTimestamp(text, publication)
    const effectiveTime = clockLabel(effectiveTimestampMs)
    const publicationTime = clockLabel(publishedAtMs)
    const separatelyTimed = effectiveTimestampMs !== publishedAtMs
    return [{
      timestampMs: effectiveTimestampMs,
      observedAt: new Date(effectiveTimestampMs).toISOString(),
      effectiveTimestampMs,
      effectiveAt: new Date(effectiveTimestampMs).toISOString(),
      publishedAtMs,
      publishedAt: new Date(publishedAtMs).toISOString(),
      ...area,
      areaLabel: separatelyTimed
        ? `official estimate for ${effectiveTime} CEST, published at ${publicationTime} CEST`
        : `official estimate at ${effectiveTime} CEST`,
      source: 'Governor of Liège',
      sourceUrl: GOVERNOR_SOURCE_URL,
      sourceKind: 'official',
      timestampBasis: separatelyTimed
        ? 'effective time stated with the area figure; publication time from dated bulletin heading'
        : 'dated situation-heading on source page',
    }]
  }).sort((left, right) => left.publishedAtMs - right.publishedAtMs)
}

export function parseGovernorSituationEvents(html) {
  const expectedTimestampMs = Date.parse('2026-08-15T16:00:00+02:00')
  return governorSections(html).flatMap(({ timestampMs, text }) => {
    if (timestampMs !== expectedTimestampMs) return []
    const comparable = comparableSourceText(text)
    const requiredPhrases = [
      'ordre d evacuation preventif',
      'vents changeants',
      'importante fumee',
      'centre sportif de malmedy',
      'avenue du pont de la warche 1',
    ]
    const requiredStreets = PREVENTIVE_EVACUATION_AREAS
      .flatMap((area) => area.streets)
      .map(comparableSourceText)
    if (![...requiredPhrases, ...requiredStreets].every((phrase) => comparable.includes(phrase))) return []

    return [{
      id: 'governor-liege-2026-08-15-1600-preventive-evacuation',
      timestampMs,
      observedAt: new Date(timestampMs).toISOString(),
      type: 'evacuation',
      title: 'Preventive evacuation ordered for named streets in Waimes and Bütgenbach',
      detail: 'Changing winds and heavy smoke. Residents of the listed streets are asked to leave their homes as a precaution and to go to the Centre sportif de Malmedy, Avenue du Pont de la Warche 1, 4960 Malmedy. Residents of other streets should stay indoors with doors and windows closed. Tourists staying in the area are asked to go home.',
      affectedAreas: PREVENTIVE_EVACUATION_AREAS,
      scopeKind: 'named-streets',
      receptionCentre: {
        name: 'Centre sportif de Malmedy',
        address: 'Avenue du Pont de la Warche 1, 4960 Malmedy',
      },
      sourceUrl: GOVERNOR_SOURCE_URL,
      sourceName: 'Governor of Liège, situation update 15 Aug 16:00 CEST',
      sourceKind: 'official',
      timestampBasis: 'dated situation-heading on source page',
    }]
  })
}

function attributeValue(tag, attribute) {
  const match = String(tag).match(new RegExp(`\\b${attribute}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'iu'))
  return match ? decodeHtmlEntities(match[2]) : null
}

function brfDescription(html) {
  const descriptionTag = (String(html).match(/<meta\b[^>]*>/giu) || []).find((tag) => (
    attributeValue(tag, 'name')?.toLowerCase() === 'description'
  ))
  return descriptionTag ? attributeValue(descriptionTag, 'content') : null
}

function brfUpdatedTimestamp(html) {
  const timeTags = String(html).match(/<time\b[^>]*>[\s\S]*?<\/time>/giu) || []
  const edited = timeTags.find((tag) => (
    attributeValue(tag, 'class')?.split(/\s+/u).includes('edit')
  ))
  const editedText = edited ? htmlToSourceText(edited) : ''
  const editedMatch = editedText.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})\s*-\s*(\d{1,2}):(\d{2})/u)
  if (editedMatch) return brusselsTimestamp(editedMatch[1], editedMatch[2], editedMatch[3], editedMatch[4], editedMatch[5])

  const published = timeTags.find((tag) => attributeValue(tag, 'datetime'))
  const publishedDatetime = published ? attributeValue(published, 'datetime') : null
  const publishedMatch = publishedDatetime?.match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/u)
  return publishedMatch
    ? brusselsTimestamp(publishedMatch[3], publishedMatch[2], publishedMatch[1], publishedMatch[4], publishedMatch[5])
    : null
}

function numericAreaFromGermanDescription(description) {
  const match = description.match(/\b(mehr als|[üu]ber|rund|etwa|circa|ca\.)\s+(\d[\d.\s\u00a0\u202f]*)\s+Hektar\b/iu)
  if (!match) return null
  const reportedHa = localizedNumber(match[2])
  if (!Number.isFinite(reportedHa) || reportedHa <= 0) return null
  return {
    reportedHa,
    areaPrefix: /mehr als|[üu]ber/iu.test(match[1]) ? '>' : '~',
  }
}

export function parseBrfAreaReport(html) {
  const description = brfDescription(html)
  const timestampMs = brfUpdatedTimestamp(html)
  const article = String(html).match(/<article\b[^>]*>[\s\S]*?<\/article>/iu)?.[0] ?? html
  const articleText = htmlToSourceText(article)
  const incidentText = `${description || ''}\n${articleText}`
  if (!/Hohen Venn|Vennbrand|Gro[ßs]brand/iu.test(incidentText) || !Number.isFinite(timestampMs)) return []
  const area = numericAreaFromGermanDescription(description || '')
    || numericAreaFromGermanDescription(articleText)
  if (!area) return []
  const time = clockLabel(timestampMs)
  return [{
    timestampMs,
    observedAt: new Date(timestampMs).toISOString(),
    ...area,
    areaLabel: `BRF page update at ${time} CEST`,
    source: 'BRF',
    sourceUrl: 'https://brf.be/regional/2100196/',
    sourceKind: 'local-reporting',
    timestampBasis: 'page last-edited time published by BRF',
  }]
}

async function fetchSourceHtml(source) {
  const response = await fetch(source.url, {
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'User-Agent': 'venn-fire-live-monitor/1.0 (+https://venn-fire.vercel.app)',
    },
    signal: AbortSignal.timeout(8_000),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.text()
}

export async function loadAreaReports(
  sources = LIVE_REPORT_SOURCES,
  fetchHtml = fetchSourceHtml,
) {
  const results = await Promise.allSettled(sources.map(async (source) => {
    const html = await fetchHtml(source)
    const areaReports = source.parser(html)
    const events = source.eventParser?.(html) ?? []
    if (!areaReports.length && !events.length) {
      throw new Error('No timestamped report or event matched the strict parser')
    }
    return { source, areaReports, events }
  }))

  const sourceStatus = results.map((result, index) => {
    const source = sources[index]
    return result.status === 'fulfilled'
      ? {
          id: source.id,
          name: source.name,
          url: source.url,
          ok: true,
          reportCount: result.value.areaReports.length,
          eventCount: result.value.events.length,
        }
      : { id: source.id, name: source.name, url: source.url, ok: false, reportCount: 0, eventCount: 0 }
  })
  const areaReports = results.flatMap((result) => (
    result.status === 'fulfilled' ? result.value.areaReports : []
  ))
  const reportsBySourceAndTime = new Map()
  areaReports.forEach((report) => {
    const publishedAtMs = Number.isFinite(report.publishedAtMs) ? report.publishedAtMs : report.timestampMs
    reportsBySourceAndTime.set(`${report.source}|${report.timestampMs}|${publishedAtMs}`, report)
  })
  const eventsById = new Map()
  results.flatMap((result) => (
    result.status === 'fulfilled' ? result.value.events : []
  )).forEach((event) => eventsById.set(event.id, event))

  return {
    ok: sourceStatus.some((source) => source.ok),
    complete: sourceStatus.every((source) => source.ok),
    areaReports: [...reportsBySourceAndTime.values()].sort((left, right) => (
      (left.publishedAtMs ?? left.timestampMs) - (right.publishedAtMs ?? right.timestampMs)
      || left.timestampMs - right.timestampMs
    )),
    events: [...eventsById.values()].sort((left, right) => left.timestampMs - right.timestampMs),
    sources: sourceStatus,
  }
}

const PUBLIC_ALERT_TEXT_FIELDS = [
  'title',
  'description',
  'headline',
  'capDescription',
  'areaDesc',
]

function normalizedSearchText(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase('en')
}

export function filterPublicAlerts(alerts, query) {
  const normalizedQuery = normalizedSearchText(query).trim()
  if (!normalizedQuery) return [...(alerts ?? [])]
  return (alerts ?? []).filter((alert) => normalizedSearchText(
    PUBLIC_ALERT_TEXT_FIELDS.map((field) => alert?.[field]).join(' '),
  ).includes(normalizedQuery))
}

function requestSearchQuery(request) {
  const queryValue = Array.isArray(request?.query?.q) ? request.query.q[0] : request?.query?.q
  if (queryValue != null) return String(queryValue).trim().slice(0, 100)
  try {
    return new URL(request?.url || '/', 'https://venn-fire.vercel.app').searchParams.get('q')?.trim().slice(0, 100) || ''
  } catch {
    return ''
  }
}

export function buildLiveReportsResponse({
  alertsDataset,
  reportsDataset,
  query = '',
  generatedAt = new Date().toISOString(),
}) {
  const publicAlertsPayload = alertsDataset?.payload ?? {
    alerts: [],
    currentlyInForce: [],
    alertCount: 0,
    nearIncidentCount: 0,
  }
  const allAlerts = Array.isArray(publicAlertsPayload.alerts) ? publicAlertsPayload.alerts : []
  const matchedAlerts = filterPublicAlerts(allAlerts, query)

  return {
    schemaVersion: 1,
    ok: true,
    generatedAt,
    query: query || null,
    reports: reportsDataset
      ? {
          ...reportsDataset.payload,
          databaseRefreshedAt: reportsDataset.refreshedAt,
          databaseSourceUpdatedAt: reportsDataset.sourceUpdatedAt,
        }
      : { ok: false, complete: false, areaReports: [], events: [], sources: [] },
    publicAlerts: {
      ...publicAlertsPayload,
      alerts: matchedAlerts,
      totalAlertCount: allAlerts.length,
      matchCount: matchedAlerts.length,
      databaseRefreshedAt: alertsDataset?.refreshedAt ?? null,
      databaseSourceUpdatedAt: alertsDataset?.sourceUpdatedAt ?? null,
    },
    interpretation: [
      'publicAlerts.alerts includes retained expired CAP alerts, not only alerts currently present in the live feed.',
      'publicAlerts.currentlyInForce contains only GUIDs present during the latest successful CAP feed refresh.',
      'An absent text match is not proof that no alert was issued before database accumulation began.',
    ],
  }
}

export default async function handler(request, response) {
  setNoStoreHeaders(response)
  response.setHeader('Access-Control-Allow-Origin', '*')
  response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  if (request.method === 'OPTIONS') return response.status(204).end()
  if (request.method !== 'GET') {
    return response.status(405).json({ ok: false, error: 'Method not allowed' })
  }

  try {
    const [alertsDataset, reportsDataset] = await Promise.all([
      loadDataset('public-alerts'),
      loadDataset('reports'),
    ])
    if (!alertsDataset && !reportsDataset) throw new Error('Report datasets have not been seeded')
    return response.status(200).json(buildLiveReportsResponse({
      alertsDataset,
      reportsDataset,
      query: requestSearchQuery(request),
    }))
  } catch (error) {
    console.error('Live reports database read failed:', error?.message || error)
    return response.status(503).json({
      schemaVersion: 1,
      ok: false,
      generatedAt: new Date().toISOString(),
      reports: { ok: false, complete: false, areaReports: [], events: [], sources: [] },
      publicAlerts: { alerts: [], currentlyInForce: [], alertCount: 0, matchCount: 0 },
      error: 'Live reports database read failed',
    })
  }
}
