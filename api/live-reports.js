export const LIVE_REPORT_SOURCES = [
  {
    id: 'governor-liege',
    name: 'Governor of Liège',
    url: 'https://gouverneur.provincedeliege.be/fr/node/7923',
    parser: parseGovernorAreaReports,
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

export function parseGovernorAreaReports(html) {
  const text = htmlToSourceText(html)
  const headingPattern = /(?:POINT DE SITUATION|D[ÉE]CLENCHEMENT PHASE PROVINCIALE)\s+(\d{1,2})\/(\d{1,2})\/(\d{4})\s*-\s*(\d{1,2})\s*[hH:]\s*(\d{2})?/gu
  const headings = [...text.matchAll(headingPattern)]

  return headings.flatMap((heading, index) => {
    const timestampMs = brusselsTimestamp(heading[1], heading[2], heading[3], heading[4], heading[5])
    if (!Number.isFinite(timestampMs)) return []
    const sectionEnd = headings[index + 1]?.index ?? text.length
    const area = numericAreaFromFrenchSection(text.slice(heading.index, sectionEnd))
    if (!area) return []
    const time = clockLabel(timestampMs)
    return [{
      timestampMs,
      observedAt: new Date(timestampMs).toISOString(),
      ...area,
      areaLabel: `official estimate at ${time} CEST`,
      source: 'Governor of Liège',
      sourceUrl: 'https://gouverneur.provincedeliege.be/fr/node/7923',
      sourceKind: 'official',
      timestampBasis: 'dated situation-heading on source page',
    }]
  }).sort((left, right) => left.timestampMs - right.timestampMs)
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
    if (!areaReports.length) throw new Error('No timestamped area report matched the strict parser')
    return { source, areaReports }
  }))

  const sourceStatus = results.map((result, index) => {
    const source = sources[index]
    return result.status === 'fulfilled'
      ? { id: source.id, name: source.name, url: source.url, ok: true, reportCount: result.value.areaReports.length }
      : { id: source.id, name: source.name, url: source.url, ok: false, reportCount: 0 }
  })
  const areaReports = results.flatMap((result) => (
    result.status === 'fulfilled' ? result.value.areaReports : []
  ))
  const reportsBySourceAndTime = new Map()
  areaReports.forEach((report) => reportsBySourceAndTime.set(`${report.source}|${report.timestampMs}`, report))

  return {
    ok: sourceStatus.some((source) => source.ok),
    complete: sourceStatus.every((source) => source.ok),
    areaReports: [...reportsBySourceAndTime.values()].sort((left, right) => left.timestampMs - right.timestampMs),
    sources: sourceStatus,
  }
}
