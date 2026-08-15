import { createHash } from 'node:crypto'

import { loadDataset, saveArtifact, saveDataset } from './database.mjs'

const VEDIA_API = 'https://www.vedia.be/jsonapi/node/content'
const VEDIA_INCIDENT_START_SECONDS = Math.floor(Date.parse('2026-08-14T00:00:00.000Z') / 1_000)

function normalizeSearchText(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase('fr')
}

function decodeHtml(value) {
  return String(value ?? '')
    .replace(/<script[\s\S]*?<\/script>/giu, ' ')
    .replace(/<style[\s\S]*?<\/style>/giu, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/giu, ' ')
    .replace(/&amp;/giu, '&')
    .replace(/&quot;|&#34;/giu, '"')
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/\s+/g, ' ')
    .trim()
}

function metaContent(attributes, predicate) {
  return (attributes.metatag ?? [])
    .find((item) => predicate(item.attributes ?? {}))
    ?.attributes?.content ?? null
}

function canonicalUrl(attributes) {
  const fromMeta = (attributes.metatag ?? [])
    .find((item) => item.attributes?.rel === 'canonical')
    ?.attributes?.href
  if (fromMeta) return fromMeta
  const alias = attributes.path?.alias
  return alias ? new URL(alias, 'https://www.vedia.be').href : null
}

function isIncidentArticle(article) {
  const headline = normalizeSearchText([
    article.title,
    article.summary,
  ].join(' '))
  const incident = /incend|brasier|feu|fumee|brule|centre de crise|plan d[’']urgence provincial/iu.test(headline)
  const location = /fagnes|drossart|baelen|jalhay|sourbrodt|butgenbach|mont rigi/iu.test(headline)
  return incident && location
}

function eventType(article) {
  const text = normalizeSearchText(`${article.title} ${article.summary}`)
  if (/evacua/iu.test(text)) return 'evacuation'
  if (/interdi|annul|ferme|fermeture|confin/iu.test(text)) return 'closure'
  return 'alert'
}

export function normalizeVediaArticle(resource, retrievedAt) {
  const attributes = resource?.attributes ?? {}
  const content = attributes.field_content_main_content ?? {}
  const summary = decodeHtml(
    content.summary
      || metaContent(attributes, (meta) => meta.property === 'og:description')
      || '',
  )
  const bodyText = decodeHtml(content.value || content.processed || '')
  const article = {
    id: resource.id,
    webId: attributes.field_content_web_id ?? null,
    title: decodeHtml(attributes.title),
    summary,
    bodyText,
    url: canonicalUrl(attributes),
    imageUrl: metaContent(attributes, (meta) => (
      meta.property === 'og:image' && !String(meta.content).includes('default-share')
    )),
    createdAt: attributes.created ?? null,
    publishedAt: attributes.published_at || attributes.created || null,
    updatedAt: attributes.field_updated_at || attributes.changed || attributes.created || null,
    firstRetrievedAt: retrievedAt,
    lastRetrievedAt: retrievedAt,
    publisher: 'Vedia',
    publisherKind: 'local-media',
  }
  return article.id && article.title && article.url && isIncidentArticle(article) ? article : null
}

function vediaRequestUrl(previous) {
  const lastChangeMs = Date.parse(previous?.lastSourceChangeAt)
  const sinceSeconds = Number.isFinite(lastChangeMs)
    ? Math.max(VEDIA_INCIDENT_START_SECONDS, Math.floor(lastChangeMs / 1_000) - 60)
    : VEDIA_INCIDENT_START_SECONDS
  const parameters = new URLSearchParams({
    'filter[changed-after][condition][path]': 'changed',
    'filter[changed-after][condition][operator]': '>',
    'filter[changed-after][condition][value]': String(sinceSeconds),
    'page[limit]': '50',
    sort: 'changed',
    'fields[node--content]': [
      'drupal_internal__nid',
      'title',
      'created',
      'changed',
      'published_at',
      'path',
      'field_content_main_content',
      'field_content_web_id',
      'field_updated_at',
      'metatag',
    ].join(','),
  })
  return `${VEDIA_API}?${parameters}`
}

async function fetchVediaPage(url) {
  const response = await fetch(url, {
    headers: { Accept: 'application/vnd.api+json' },
    signal: AbortSignal.timeout(25_000),
  })
  const rawBody = await response.text()
  if (!response.ok) throw new Error(`HTTP ${response.status} from Vedia JSON:API`)
  return { rawBody, payload: JSON.parse(rawBody) }
}

export async function refreshVedia({ requestedAtMs, query }) {
  const retrievedAt = new Date(requestedAtMs).toISOString()
  const previous = (await loadDataset('media-reports', query))?.payload ?? { articles: [] }
  const firstRequestUrl = vediaRequestUrl(previous)
  const pages = []
  let nextUrl = firstRequestUrl
  for (let page = 0; nextUrl && page < 4; page += 1) {
    const result = await fetchVediaPage(nextUrl)
    pages.push({ url: nextUrl, ...result })
    nextUrl = result.payload.links?.next?.href ?? null
  }

  const incoming = pages.flatMap((page) => (
    (page.payload.data ?? []).map((resource) => normalizeVediaArticle(resource, retrievedAt)).filter(Boolean)
  ))
  const articles = new Map((previous.articles ?? [])
    .filter(isIncidentArticle)
    .map((article) => [article.id, article]))
  for (const article of incoming) {
    const old = articles.get(article.id)
    articles.set(article.id, old
      ? { ...old, ...article, firstRetrievedAt: old.firstRetrievedAt }
      : article)
  }
  const retained = [...articles.values()].sort((left, right) => (
    Date.parse(left.publishedAt) - Date.parse(right.publishedAt)
  ))
  const sourceChanges = pages.flatMap((page) => page.payload.data ?? [])
    .map((resource) => resource.attributes?.field_updated_at || resource.attributes?.changed)
    .filter((value) => Number.isFinite(Date.parse(value)))
  const lastSourceChangeAt = sourceChanges.length
    ? sourceChanges.sort((left, right) => Date.parse(left) - Date.parse(right)).at(-1)
    : previous.lastSourceChangeAt ?? null

  const artifactBody = JSON.stringify(pages.map((page) => page.payload))
  const bytes = Buffer.from(artifactBody)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  await saveArtifact({
    artifactKey: `vedia-jsonapi-${sha256}`,
    sourceKey: 'vedia',
    originalPath: firstRequestUrl,
    contentType: 'application/vnd.api+json',
    contentEncoding: 'identity',
    originalSize: bytes.byteLength,
    sha256,
    capturedAt: retrievedAt,
    contentBase64: bytes.toString('base64'),
  }, query)

  const payload = {
    schemaVersion: 1,
    retrievedAt,
    source: {
      name: 'Vedia public JSON:API',
      url: 'https://www.vedia.be/',
      endpoint: VEDIA_API,
      requestUrl: firstRequestUrl,
      publisherKind: 'local-media',
    },
    selection: {
      after: '2026-08-14T00:00:00.000Z',
      rule: 'Fire/smoke term and incident-area place term; local reporting is never relabelled as an official source',
    },
    lastSourceChangeAt,
    articleCount: retained.length,
    articles: retained,
    events: retained.map((article) => ({
      id: `vedia:${article.id}`,
      observedAt: article.publishedAt,
      timestampMs: Date.parse(article.publishedAt),
      title: article.title,
      detail: article.summary || 'Vedia incident report',
      type: eventType(article),
      sourceName: 'Vedia (local reporting)',
      sourceUrl: article.url,
    })),
  }
  const stored = await saveDataset({ key: 'media-reports', payload }, query)
  return {
    itemCount: retained.length,
    metadata: {
      changed: stored.changed,
      newOrUpdatedMatches: incoming.length,
      pagesRead: pages.length,
    },
  }
}
