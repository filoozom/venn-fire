import { createHash } from 'node:crypto'

import { loadDataset, saveArtifact, saveDataset } from './database.mjs'

const INCIDENT_START_MS = Date.parse('2026-08-14T11:00:00.000Z')
const REQUEST_HEADERS = {
  Accept: 'application/json, application/atom+xml, application/rss+xml, application/xml, text/html;q=0.9, */*;q=0.5',
  'User-Agent': 'VennFireWatch/1.0 (+https://venn-fire.vercel.app)',
}

export const MUNICIPAL_PROVIDERS = [
  {
    id: 'stavelot',
    municipality: 'Stavelot',
    name: 'City of Stavelot',
    format: 'rdf-rss',
    endpoint: 'https://www.stavelot.be/actualites/RSS',
    publicUrl: 'https://www.stavelot.be/actualites',
    trustedHost: 'www.stavelot.be',
  },
  {
    id: 'malmedy',
    municipality: 'Malmedy',
    name: 'City of Malmedy',
    format: 'rdf-rss',
    endpoint: 'https://www.malmedy.be/actualites/RSS',
    publicUrl: 'https://www.malmedy.be/actualites',
    trustedHost: 'www.malmedy.be',
  },
  {
    id: 'jalhay',
    municipality: 'Jalhay',
    name: 'Municipality of Jalhay',
    format: 'wordpress-api',
    endpoint: 'https://www.jalhay.be/wp-json/wp/v2/posts?per_page=20&orderby=date&order=desc&_fields=id,date_gmt,modified_gmt,link,title,excerpt,content',
    publicUrl: 'https://www.jalhay.be/news/',
    trustedHost: 'www.jalhay.be',
  },
  {
    id: 'baelen',
    municipality: 'Baelen',
    name: 'Municipality of Baelen',
    format: 'rdf-rss',
    endpoint: 'https://www.baelen.be/actualites/RSS',
    publicUrl: 'https://www.baelen.be/actualites',
    trustedHost: 'www.baelen.be',
  },
  {
    id: 'eupen',
    municipality: 'Eupen',
    name: 'City of Eupen',
    format: 'rdf-rss',
    endpoint: 'https://www.eupen.be/feed/',
    publicUrl: 'https://www.eupen.be/newsarchiv/',
    trustedHost: 'www.eupen.be',
  },
  {
    id: 'waimes',
    municipality: 'Waimes',
    name: 'Municipality of Waimes',
    format: 'imio-json',
    endpoint: 'https://www.waimes.be/actualites/@results/?batch_size=50&b_start=0',
    publicUrl: 'https://www.waimes.be/actualites',
    trustedHost: 'www.waimes.be',
  },
  {
    id: 'butgenbach',
    municipality: 'Bütgenbach',
    name: 'Municipality of Bütgenbach',
    format: 'wordpress',
    endpoint: 'https://butgenbach.be/wp-json/wp/v2/search?per_page=100&subtype=post',
    publicUrl: 'https://butgenbach.be/blog/',
    trustedHost: 'butgenbach.be',
  },
  {
    id: 'zone-vhp',
    municipality: 'Vesdre–Hoëgne & Plateau',
    name: 'Vesdre–Hoëgne & Plateau emergency zone',
    publisherKind: 'official-emergency-service',
    format: 'wordpress-api',
    endpoint: 'https://www.zone-vhp.be/wp-json/wp/v2/posts?per_page=20&orderby=date&order=desc&_fields=id,date_gmt,modified_gmt,link,title,excerpt,content',
    publicUrl: 'https://www.zone-vhp.be/actualites-et-evenements/',
    trustedHost: 'www.zone-vhp.be',
  },
  {
    id: 'hlz-dg',
    municipality: 'German-speaking Community',
    name: 'Hilfeleistungszone DG',
    publisherKind: 'official-emergency-service',
    format: 'html-news-list',
    endpoint: 'https://www.hlzdg.be/news/',
    publicUrl: 'https://www.hlzdg.be/news/',
    trustedHost: 'www.hlzdg.be',
  },
  {
    id: 'eifel-police',
    municipality: 'Eifel police zone',
    name: 'Eifel Police Zone',
    publisherKind: 'official-police',
    format: 'wordpress-api',
    endpoint: 'https://eifelpolizei.be/wp-json/wp/v2/posts?per_page=20&orderby=date&order=desc&_fields=id,date_gmt,modified_gmt,link,title,excerpt,content',
    publicUrl: 'https://eifelpolizei.be/aktuelles/',
    trustedHost: 'eifelpolizei.be',
  },
]

function normalizeSearchText(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase('fr')
}

function decodeEntities(value) {
  return String(value ?? '')
    .replace(/^\s*<!\[CDATA\[([\s\S]*)\]\]>\s*$/u, '$1')
    .replace(/&#x([\da-f]+);/giu, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&nbsp;|&#160;/giu, ' ')
    .replace(/&amp;/giu, '&')
    .replace(/&quot;|&#34;/giu, '"')
    .replace(/&apos;|&#39;/giu, "'")
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
}

function htmlToText(value) {
  return decodeEntities(String(value ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gu, '$1')
    .replace(/<script\b[\s\S]*?<\/script>/giu, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/giu, ' ')
    .replace(/<br\s*\/?\s*>/giu, '\n')
    .replace(/<\/(?:p|div|li|h[1-6])>/giu, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[\t\r ]+/g, ' ')
    .replace(/ *\n+ */g, '\n')
    .trim()
}

function xmlTag(block, tag) {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`<${escaped}\\b[^>]*>([\\s\\S]*?)<\\/${escaped}>`, 'iu').exec(block)
  return match ? htmlToText(match[1]) : null
}

export function parseMunicipalRdfFeed(xml) {
  return [...String(xml ?? '').matchAll(/<item\b([^>]*)>([\s\S]*?)<\/item>/giu)].map((match) => {
    const about = /\brdf:about=["']([^"']+)["']/iu.exec(match[1])?.[1] ?? null
    const block = match[2]
    return {
      id: about || xmlTag(block, 'link'),
      title: xmlTag(block, 'title'),
      url: xmlTag(block, 'link') || about,
      description: xmlTag(block, 'description') || '',
      content: xmlTag(block, 'content:encoded') || '',
      publishedAt: xmlTag(block, 'dc:date') || xmlTag(block, 'pubDate'),
      sourceType: xmlTag(block, 'dc:type') || 'News Item',
    }
  }).filter((item) => item.id && item.title && item.url)
}

function validTimestamp(value) {
  const timestampMs = Date.parse(value)
  return Number.isFinite(timestampMs) ? new Date(timestampMs).toISOString() : null
}

export function isIncidentMunicipalNotice(notice) {
  const publishedAtMs = Date.parse(notice?.publishedAt)
  if (!Number.isFinite(publishedAtMs) || publishedAtMs < INCIDENT_START_MS) return false
  const text = normalizeSearchText([
    notice.title,
    notice.summary,
    notice.bodyText,
    (() => {
      try { return new URL(notice.url).pathname }
      catch { return notice.url }
    })(),
  ].join(' '))
  const incident = /incend|feu|brasier|fumee|evacu|confin|interdiction|annul|fermeture|flamme|brand|feuer|rauch|evaku|sperr|rettungsdienst|aktuelle lage/iu.test(text)
  const location = /fagnes|hautes fagnes|hohen venn|drossart|stavelot|malmedy|waimes|sourbrodt|butgenbach|buetgenbach|kuechelscheid|kuchelscheid|leykaul|mont rigi|baelen|jalhay|eupen|eifel|vesdre|hoegne/iu.test(text)
  return incident && location
}

function noticeType(notice) {
  const text = normalizeSearchText(`${notice.title} ${notice.summary} ${notice.bodyText}`)
  const preparationOnly = /(?:prepare|preparer|vor(?:zu)?bereit)[^.!?\n]{0,45}evaku|evaku[^.!?\n]{0,45}(?:prepare|preparer|vor(?:zu)?bereit)/iu.test(text)
  const explicitlyNoEvacuation = /aucune evacuation|pas d[’']evacuation|keine evakuierung|no evacuation/iu.test(text)
  if (/evaku|evacua/iu.test(text) && !preparationOnly && !explicitlyNoEvacuation) return 'evacuation'
  if (/interdi|annul|ferm|interromp|gesperrt|sperr|quittez la zone/iu.test(text)) return 'closure'
  return 'alert'
}

function summarize(text, fallback) {
  const normalized = String(text || fallback || '').replace(/\s+/g, ' ').trim()
  return normalized.length > 600 ? `${normalized.slice(0, 597)}…` : normalized
}

function extractStavelotBody(html) {
  return htmlToText(/<div\s+id=["']parent-fieldname-text["'][^>]*>([\s\S]*?)<\/div>/iu.exec(html)?.[1] ?? '')
}

function extractOfficialArticleBody(html) {
  return extractStavelotBody(html)
    || htmlToText(/<div\s+class=["'][^"']*entry-content-inner[^"']*["'][^>]*>([\s\S]*?)<\/article>/iu.exec(html)?.[1] ?? '')
}

function extractButgenbachBody(html) {
  const block = /<div\s+class=["'][^"']*wordpress-content card[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*<a\b[^>]*>\s*(?:<[^>]+>)*Alle Neuigkeiten/iu.exec(html)?.[1]
  return htmlToText(block ?? '')
}

function extractHlzBody(html) {
  return htmlToText(/<section\s+class=["'][^"']*newsdetail[^"']*["'][^>]*>([\s\S]*?)<\/section>/iu.exec(html)?.[1] ?? '')
}

export function parseHlzNewsList(html, baseUrl = 'https://www.hlzdg.be/news/') {
  return [...String(html ?? '').matchAll(/<div\s+class=["']newslist-item["'][^>]*>([\s\S]*?)<\/a>\s*<\/div>/giu)]
    .map((match) => {
      const block = match[1]
      const href = /<a\s+[^>]*href=["']([^"']+)["']/iu.exec(block)?.[1]
      const title = htmlToText(/<span\s+class=["']newslist-title["'][^>]*>([\s\S]*?)<\/span>/iu.exec(block)?.[1] ?? '')
      const summary = htmlToText(/<p\s+class=["']newslist-rawtext["'][^>]*>([\s\S]*?)<\/p>/iu.exec(block)?.[1] ?? '')
      if (!href || !title) return null
      try {
        const url = new URL(href, baseUrl).href
        return { id: url, title, summary, url }
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

function jsonLdDate(html, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return validTimestamp(new RegExp(`"${escaped}"\\s*:\\s*"([^"]+)"`, 'iu').exec(html)?.[1])
}

function belgianLocalTimestamp(value) {
  if (!value) return null
  const timestamp = String(value).trim()
  if (/[zZ]|[+-]\d\d:\d\d$/u.test(timestamp)) return validTimestamp(timestamp)
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.(\d+))?$/u.exec(timestamp)
  if (!match) return validTimestamp(timestamp)
  const milliseconds = (match[3] || '').slice(0, 3).padEnd(3, '0')
  return validTimestamp(`${match[1]}T${match[2]}.${milliseconds}+02:00`)
}

function htmlMetaContent(html, property) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return decodeEntities(new RegExp(`<meta\\s+[^>]*(?:property|name)=["']${escaped}["'][^>]*content=["']([^"']+)["']`, 'iu').exec(html)?.[1] ?? '') || null
}

function germanNoticeDate(bodyText) {
  const dates = [...String(bodyText ?? '').matchAll(/\b(\d{1,2})\.(\d{1,2})\.(\d{2,4})(?:\s*,|\s+um)\s*(\d{1,2})(?::(\d{2}))?\s*Uhr\b/giu)]
    .map((match) => {
      const year = match[3].length === 2 ? `20${match[3]}` : match[3]
      return validTimestamp(`${year}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}T${match[4].padStart(2, '0')}:${match[5] || '00'}:00+02:00`)
    })
    .filter(Boolean)
    .sort((left, right) => Date.parse(left) - Date.parse(right))
  return dates.at(-1) ?? null
}

export function normalizeRdfNotice(item, provider, retrievedAt, articleHtml = '') {
  const bodyText = extractOfficialArticleBody(articleHtml) || item.content || item.description || ''
  const notice = {
    id: `${provider.id}:${item.id}`,
    municipality: provider.municipality,
    title: item.title,
    summary: summarize(item.description || bodyText, item.title),
    bodyText,
    url: item.url,
    publishedAt: validTimestamp(item.publishedAt),
    effectiveAt: germanNoticeDate(bodyText),
    updatedAt: jsonLdDate(articleHtml, 'dateModified') || validTimestamp(item.publishedAt),
    firstRetrievedAt: retrievedAt,
    lastRetrievedAt: retrievedAt,
    publisher: provider.name,
    publisherKind: provider.publisherKind || 'official-municipal',
    sourceFormat: provider.format,
  }
  return isIncidentMunicipalNotice(notice) ? notice : null
}

function wordpressUtcTimestamp(value) {
  if (!value) return null
  return validTimestamp(/[zZ]|[+-]\d\d:\d\d$/u.test(value) ? value : `${value}Z`)
}

function frenchNoticeDate(text, referenceDate) {
  const match = /\b(\d{1,2})\/(\d{1,2})\s*(?:[-–—]\s*)?(\d{1,2})h(\d{2})\b/iu.exec(text)
  if (!match) return null
  const referenceYear = new Date(Date.parse(referenceDate)).getUTCFullYear()
  if (!Number.isFinite(referenceYear)) return null
  return validTimestamp(
    `${referenceYear}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}T${match[3].padStart(2, '0')}:${match[4]}:00+02:00`,
  )
}

export function normalizeWordpressApiNotice(item, provider, retrievedAt) {
  const title = htmlToText(item?.title?.rendered || item?.title || '')
  const bodyText = htmlToText(item?.content?.rendered || '')
  const summaryText = htmlToText(item?.excerpt?.rendered || '')
  const publishedAt = wordpressUtcTimestamp(item?.date_gmt || item?.date)
  const notice = {
    id: `${provider.id}:${item?.id}`,
    municipality: provider.municipality,
    title,
    summary: summarize(summaryText || bodyText, title),
    bodyText,
    url: item?.link,
    publishedAt,
    effectiveAt: frenchNoticeDate(`${title} ${bodyText}`, publishedAt),
    updatedAt: wordpressUtcTimestamp(item?.modified_gmt || item?.modified || item?.date_gmt || item?.date),
    firstRetrievedAt: retrievedAt,
    lastRetrievedAt: retrievedAt,
    publisher: provider.name,
    publisherKind: provider.publisherKind || 'official-municipal',
    sourceFormat: provider.format,
  }
  return notice.id && notice.title && notice.url && isIncidentMunicipalNotice(notice) ? notice : null
}

export function normalizeWaimesNotice(item, provider, retrievedAt) {
  const bodyText = htmlToText(
    item?.text?.data
      || item?.text_fr?.data
      || item?.text_de?.data
      || '',
  )
  const notice = {
    id: `${provider.id}:${item?.UID || item?.id || item?.['@id']}`,
    municipality: provider.municipality,
    title: htmlToText(item?.title_fr || item?.title || ''),
    summary: summarize(item?.description_fr || item?.description || bodyText, item?.title),
    bodyText,
    url: provider.publicUrl,
    apiUrl: item?.['@id'] || null,
    publishedAt: validTimestamp(item?.effective || item?.created),
    updatedAt: validTimestamp(item?.modified || item?.effective || item?.created),
    firstRetrievedAt: retrievedAt,
    lastRetrievedAt: retrievedAt,
    publisher: provider.name,
    publisherKind: provider.publisherKind || 'official-municipal',
    sourceFormat: provider.format,
  }
  return notice.id && notice.title && isIncidentMunicipalNotice(notice) ? notice : null
}

export function normalizeButgenbachNotice(searchItem, html, provider, retrievedAt) {
  const bodyText = extractButgenbachBody(html)
  const notice = {
    id: `${provider.id}:${searchItem?.id}`,
    municipality: provider.municipality,
    title: htmlToText(searchItem?.title || ''),
    summary: summarize(bodyText, searchItem?.title),
    bodyText,
    url: searchItem?.url,
    publishedAt: jsonLdDate(html, 'datePublished'),
    effectiveAt: germanNoticeDate(bodyText),
    updatedAt: jsonLdDate(html, 'dateModified') || jsonLdDate(html, 'datePublished'),
    firstRetrievedAt: retrievedAt,
    lastRetrievedAt: retrievedAt,
    publisher: provider.name,
    publisherKind: provider.publisherKind || 'official-municipal',
    sourceFormat: provider.format,
  }
  return notice.id && notice.title && notice.url && isIncidentMunicipalNotice(notice) ? notice : null
}

export function normalizeHlzNotice(item, html, provider, retrievedAt) {
  const bodyText = extractHlzBody(html)
  const publishedAt = belgianLocalTimestamp(htmlMetaContent(html, 'og:publish_date'))
  const notice = {
    id: `${provider.id}:${item?.id}`,
    municipality: provider.municipality,
    title: item?.title,
    summary: summarize(item?.summary || bodyText, item?.title),
    bodyText,
    url: item?.url,
    publishedAt,
    effectiveAt: germanNoticeDate(bodyText),
    updatedAt: publishedAt,
    firstRetrievedAt: retrievedAt,
    lastRetrievedAt: retrievedAt,
    publisher: provider.name,
    publisherKind: provider.publisherKind,
    sourceFormat: provider.format,
  }
  return notice.id && notice.title && notice.url && isIncidentMunicipalNotice(notice) ? notice : null
}

async function fetchBody(url, { accept = REQUEST_HEADERS.Accept } = {}) {
  const response = await fetch(url, {
    headers: { ...REQUEST_HEADERS, Accept: accept },
    signal: AbortSignal.timeout(25_000),
  })
  const body = await response.text()
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`)
  return {
    body,
    contentType: response.headers.get('content-type')?.split(';')[0] || 'application/octet-stream',
  }
}

async function archiveBody({ providerId, url, body, contentType, retrievedAt }, query) {
  const bytes = Buffer.from(body)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const pathHash = createHash('sha256').update(url).digest('hex').slice(0, 16)
  await saveArtifact({
    artifactKey: `official-local-${providerId}-${pathHash}-${sha256}`,
    sourceKey: 'local-authority-updates',
    originalPath: url,
    contentType,
    contentEncoding: 'identity',
    originalSize: bytes.byteLength,
    sha256,
    capturedAt: retrievedAt,
    contentBase64: bytes.toString('base64'),
  }, query)
}

function trustedArticleUrl(value, provider) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === provider.trustedHost ? url.href : null
  } catch {
    return null
  }
}

async function refreshRdfProvider(provider, retrievedAt, query) {
  const response = await fetchBody(provider.endpoint, { accept: 'application/rss+xml, application/xml, text/xml' })
  await archiveBody({ providerId: provider.id, url: provider.endpoint, ...response, retrievedAt }, query)
  const items = parseMunicipalRdfFeed(response.body)
  const candidates = items.filter((item) => (
    item.sourceType !== 'File'
      && Number.isFinite(Date.parse(item.publishedAt))
      && Date.parse(item.publishedAt) >= INCIDENT_START_MS
  ))
  const details = await Promise.allSettled(candidates.map(async (item) => {
    const url = trustedArticleUrl(item.url, provider)
    if (!url || item.sourceType === 'File') return { item, body: '' }
    const article = await fetchBody(url, { accept: 'text/html' })
    await archiveBody({ providerId: provider.id, url, ...article, retrievedAt }, query)
    return { item, body: article.body }
  }))
  const notices = details.flatMap((detail, index) => {
    const item = candidates[index]
    const normalized = normalizeRdfNotice(
      item,
      provider,
      retrievedAt,
      detail.status === 'fulfilled' ? detail.value.body : '',
    )
    return normalized ? [normalized] : []
  })
  return {
    provider: {
      id: provider.id,
      name: provider.name,
      municipality: provider.municipality,
      publisherKind: provider.publisherKind || 'official-municipal',
      url: provider.publicUrl,
      endpoint: provider.endpoint,
      format: provider.format,
      status: 'ok',
      itemCount: items.length,
      matchedCount: notices.length,
      detailFailures: details.filter((detail) => detail.status === 'rejected').length,
    },
    notices,
  }
}

async function refreshWaimes(provider, retrievedAt, query) {
  const response = await fetchBody(provider.endpoint, { accept: 'application/json' })
  await archiveBody({ providerId: provider.id, url: provider.endpoint, ...response, retrievedAt }, query)
  const payload = JSON.parse(response.body)
  const items = Array.isArray(payload?.items) ? payload.items : []
  const notices = items
    .map((item) => normalizeWaimesNotice(item, provider, retrievedAt))
    .filter(Boolean)
  return {
    provider: {
      id: provider.id,
      name: provider.name,
      municipality: provider.municipality,
      publisherKind: provider.publisherKind || 'official-municipal',
      url: provider.publicUrl,
      endpoint: provider.endpoint,
      format: provider.format,
      status: 'ok',
      itemCount: items.length,
      matchedCount: notices.length,
      detailFailures: 0,
    },
    notices,
  }
}

async function refreshWordpressApi(provider, retrievedAt, query) {
  const response = await fetchBody(provider.endpoint, { accept: 'application/json' })
  await archiveBody({ providerId: provider.id, url: provider.endpoint, ...response, retrievedAt }, query)
  const items = JSON.parse(response.body)
  if (!Array.isArray(items)) throw new Error(`${provider.name} WordPress API returned an invalid payload`)
  const notices = items
    .map((item) => normalizeWordpressApiNotice(item, provider, retrievedAt))
    .filter(Boolean)
  return {
    provider: {
      id: provider.id,
      name: provider.name,
      municipality: provider.municipality,
      publisherKind: provider.publisherKind || 'official-municipal',
      url: provider.publicUrl,
      endpoint: provider.endpoint,
      format: provider.format,
      status: 'ok',
      itemCount: items.length,
      matchedCount: notices.length,
      detailFailures: 0,
    },
    notices,
  }
}

function htmlNewsCandidate(item) {
  const text = normalizeSearchText(`${item?.title || ''} ${item?.summary || ''} ${item?.url || ''}`)
  return /incend|feu|brand|feuer|rauch|evaku|fagnes|hohen venn|drossart|kuechelscheid|kuchelscheid|leykaul|aktuelle lage/iu.test(text)
}

async function refreshHlz(provider, retrievedAt, query) {
  const response = await fetchBody(provider.endpoint, { accept: 'text/html' })
  await archiveBody({ providerId: provider.id, url: provider.endpoint, ...response, retrievedAt }, query)
  const items = parseHlzNewsList(response.body, provider.endpoint)
  const candidates = items.filter(htmlNewsCandidate)
  const details = await Promise.allSettled(candidates.map(async (item) => {
    const url = trustedArticleUrl(item.url, provider)
    if (!url) throw new Error('HLZ DG returned an untrusted article URL')
    const article = await fetchBody(url, { accept: 'text/html' })
    await archiveBody({ providerId: provider.id, url, ...article, retrievedAt }, query)
    return normalizeHlzNotice(item, article.body, provider, retrievedAt)
  }))
  const notices = details.flatMap((detail) => (
    detail.status === 'fulfilled' && detail.value ? [detail.value] : []
  ))
  return {
    provider: {
      id: provider.id,
      name: provider.name,
      municipality: provider.municipality,
      publisherKind: provider.publisherKind,
      url: provider.publicUrl,
      endpoint: provider.endpoint,
      format: provider.format,
      status: 'ok',
      itemCount: items.length,
      matchedCount: notices.length,
      detailFailures: details.filter((detail) => detail.status === 'rejected').length,
    },
    notices,
  }
}

function butgenbachCandidate(item) {
  const text = normalizeSearchText(`${item?.title || ''} ${item?.url || ''}`)
  return /fagnes|hohen venn|kuechelscheid|kuchelscheid|leykaul|wichtige information/iu.test(text)
}

async function refreshButgenbach(provider, retrievedAt, query, previousProvider = null) {
  const response = await fetchBody(provider.endpoint, { accept: 'application/json' })
  await archiveBody({ providerId: provider.id, url: provider.endpoint, ...response, retrievedAt }, query)
  const items = JSON.parse(response.body)
  if (!Array.isArray(items)) throw new Error('Bütgenbach search returned an invalid payload')
  const candidatesById = new Map()
  for (const item of items.filter(butgenbachCandidate)) candidatesById.set(item.id, item)
  const latestItems = [...items]
    .filter((candidate) => Number.isFinite(Number(candidate?.id)))
    .sort((left, right) => Number(right.id) - Number(left.id))
    .slice(0, 8)
  const previouslySeen = new Set(previousProvider?.latestItemIds || [])
  for (const item of latestItems) {
    if (!previousProvider || !previouslySeen.has(item.id)) candidatesById.set(item.id, item)
  }
  const candidates = [...candidatesById.values()].slice(0, 15)
  const details = await Promise.allSettled(candidates.map(async (item) => {
    const url = trustedArticleUrl(item?.url, provider)
    if (!url) throw new Error('Bütgenbach returned an untrusted article URL')
    const article = await fetchBody(url, { accept: 'text/html' })
    await archiveBody({ providerId: provider.id, url, ...article, retrievedAt }, query)
    return normalizeButgenbachNotice(item, article.body, provider, retrievedAt)
  }))
  const notices = details.flatMap((detail) => (
    detail.status === 'fulfilled' && detail.value ? [detail.value] : []
  ))
  return {
    provider: {
      id: provider.id,
      name: provider.name,
      municipality: provider.municipality,
      publisherKind: provider.publisherKind || 'official-municipal',
      url: provider.publicUrl,
      endpoint: provider.endpoint,
      format: provider.format,
      status: 'ok',
      itemCount: items.length,
      matchedCount: notices.length,
      detailFailures: details.filter((detail) => detail.status === 'rejected').length,
      latestItemIds: latestItems.map((item) => item.id),
    },
    notices,
  }
}

function mergeNotices(previous, incoming) {
  const notices = new Map((previous ?? []).map((notice) => [notice.id, notice]))
  for (const notice of incoming) {
    const old = notices.get(notice.id)
    notices.set(notice.id, old
      ? { ...old, ...notice, firstRetrievedAt: old.firstRetrievedAt }
      : notice)
  }
  return [...notices.values()].sort((left, right) => (
    Date.parse(left.publishedAt) - Date.parse(right.publishedAt)
  ))
}

export function municipalNoticeEvent(notice) {
  const observedAt = notice.effectiveAt || notice.publishedAt
  return {
    id: `official-local:${notice.id}`,
    observedAt,
    timestampMs: Date.parse(observedAt),
    title: notice.title,
    detail: notice.summary || `${notice.publisher} incident update`,
    type: noticeType(notice),
    sourceName: `${notice.publisher} (${notice.publisherKind === 'official-emergency-service'
      ? 'official emergency-service update'
      : notice.publisherKind === 'official-police'
        ? 'official police update'
        : 'official municipal notice'})`,
    sourceUrl: notice.url,
  }
}

export async function refreshMunicipalUpdates({ requestedAtMs, query }) {
  const retrievedAt = new Date(requestedAtMs).toISOString()
  const previous = (await loadDataset('local-authority-updates', query))?.payload ?? { notices: [] }
  const results = await Promise.allSettled(MUNICIPAL_PROVIDERS.map((provider) => {
    const previousProvider = previous.providers?.find((item) => item.id === provider.id) ?? null
    if (provider.format === 'rdf-rss') return refreshRdfProvider(provider, retrievedAt, query)
    if (provider.format === 'imio-json') return refreshWaimes(provider, retrievedAt, query)
    if (provider.format === 'wordpress-api') return refreshWordpressApi(provider, retrievedAt, query)
    if (provider.format === 'html-news-list') return refreshHlz(provider, retrievedAt, query)
    return refreshButgenbach(provider, retrievedAt, query, previousProvider)
  }))
  const succeeded = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])
  if (!succeeded.length) throw new Error('No official local-authority source succeeded')

  const incoming = succeeded.flatMap((result) => result.notices)
  const notices = mergeNotices(previous.notices, incoming)
  const providers = results.map((result, index) => result.status === 'fulfilled'
    ? result.value.provider
    : {
        id: MUNICIPAL_PROVIDERS[index].id,
        name: MUNICIPAL_PROVIDERS[index].name,
        municipality: MUNICIPAL_PROVIDERS[index].municipality,
        publisherKind: MUNICIPAL_PROVIDERS[index].publisherKind || 'official-municipal',
        url: MUNICIPAL_PROVIDERS[index].publicUrl,
        endpoint: MUNICIPAL_PROVIDERS[index].endpoint,
        format: MUNICIPAL_PROVIDERS[index].format,
        status: 'failed',
        error: String(result.reason?.message || result.reason).slice(0, 300),
        itemCount: null,
        matchedCount: null,
        detailFailures: null,
      })
  const sourceChangeDates = notices
    .flatMap((notice) => [notice.updatedAt, notice.publishedAt])
    .filter((value) => Number.isFinite(Date.parse(value)))
    .sort((left, right) => Date.parse(left) - Date.parse(right))
  const payload = {
    schemaVersion: 1,
    retrievedAt,
    source: {
      name: 'Official local-authority incident updates',
      publisherKinds: ['official-municipal', 'official-emergency-service', 'official-police'],
      selectionRule: 'Official incident-area authority publication since ignition with an emergency/fire term and incident-area context',
    },
    providers,
    lastSourceChangeAt: sourceChangeDates.at(-1) ?? previous.lastSourceChangeAt ?? null,
    noticeCount: notices.length,
    notices,
    events: notices
      .map(municipalNoticeEvent)
      .sort((left, right) => left.timestampMs - right.timestampMs),
  }
  const stored = await saveDataset({ key: 'local-authority-updates', payload }, query)
  return {
    itemCount: notices.length,
    metadata: {
      changed: stored.changed,
      newOrUpdatedMatches: incoming.length,
      healthyProviders: providers.filter((provider) => provider.status === 'ok').map((provider) => provider.id),
      failedProviders: providers.filter((provider) => provider.status === 'failed').map((provider) => provider.id),
      degradedProviders: providers.filter((provider) => provider.detailFailures > 0).map((provider) => provider.id),
      detailFailures: providers.reduce((total, provider) => total + (provider.detailFailures || 0), 0),
      providerItemCounts: Object.fromEntries(providers.map((provider) => [provider.id, provider.itemCount])),
    },
  }
}
