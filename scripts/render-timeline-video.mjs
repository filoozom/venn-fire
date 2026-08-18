#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { access, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import process from 'node:process'

import { chromium } from '@playwright/test'

const FIVE_MINUTES_MS = 5 * 60 * 1000

const DEFAULT_CONFIG = Object.freeze({
  url: 'https://venn-fire.vercel.app',
  output: 'output/venn-fire-full-timeline.mp4',
  previewOutput: null,
  metadataOutput: null,
  width: 1920,
  height: 1080,
  fps: 30,
  frameStep: 1,
  holdFrames: 1,
  introSeconds: 1,
  outroSeconds: 2,
  startFrame: null,
  endFrame: null,
  startTime: null,
  endTime: null,
  settleMs: 80,
  assetTimeoutMs: 15_000,
  pageTimeoutMs: 90_000,
  waitForAircraft: true,
  waitForAssets: true,
  freezeData: true,
  baseMap: null,
  presentation: 'viewer',
  language: 'de',
  mapFocus: 'default',
  mapZoomSteps: null,
  layers: {},
  ffmpegPath: 'ffmpeg',
  codec: 'libx264',
  preset: 'medium',
  crf: 20,
  overwrite: false,
  headless: true,
})

const HELP = `
Render the public incident timeline to a 1080p H.264 video.

Usage:
  pnpm video:timeline -- [options]

Options:
  --config <file>             Read options from JSON
  --url <url>                 Viewer URL (default: ${DEFAULT_CONFIG.url})
  --output, -o <file>         MP4 output path
  --preview-output <file>     Capture one PNG at the selected range's final frame; no video
  --metadata-output <file>    JSON sidecar path (default: <output>.json)
  --width <pixels>            Browser/video width (default: 1920)
  --height <pixels>           Browser/video height (default: 1080)
  --fps <number>              Output frame rate (default: 30)
  --frame-step <number>       Capture every Nth five-minute frame
  --hold-frames <number>      Repeat every captured frame N times
  --intro-seconds <number>    Hold the first frame (default: 1)
  --outro-seconds <number>    Hold the last frame (default: 2)
  --start-frame <index>       First timeline frame, inclusive
  --end-frame <index>         Last timeline frame, inclusive
  --start-time <ISO time>     First five-minute frame at/after this time
  --end-time <ISO time>       Last five-minute frame at/before this time
  --settle-ms <number>        Extra browser-paint delay after each time change
  --asset-timeout-ms <number> Maximum wait for a timeline raster image
  --page-timeout-ms <number>  Initial viewer/database timeout
  --base-map <default|terrain|satellite|topo>
  --presentation <viewer|news> Full viewer or clean news-style map
  --language <de|en>          News-presentation language (default: de)
  --map-focus <default|incident|fire>
  --map-zoom-steps <number>   Extra zoom-in steps after focusing the map
  --layer "Label=on|off"       Override a layer by its exact visible label; repeatable
  --codec <name>              FFmpeg video codec (default: libx264)
  --preset <name>             FFmpeg codec preset (default: medium)
  --crf <number>              FFmpeg quality value (default: 20)
  --ffmpeg <path>             FFmpeg executable (default: ffmpeg)
  --no-wait-for-aircraft      Do not wait for the async aircraft dataset
  --no-wait-for-assets        Do not wait for timeline raster images
  --no-freeze-data            Allow API refreshes during the render
  --headful                   Show the Chromium window
  --overwrite                 Replace an existing video/sidecar
  --help, -h                  Show this help

Examples:
  pnpm video:timeline -- --output output/timeline.mp4
  pnpm video:timeline -- --presentation news --output output/news-timeline.mp4
  pnpm video:timeline -- --config timeline-video.config.example.json
  pnpm video:timeline -- --layer "NASA VIIRS false colour=on" --frame-step 2
`.trim()

function fail(message) {
  throw new Error(message)
}

function finiteNumber(value, name, { integer = false, min = -Infinity, max = Infinity } = {}) {
  const number = Number(value)
  if (!Number.isFinite(number) || (integer && !Number.isInteger(number)) || number < min || number > max) {
    fail(`${name} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}; received ${value}`)
  }
  return number
}

function booleanValue(value, name) {
  if (typeof value === 'boolean') return value
  const normalized = String(value).trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  fail(`${name} must be on/off or true/false; received ${value}`)
}

function nextArgument(arguments_, index, option) {
  const value = arguments_[index + 1]
  if (value == null || value.startsWith('--')) fail(`${option} requires a value`)
  return value
}

function parseLayerOverride(value) {
  const separator = value.lastIndexOf('=')
  if (separator < 1) fail(`--layer must use "Exact visible label=on|off"; received ${value}`)
  const label = value.slice(0, separator).trim()
  if (!label) fail('--layer requires a non-empty visible label')
  return [label, booleanValue(value.slice(separator + 1), `layer ${label}`)]
}

function validateConfig(config) {
  let parsedUrl
  try {
    parsedUrl = new URL(config.url)
  } catch {
    fail(`url is invalid: ${config.url}`)
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) fail('url must use http or https')

  const normalized = {
    ...config,
    url: parsedUrl.href,
    width: finiteNumber(config.width, 'width', { integer: true, min: 320, max: 7680 }),
    height: finiteNumber(config.height, 'height', { integer: true, min: 240, max: 4320 }),
    fps: finiteNumber(config.fps, 'fps', { min: 0.1, max: 120 }),
    frameStep: finiteNumber(config.frameStep, 'frameStep', { integer: true, min: 1, max: 10_000 }),
    holdFrames: finiteNumber(config.holdFrames, 'holdFrames', { integer: true, min: 1, max: 10_000 }),
    introSeconds: finiteNumber(config.introSeconds, 'introSeconds', { min: 0, max: 3600 }),
    outroSeconds: finiteNumber(config.outroSeconds, 'outroSeconds', { min: 0, max: 3600 }),
    settleMs: finiteNumber(config.settleMs, 'settleMs', { integer: true, min: 0, max: 60_000 }),
    assetTimeoutMs: finiteNumber(config.assetTimeoutMs, 'assetTimeoutMs', { integer: true, min: 100, max: 300_000 }),
    pageTimeoutMs: finiteNumber(config.pageTimeoutMs, 'pageTimeoutMs', { integer: true, min: 1000, max: 600_000 }),
    crf: finiteNumber(config.crf, 'crf', { min: 0, max: 63 }),
    overwrite: booleanValue(config.overwrite, 'overwrite'),
    headless: booleanValue(config.headless, 'headless'),
    waitForAircraft: booleanValue(config.waitForAircraft, 'waitForAircraft'),
    waitForAssets: booleanValue(config.waitForAssets, 'waitForAssets'),
    freezeData: booleanValue(config.freezeData, 'freezeData'),
  }
  if (normalized.width % 2 || normalized.height % 2) fail('width and height must be even for yuv420p video')
  if (!config.output || typeof config.output !== 'string') fail('output must be a file path')
  if (config.previewOutput != null && (typeof config.previewOutput !== 'string' || !config.previewOutput.trim())) {
    fail('previewOutput must be a PNG file path')
  }
  if (!config.ffmpegPath || typeof config.ffmpegPath !== 'string') fail('ffmpegPath must be an executable path')
  if (!config.codec || typeof config.codec !== 'string') fail('codec must be a codec name')
  if (!config.preset || typeof config.preset !== 'string') fail('preset must be an FFmpeg preset')
  if (config.baseMap != null && !['default', 'terrain', 'satellite', 'topo'].includes(config.baseMap)) {
    fail('baseMap must be default, terrain, satellite or topo')
  }
  if (!['viewer', 'news'].includes(config.presentation)) fail('presentation must be viewer or news')
  if (!['de', 'en'].includes(config.language)) fail('language must be de or en')
  if (!['default', 'incident', 'fire'].includes(config.mapFocus)) fail('mapFocus must be default, incident or fire')
  if (config.mapZoomSteps != null) {
    normalized.mapZoomSteps = finiteNumber(config.mapZoomSteps, 'mapZoomSteps', { integer: true, min: 0, max: 8 })
  }
  if (!config.layers || typeof config.layers !== 'object' || Array.isArray(config.layers)) fail('layers must be a JSON object')
  normalized.layers = Object.fromEntries(Object.entries(config.layers).map(([label, enabled]) => [
    label,
    booleanValue(enabled, `layer ${label}`),
  ]))
  for (const field of ['startFrame', 'endFrame']) {
    if (config[field] != null) normalized[field] = finiteNumber(config[field], field, { integer: true, min: 0 })
  }
  for (const field of ['startTime', 'endTime']) {
    if (config[field] != null && !Number.isFinite(Date.parse(config[field]))) fail(`${field} must be an ISO timestamp with a timezone`)
  }
  if (normalized.startFrame != null && normalized.startTime != null) fail('Use startFrame or startTime, not both')
  if (normalized.endFrame != null && normalized.endTime != null) fail('Use endFrame or endTime, not both')
  return normalized
}

async function configurationFromArguments(arguments_) {
  if (arguments_.includes('--help') || arguments_.includes('-h')) return { help: true }

  let fileConfig = {}
  const configIndex = arguments_.indexOf('--config')
  if (configIndex >= 0) {
    const configPath = nextArgument(arguments_, configIndex, '--config')
    const contents = await readFile(resolve(process.cwd(), configPath), 'utf8')
    fileConfig = JSON.parse(contents)
    if (!fileConfig || typeof fileConfig !== 'object' || Array.isArray(fileConfig)) fail('The config file must contain a JSON object')
  }

  const config = { ...DEFAULT_CONFIG, ...fileConfig, layers: { ...DEFAULT_CONFIG.layers, ...(fileConfig.layers ?? {}) } }
  const optionFields = new Map([
    ['--url', 'url'], ['--output', 'output'], ['-o', 'output'], ['--preview-output', 'previewOutput'],
    ['--metadata-output', 'metadataOutput'],
    ['--width', 'width'], ['--height', 'height'], ['--fps', 'fps'], ['--frame-step', 'frameStep'],
    ['--hold-frames', 'holdFrames'], ['--intro-seconds', 'introSeconds'], ['--outro-seconds', 'outroSeconds'],
    ['--start-frame', 'startFrame'], ['--end-frame', 'endFrame'], ['--start-time', 'startTime'],
    ['--end-time', 'endTime'], ['--settle-ms', 'settleMs'], ['--asset-timeout-ms', 'assetTimeoutMs'],
    ['--page-timeout-ms', 'pageTimeoutMs'], ['--base-map', 'baseMap'], ['--presentation', 'presentation'], ['--language', 'language'],
    ['--map-focus', 'mapFocus'], ['--map-zoom-steps', 'mapZoomSteps'],
    ['--codec', 'codec'],
    ['--preset', 'preset'], ['--crf', 'crf'], ['--ffmpeg', 'ffmpegPath'],
  ])

  for (let index = 0; index < arguments_.length; index += 1) {
    const option = arguments_[index]
    if (option === '--config') {
      index += 1
      continue
    }
    if (option === '--layer') {
      const [label, enabled] = parseLayerOverride(nextArgument(arguments_, index, option))
      config.layers[label] = enabled
      index += 1
      continue
    }
    if (optionFields.has(option)) {
      config[optionFields.get(option)] = nextArgument(arguments_, index, option)
      index += 1
      continue
    }
    if (option === '--no-wait-for-aircraft') config.waitForAircraft = false
    else if (option === '--no-wait-for-assets') config.waitForAssets = false
    else if (option === '--no-freeze-data') config.freezeData = false
    else if (option === '--headful') config.headless = false
    else if (option === '--overwrite') config.overwrite = true
    else fail(`Unknown option: ${option}`)
  }

  return { help: false, config: validateConfig(config) }
}

function sanitizeResponseHeaders(headers) {
  const excluded = new Set(['content-encoding', 'content-length', 'transfer-encoding'])
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !excluded.has(name.toLowerCase())))
}

function datasetPayload(response, key) {
  return response?.datasets?.[key]?.payload ?? null
}

function formatTimestamp(timestampMs) {
  return new Date(timestampMs).toISOString()
}

function presentationUrl(config) {
  const url = new URL(config.url)
  if (config.presentation === 'news') {
    url.searchParams.set('presentation', 'news')
    url.searchParams.set('lang', config.language)
  }
  return url.toString()
}

async function pathExists(path) {
  try {
    await access(path, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

async function applyViewerConfiguration(page, config) {
  if (config.baseMap && config.baseMap !== 'default') {
    const labels = { terrain: 'Map', satellite: 'Satellite', topo: 'Topo' }
    await page.getByRole('group', { name: 'Base map' }).getByRole('button', { name: labels[config.baseMap] }).click()
  }

  for (const [label, enabled] of Object.entries(config.layers)) {
    const result = await page.evaluate(({ exactLabel, expected }) => {
      const normalized = (value) => value?.replace(/\s+/g, ' ').trim()
      const layerButton = [...document.querySelectorAll('.layer-row')].find((element) => (
        normalized(element.querySelector('.layer-copy strong')?.textContent) === exactLabel
      ))
      if (layerButton) {
        const current = layerButton.getAttribute('aria-pressed') === 'true'
        if (current !== expected) layerButton.click()
        return { found: true, kind: 'map layer', previous: current }
      }

      const checkboxLabel = [...document.querySelectorAll('.layer-checkbox')].find((element) => (
        normalized(element.querySelector('span')?.textContent) === exactLabel
      ))
      if (checkboxLabel) {
        const input = checkboxLabel.querySelector('input[type="checkbox"]')
        const current = Boolean(input?.checked)
        if (input && current !== expected) input.click()
        return { found: Boolean(input), kind: 'checkbox', previous: current }
      }

      const available = [
        ...[...document.querySelectorAll('.layer-row .layer-copy strong')].map((element) => normalized(element.textContent)),
        ...[...document.querySelectorAll('.layer-checkbox > span')].map((element) => normalized(element.textContent)),
      ].filter(Boolean)
      return { found: false, available }
    }, { exactLabel: label, expected: enabled })
    if (!result.found) fail(`Layer "${label}" was not found. Available labels: ${result.available.join(', ')}`)
  }

  await page.evaluate(() => {
    const sidebar = document.querySelector('.left-sidebar')
    const inspector = document.querySelector('.right-inspector')
    if (sidebar) sidebar.scrollTop = 0
    if (inspector) inspector.scrollTop = 0
  })
  await page.evaluate(() => new Promise((resolvePaint) => requestAnimationFrame(() => requestAnimationFrame(resolvePaint))))
}

const NEWS_PRESENTATION_CSS = `
  html[data-video-presentation="news"] .app-header,
  html[data-video-presentation="news"] .left-sidebar,
  html[data-video-presentation="news"] .right-inspector,
  html[data-video-presentation="news"] .basemap-switcher,
  html[data-video-presentation="news"] .mobile-layer-button,
  html[data-video-presentation="news"] .map-warning,
  html[data-video-presentation="news"] .map-controls,
  html[data-video-presentation="news"] .map-scale-card {
    display: none !important;
  }

  html[data-video-presentation="news"] .workspace {
    display: block !important;
    width: 100vw !important;
    height: 100vh !important;
  }

  html[data-video-presentation="news"] .map-region {
    position: absolute !important;
    inset: 0 !important;
    width: 100vw !important;
    height: 100vh !important;
  }

  html[data-video-presentation="news"] .map-topbar {
    top: 30px !important;
    right: 34px !important;
    left: auto !important;
    width: auto !important;
    justify-content: flex-end !important;
  }

  html[data-video-presentation="news"] .map-date-chip {
    gap: 17px !important;
    padding: 13px 18px !important;
    color: #f2c788 !important;
    background: rgba(19, 48, 39, 0.94) !important;
    border: 1px solid rgba(255, 255, 255, 0.22) !important;
    border-radius: 5px !important;
    box-shadow: 0 10px 32px rgba(15, 35, 28, 0.28) !important;
    backdrop-filter: blur(12px) !important;
  }

  html[data-video-presentation="news"] .map-date-chip svg {
    display: none !important;
  }

  html[data-video-presentation="news"] .map-date-chip span {
    color: #f2c788 !important;
    font-size: 17px !important;
    font-weight: 900 !important;
    letter-spacing: 0.13em !important;
  }

  html[data-video-presentation="news"] .map-date-chip strong {
    min-width: 110px !important;
    padding-left: 17px !important;
    color: #fff !important;
    border-left-color: rgba(255, 255, 255, 0.28) !important;
    font-family: Georgia, "Times New Roman", serif !important;
    font-size: 36px !important;
    font-weight: 500 !important;
    line-height: 1 !important;
    letter-spacing: -0.02em !important;
  }

  html[data-video-presentation="news"] .map-date-chip strong::after {
    margin-left: 6px;
    color: rgba(255, 255, 255, 0.68);
    font-family: Inter, ui-sans-serif, sans-serif;
    font-size: 8px;
    font-weight: 800;
    letter-spacing: 0.1em;
    content: "CEST";
  }

  html[data-video-presentation="news"] .timeline-panel {
    right: 34px !important;
    bottom: 28px !important;
    left: 34px !important;
    padding: 11px 18px 8px !important;
    background: rgba(255, 255, 255, 0.94) !important;
    border: 1px solid rgba(255, 255, 255, 0.9) !important;
    border-radius: 5px !important;
    box-shadow: 0 14px 38px rgba(19, 43, 34, 0.26) !important;
    backdrop-filter: blur(14px) !important;
  }

  html[data-video-presentation="news"] .timeline-head {
    min-height: 19px !important;
    padding: 0 1px 4px !important;
    border-bottom: 0 !important;
  }

  html[data-video-presentation="news"] .timeline-title {
    gap: 9px !important;
  }

  html[data-video-presentation="news"] .timeline-title > span {
    color: #365248 !important;
    font-size: 12px !important;
    letter-spacing: 0.11em !important;
  }

  html[data-video-presentation="news"] .timeline-title strong {
    color: #52685f !important;
    font-size: 11px !important;
  }

  html[data-video-presentation="news"] .timeline-legend,
  html[data-video-presentation="news"] .timeline-foot,
  html[data-video-presentation="news"] .play-button,
  html[data-video-presentation="news"] .step-button,
  html[data-video-presentation="news"] .speed-button,
  html[data-video-presentation="news"] .timeline-now {
    display: none !important;
  }

  html[data-video-presentation="news"] .timeline-body {
    display: block !important;
    min-height: 71px !important;
    padding: 0 !important;
  }

  html[data-video-presentation="news"] .timeline-track-wrap {
    height: 71px !important;
  }

  html[data-video-presentation="news"] .mini-area-chart {
    top: 0 !important;
    height: 39px !important;
  }

  html[data-video-presentation="news"] .event-markers {
    top: 35px !important;
  }

  html[data-video-presentation="news"] .timeline-range {
    top: 36px !important;
  }

  html[data-video-presentation="news"] .timeline-ticks {
    top: 51px !important;
    color: #65766f !important;
    font-size: 11px !important;
  }

  #video-news-dashboard {
    position: fixed;
    z-index: 1600;
    top: 30px;
    left: 34px;
    width: 840px;
    color: #18372d;
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    pointer-events: none;
  }

  #video-news-dashboard .news-summary {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    min-height: 82px;
    overflow: hidden;
    color: #fff;
    background: rgba(19, 48, 39, 0.94);
    border: 1px solid rgba(255, 255, 255, 0.22);
    border-radius: 5px;
    box-shadow: 0 10px 32px rgba(15, 35, 28, 0.28);
    backdrop-filter: blur(12px);
  }

  #video-news-dashboard .news-stat {
    display: grid;
    grid-template-rows: 10px 31px 10px;
    align-content: center;
    row-gap: 3px;
    min-width: 0;
    padding: 12px 15px;
    border-left: 1px solid rgba(255, 255, 255, 0.16);
    text-align: center;
  }

  #video-news-dashboard .news-stat:first-child {
    border-left-color: transparent;
  }

  #video-news-dashboard .news-stat--wind {
    grid-template-columns: 57px minmax(0, 1fr);
    column-gap: 10px;
  }

  #video-news-dashboard .news-stat--wind > span,
  #video-news-dashboard .news-stat--wind > strong,
  #video-news-dashboard .news-stat--wind > small {
    grid-column: 2;
  }

  #video-news-dashboard .news-stat > span {
    align-self: center;
    color: #f2c788;
    font-size: 10px;
    font-weight: 900;
    line-height: 10px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  #video-news-dashboard .news-stat > strong {
    display: flex;
    align-items: baseline;
    justify-content: center;
    gap: 5px;
    height: 31px;
    margin: 0;
    font-family: Georgia, "Times New Roman", serif;
    font-size: 29px;
    font-weight: 500;
    line-height: 1;
    letter-spacing: -0.025em;
    white-space: nowrap;
  }

  #video-news-dashboard .news-stat > strong small {
    color: rgba(255, 255, 255, 0.66);
    font-family: Inter, ui-sans-serif, sans-serif;
    font-size: 9px;
    font-weight: 800;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  #video-news-dashboard .news-stat > small {
    align-self: center;
    min-height: 0;
    margin: 0;
    overflow: hidden;
    color: rgba(255, 255, 255, 0.68);
    font-size: 9px;
    line-height: 10px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  #video-news-dashboard .news-wind-value {
    align-items: center !important;
    gap: 9px !important;
    justify-content: center;
  }

  #video-news-dashboard .news-wind-arrow {
    grid-row: 1 / -1;
    grid-column: 1;
    align-self: stretch;
    display: grid;
    place-items: center;
    width: 57px;
    height: auto;
    color: #91dbc9;
    border: 1px solid rgba(145, 219, 201, 0.38);
    border-radius: 50%;
  }

  #video-news-dashboard .news-wind-arrow.is-unavailable {
    opacity: 0.28;
  }

  #video-news-dashboard .news-wind-arrow svg {
    width: 29px;
    height: 29px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
    transform: rotate(var(--wind-rotation, 0deg));
    transform-origin: center;
  }

  #video-news-dashboard .news-wind-copy {
    display: block;
    font-style: normal;
  }

  #video-news-dashboard .news-wind-copy b {
    color: #fff;
    font-size: 29px;
    font-weight: 850;
    line-height: 1;
  }

  html[data-video-presentation="news"] .map-place-label > span,
  html[data-video-presentation="news"] .border-label > span {
    transform: scale(1.4);
    transform-origin: left center;
  }

  html[data-video-presentation="news"] .aircraft-map-marker > span {
    transform: scale(1.45);
    transform-origin: center;
  }

  html[data-video-presentation="news"] .aircraft-map-marker > b {
    top: 7px;
    left: 42px;
    transform: scale(1.35);
    transform-origin: left center;
  }

  html[data-video-presentation="news"] .wind-source-marker > span,
  html[data-video-presentation="news"] .photo-evidence-marker > span,
  html[data-video-presentation="news"] .water-drop-marker > span {
    transform: scale(1.35);
    transform-origin: center;
  }

  html[data-video-presentation="news"] .fire-outline {
    stroke-width: 3.4;
  }

  html[data-video-presentation="news"] .leaflet-overlay-pane path[stroke-dasharray] {
    stroke-width: 3;
  }

  html[data-video-presentation="news"] .leaflet-tooltip {
    font-size: 13px !important;
  }

  html[data-video-presentation="news"] .leaflet-tooltip strong {
    font-size: 13.5px;
  }

  html[data-video-presentation="news"] .leaflet-control-attribution {
    max-width: 760px !important;
    margin: 0 84px 82px 0 !important;
    padding: 2px 6px !important;
    overflow: hidden !important;
    color: #607069 !important;
    background: rgba(255, 255, 255, 0.82) !important;
    border-radius: 3px !important;
    font-size: 7px !important;
    line-height: 1.2 !important;
    text-overflow: ellipsis !important;
    white-space: nowrap !important;
  }

  html[data-video-presentation="news"] .leaflet-control-attribution a[href*="leafletjs.com"] {
    display: none !important;
  }
`

async function applyPresentation(page, config) {
  if (config.presentation === 'news') {
    await page.waitForSelector('#news-presentation-dashboard', { timeout: config.pageTimeoutMs })
  }
  if (config.presentation === 'news' && !await page.locator('#news-presentation-dashboard').count()) {
    await page.evaluate(() => document.documentElement.setAttribute('data-video-presentation', 'news'))
    await page.addStyleTag({ content: NEWS_PRESENTATION_CSS })
    await page.evaluate(() => {
      const dashboard = document.createElement('section')
      dashboard.id = 'video-news-dashboard'
      dashboard.setAttribute('aria-label', 'Timeline news summary')
      dashboard.innerHTML = `
        <div class="news-summary">
          <article class="news-stat news-stat--wind">
            <i class="news-wind-arrow is-unavailable" aria-hidden="true">
              <svg viewBox="0 0 24 24"><path d="M12 20V4M6.5 9.5 12 4l5.5 5.5" /></svg>
            </i>
            <span>Observed wind</span>
            <strong class="news-wind-value">
              <i class="news-wind-copy"><b>—</b></i>
            </strong>
            <small class="news-wind-detail">two nearest stations</small>
          </article>
          <article class="news-stat">
            <span>Announced area</span>
            <strong><b class="news-area-announced">—</b><small class="news-area-announced-unit"></small></strong>
            <small>Official public reports</small>
          </article>
          <article class="news-stat">
            <span>Best estimate</span>
            <strong><b class="news-area-estimated">—</b><small class="news-area-estimated-unit"></small></strong>
            <small>Derived observation outline</small>
          </article>
        </div>
      `
      document.body.append(dashboard)
      window.dispatchEvent(new Event('resize'))
    })
    await page.waitForTimeout(150)
  }

  if (config.mapFocus === 'default' && config.presentation === 'news') {
    const waterFit = page.locator('button[aria-label="Show fire and water sources"]')
    if (await waterFit.count()) await waterFit.evaluate((button) => button.click())
    else await page.locator('button[aria-label="Center on fire"]').evaluate((button) => button.click())
    await page.waitForTimeout(950)
  }

  const focus = config.mapFocus
  if (focus !== 'default') {
    const ariaLabel = focus === 'fire' ? 'Center on fire' : 'Show full incident area'
    await page.locator(`button[aria-label="${ariaLabel}"]`).evaluate((button) => button.click())
    await page.waitForTimeout(950)
  }

  const zoomSteps = config.mapZoomSteps ?? 0
  for (let step = 0; step < zoomSteps; step += 1) {
    await page.locator('button[aria-label="Zoom in"]').evaluate((button) => button.click())
    await page.waitForTimeout(180)
  }
  await page.evaluate(() => new Promise((resolvePaint) => requestAnimationFrame(() => requestAnimationFrame(resolvePaint))))
}

async function updateNewsPresentation(page, config) {
  if (config.presentation !== 'news') return
  await page.evaluate(() => {
    const dashboard = document.querySelector('#video-news-dashboard')
    if (!dashboard) return
    const normalizedText = (element) => element?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
    const normalizedDegrees = (value) => ((value % 360) + 360) % 360
    const cardinal = (degrees) => {
      const labels = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']
      return labels[Math.round(normalizedDegrees(degrees) / 22.5) % 16]
    }

    const areaValue = (selector) => {
      const value = normalizedText(document.querySelector(selector)).replace(/\s*ha\s*$/i, '').trim()
      return value || '—'
    }
    const announced = areaValue('.snapshot-card--fire strong')
    const estimated = areaValue('.snapshot-card--estimate strong')
    dashboard.querySelector('.news-area-announced').textContent = announced
    dashboard.querySelector('.news-area-announced-unit').textContent = announced === '—' ? '' : 'ha'
    dashboard.querySelector('.news-area-estimated').textContent = estimated
    dashboard.querySelector('.news-area-estimated-unit').textContent = estimated === '—' ? '' : 'ha'

    const stationReadings = [...document.querySelectorAll('.wind-source-reading')].flatMap((row) => {
      const children = [...row.children]
      const name = normalizedText(children[1]?.querySelector('strong'))
      if (!name || name === 'Drossart grid') return []
      const rotation = Number.parseFloat(children[0]?.style.getPropertyValue('--wind-rotation'))
      const speedText = normalizedText([...(children[2]?.querySelectorAll('small') ?? [])].at(-1))
      const speed = Number.parseFloat(speedText.replace(',', '.'))
      if (!Number.isFinite(rotation) || !Number.isFinite(speed)) return []
      return [{ name, direction: normalizedDegrees(rotation - 180), speed }]
    }).slice(0, 2)

    const windArrow = dashboard.querySelector('.news-wind-arrow')
    const windCardinal = dashboard.querySelector('.news-wind-copy b')
    const windDetail = dashboard.querySelector('.news-wind-detail')
    if (stationReadings.length === 2) {
      const sumEast = stationReadings.reduce((sum, reading) => (
        sum + reading.speed * Math.sin(reading.direction * Math.PI / 180)
      ), 0)
      const sumNorth = stationReadings.reduce((sum, reading) => (
        sum + reading.speed * Math.cos(reading.direction * Math.PI / 180)
      ), 0)
      const meanDirection = normalizedDegrees(Math.atan2(sumEast, sumNorth) * 180 / Math.PI)
      const meanSpeed = Math.hypot(sumEast, sumNorth) / stationReadings.length
      windArrow.classList.remove('is-unavailable')
      windArrow.style.setProperty('--wind-rotation', `${normalizedDegrees(meanDirection + 180)}deg`)
      windCardinal.textContent = cardinal(meanDirection)
      windDetail.textContent = `from ${Math.round(meanDirection)}° · ${meanSpeed.toLocaleString('en-GB', { maximumFractionDigits: 1 })} km/h vector mean`
    } else {
      windArrow.classList.add('is-unavailable')
      windArrow.style.setProperty('--wind-rotation', '0deg')
      windCardinal.textContent = '—'
      windDetail.textContent = 'two nearest stations'
    }

    // Leaflet's BSD license does not require the on-map branding prefix. Keep
    // every tile/data-provider credit, but remove the Leaflet link and its
    // adjacent separator from this broadcast composition.
    for (const link of document.querySelectorAll('.leaflet-control-attribution a[href*="leafletjs.com"]')) {
      const parent = link.parentNode
      link.remove()
      while (parent?.firstChild) {
        const first = parent.firstChild
        const value = first.textContent ?? ''
        if (!value.trim() || value.trim() === '|') {
          first.remove()
          continue
        }
        if (first.nodeType === Node.TEXT_NODE && /^\s*\|\s*/.test(value)) {
          first.textContent = value.replace(/^\s*\|\s*/, '')
        }
        break
      }
    }
  })
}

async function selectTimelineFrame(page, index, config) {
  await page.locator('.timeline-range').evaluate((input, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter.call(input, String(value))
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }, index)

  await page.waitForFunction((expected) => Number(document.querySelector('.timeline-range')?.value) === expected, index, {
    timeout: config.pageTimeoutMs,
  })
  await page.evaluate(() => new Promise((resolvePaint) => requestAnimationFrame(() => requestAnimationFrame(resolvePaint))))
  if (config.settleMs) await page.waitForTimeout(config.settleMs)

  if (config.waitForAssets) {
    await page.waitForFunction(() => {
      const images = [...document.querySelectorAll('img.leaflet-image-layer')].filter((image) => {
        const bounds = image.getBoundingClientRect()
        const style = getComputedStyle(image)
        return style.display !== 'none' && style.visibility !== 'hidden' && bounds.width > 0 && bounds.height > 0
      })
      return images.every((image) => image.complete && image.naturalWidth > 0)
    }, null, { timeout: config.assetTimeoutMs })
  }
  await updateNewsPresentation(page, config)
}

function selectedTimelineFrames(config, timelineStartMs, sliderMax) {
  let start = config.startFrame ?? 0
  let end = config.endFrame ?? sliderMax
  if (config.startTime != null) start = Math.ceil((Date.parse(config.startTime) - timelineStartMs) / FIVE_MINUTES_MS)
  if (config.endTime != null) end = Math.floor((Date.parse(config.endTime) - timelineStartMs) / FIVE_MINUTES_MS)
  start = Math.max(0, start)
  end = Math.min(sliderMax, end)
  if (start > sliderMax) fail(`The requested start is after the frozen timeline end (frame ${sliderMax})`)
  if (end < 0) fail('The requested end is before the incident timeline starts')
  if (end < start) fail(`The selected frame range is empty (${start} to ${end})`)

  const frames = []
  for (let frame = start; frame <= end; frame += config.frameStep) frames.push(frame)
  if (frames.at(-1) !== end) frames.push(end)
  return frames
}

function startEncoder(config, outputPath) {
  const arguments_ = [
    '-hide_banner',
    '-loglevel', 'warning',
    config.overwrite ? '-y' : '-n',
    '-f', 'image2pipe',
    '-framerate', String(config.fps),
    '-vcodec', 'png',
    '-i', 'pipe:0',
    '-an',
    '-c:v', config.codec,
    '-preset', config.preset,
    '-crf', String(config.crf),
    '-vf', 'format=yuv420p',
    '-movflags', '+faststart',
    '-metadata', 'title=Venn Fire Watch full incident timeline',
    outputPath,
  ]
  const child = spawn(config.ffmpegPath, arguments_, { stdio: ['pipe', 'ignore', 'pipe'] })
  // A late FFmpeg exit can emit EPIPE after a successful write returned. The
  // per-write listener below reports synchronous failures; this listener keeps
  // a later stream error from becoming an uncaught process exception.
  child.stdin.on('error', () => {})
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-30_000)
  })
  const completed = new Promise((resolveCompleted, rejectCompleted) => {
    child.once('error', rejectCompleted)
    child.once('close', (code, signal) => {
      if (code === 0) resolveCompleted()
      else rejectCompleted(new Error(`FFmpeg exited with ${signal ? `signal ${signal}` : `code ${code}`}\n${stderr.trim()}`))
    })
  })
  // Mark the rejection as handled immediately; the same promise is awaited once
  // all input has been written or when a pipe write fails.
  completed.catch(() => {})
  return { child, completed }
}

async function writeEncoderFrame(encoder, png) {
  if (encoder.child.exitCode != null) return encoder.completed
  await new Promise((resolveWrite, rejectWrite) => {
    const onError = (error) => {
      encoder.child.stdin.off('drain', onDrain)
      rejectWrite(error)
    }
    const onDrain = () => {
      encoder.child.stdin.off('error', onError)
      resolveWrite()
    }
    encoder.child.stdin.once('error', onError)
    if (encoder.child.stdin.write(png)) {
      encoder.child.stdin.off('error', onError)
      resolveWrite()
    } else {
      encoder.child.stdin.once('drain', onDrain)
    }
  })
}

async function writeRepeatedFrames(encoder, png, count) {
  for (let index = 0; index < count; index += 1) await writeEncoderFrame(encoder, png)
}

async function deploymentMetadata(context, viewerUrl) {
  try {
    const response = await context.request.get(new URL('/api/deployment', viewerUrl).href, { timeout: 15_000 })
    if (!response.ok()) return { available: false, status: response.status() }
    return await response.json()
  } catch (error) {
    return { available: false, error: error.message }
  }
}

async function main() {
  // pnpm may preserve its conventional standalone `--` argument.
  const parsed = await configurationFromArguments(process.argv.slice(2).filter((argument) => argument !== '--'))
  if (parsed.help) {
    console.log(HELP)
    return
  }
  const config = parsed.config
  const outputPath = resolve(process.cwd(), config.output)
  const previewPath = config.previewOutput ? resolve(process.cwd(), config.previewOutput) : null
  const generatedPath = previewPath ?? outputPath
  const metadataPath = resolve(process.cwd(), config.metadataOutput ?? `${config.output}.json`)
  if (!config.overwrite && (await pathExists(generatedPath) || (!previewPath && await pathExists(metadataPath)))) {
    fail(`Output already exists. Choose another path or pass --overwrite: ${generatedPath}`)
  }
  await mkdir(dirname(generatedPath), { recursive: true })
  if (!previewPath) await mkdir(dirname(metadataPath), { recursive: true })

  let browser
  let encoder
  let renderSucceeded = false
  const startedAt = new Date().toISOString()
  const apiPayloads = new Map()
  const frozenResponses = new Map()
  const pageErrors = []

  try {
    console.log(`Opening ${config.url}`)
    browser = await chromium.launch({ headless: config.headless })
    const context = await browser.newContext({
      viewport: { width: config.width, height: config.height },
      deviceScaleFactor: 1,
      serviceWorkers: 'block',
      colorScheme: 'light',
      reducedMotion: 'reduce',
    })

    await context.route('**/api/data**', async (route) => {
      const requestUrl = route.request().url()
      if (config.freezeData && frozenResponses.has(requestUrl)) {
        const cached = frozenResponses.get(requestUrl)
        await route.fulfill(cached)
        return
      }
      const response = await route.fetch()
      const body = await response.body()
      const fulfilled = {
        status: response.status(),
        headers: sanitizeResponseHeaders(response.headers()),
        body,
      }
      if (config.freezeData) frozenResponses.set(requestUrl, fulfilled)
      try {
        const scope = new URL(requestUrl).searchParams.get('scope') ?? 'all'
        apiPayloads.set(scope, JSON.parse(body.toString('utf8')))
      } catch {
        // The app will surface malformed JSON; this capture is metadata-only.
      }
      await route.fulfill(fulfilled)
    })

    const page = await context.newPage()
    page.on('pageerror', (error) => pageErrors.push(error.message))
    page.setDefaultTimeout(config.pageTimeoutMs)
    await page.goto(presentationUrl(config), { waitUntil: 'domcontentloaded', timeout: config.pageTimeoutMs })
    await page.waitForSelector('.timeline-range')
    await page.waitForSelector('.app-shell:not(.app-shell--hydrating)')
    await page.evaluate(() => document.fonts?.ready)

    if (config.waitForAircraft) {
      await page.waitForFunction(() => {
        const row = [...document.querySelectorAll('.source-health-row')].find((element) => (
          element.querySelector('strong')?.textContent?.trim() === 'Aircraft'
        ))
        return row && !/Loading retained aircraft history/i.test(row.textContent)
      }, null, { timeout: config.pageTimeoutMs })
      const aircraftStatus = await page.locator('.source-health-row').filter({ hasText: 'Aircraft' }).innerText()
      if (/temporarily unavailable/i.test(aircraftStatus)) fail(`Aircraft history did not load: ${aircraftStatus.replace(/\s+/g, ' ')}`)
    }

    await page.addStyleTag({ content: `
      *, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }
      html, body, button, input, a { cursor: none !important; }
    ` })
    await applyViewerConfiguration(page, config)
    await applyPresentation(page, config)

    const coreResponse = apiPayloads.get('core') ?? apiPayloads.get('all')
    const incident = datasetPayload(coreResponse, 'incident-config')
    const timelineStartMs = Number(incident?.timelineStartMs)
    if (!Number.isFinite(timelineStartMs)) fail('Could not read the incident timeline start from the frozen core response')
    const sliderMax = finiteNumber(await page.locator('.timeline-range').getAttribute('max'), 'timeline slider max', { integer: true, min: 0 })
    const frames = selectedTimelineFrames(config, timelineStartMs, sliderMax)
    const firstFrame = frames[0]
    const lastFrame = frames.at(-1)
    const introFrames = Math.round(config.introSeconds * config.fps)
    const outroFrames = Math.round(config.outroSeconds * config.fps)
    const encodedFrameCount = introFrames + (frames.length * config.holdFrames) + outroFrames
    const deployment = await deploymentMetadata(context, config.url)

    console.log(`Frozen at ${coreResponse?.generatedAt ?? 'unknown'}; ${sliderMax + 1} source frames available`)
    if (previewPath) {
      console.log(`Capturing preview at ${formatTimestamp(timelineStartMs + lastFrame * FIVE_MINUTES_MS)} -> ${previewPath}`)
      await selectTimelineFrame(page, lastFrame, config)
      await page.screenshot({ path: previewPath, type: 'png', animations: 'disabled', fullPage: false })
      if (pageErrors.length) fail(`The page raised ${pageErrors.length} error(s): ${pageErrors.join(' | ')}`)
      renderSucceeded = true
      console.log(`Preview complete: ${previewPath}`)
      return
    }
    console.log(`Rendering ${frames.length} screenshots (${formatTimestamp(timelineStartMs + firstFrame * FIVE_MINUTES_MS)} to ${formatTimestamp(timelineStartMs + lastFrame * FIVE_MINUTES_MS)})`)
    console.log(`Encoding ${encodedFrameCount} frames at ${config.width}x${config.height} / ${config.fps} fps -> ${outputPath}`)

    encoder = startEncoder(config, outputPath)
    let firstPng = null
    let lastPng = null
    let lastProgressAt = 0
    for (let offset = 0; offset < frames.length; offset += 1) {
      const frameIndex = frames[offset]
      await selectTimelineFrame(page, frameIndex, config)
      const png = await page.screenshot({ type: 'png', animations: 'disabled', fullPage: false })
      if (!firstPng) {
        firstPng = png
        await writeRepeatedFrames(encoder, png, introFrames)
      }
      lastPng = png
      await writeRepeatedFrames(encoder, png, config.holdFrames)

      const now = Date.now()
      if (offset === frames.length - 1 || offset === 0 || now - lastProgressAt >= 10_000) {
        const percent = (((offset + 1) / frames.length) * 100).toFixed(1)
        console.log(`Captured ${offset + 1}/${frames.length} screenshots (${percent}%) · timeline frame ${frameIndex}`)
        lastProgressAt = now
      }
    }
    await writeRepeatedFrames(encoder, lastPng, outroFrames)
    encoder.child.stdin.end()
    await encoder.completed

    if (pageErrors.length) fail(`The page raised ${pageErrors.length} error(s): ${pageErrors.join(' | ')}`)

    const metadata = {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      renderer: 'scripts/render-timeline-video.mjs',
      viewer: {
        url: config.url,
        deployment,
        frozenData: config.freezeData,
        coreResponseGeneratedAt: coreResponse?.generatedAt ?? null,
        aircraftResponseGeneratedAt: apiPayloads.get('aircraft')?.generatedAt ?? null,
      },
      timeline: {
        granularityMinutes: 5,
        availableFrameCount: sliderMax + 1,
        capturedScreenshotCount: frames.length,
        firstFrame,
        lastFrame,
        frameStep: config.frameStep,
        firstTimestamp: formatTimestamp(timelineStartMs + firstFrame * FIVE_MINUTES_MS),
        lastTimestamp: formatTimestamp(timelineStartMs + lastFrame * FIVE_MINUTES_MS),
      },
      video: {
        output: outputPath,
        width: config.width,
        height: config.height,
        fps: config.fps,
        encodedFrameCount,
        durationSeconds: encodedFrameCount / config.fps,
        holdFrames: config.holdFrames,
        introSeconds: config.introSeconds,
        outroSeconds: config.outroSeconds,
        codec: config.codec,
        preset: config.preset,
        crf: config.crf,
      },
      viewerConfiguration: {
        baseMap: config.baseMap ?? 'website default',
        presentation: config.presentation,
        language: config.language,
        mapFocus: config.mapFocus === 'default' && config.presentation === 'news' ? 'fire-and-water-sources' : config.mapFocus,
        mapZoomSteps: config.mapZoomSteps ?? 0,
        newsWindSummary: 'Speed-weighted vector mean of the two nearest currently available station observations; model-grid wind excluded',
        layerOverrides: config.layers,
        waitForAircraft: config.waitForAircraft,
        waitForAssets: config.waitForAssets,
        settleMs: config.settleMs,
        assetTimeoutMs: config.assetTimeoutMs,
      },
      process: { startedAt, completedAt: new Date().toISOString() },
    }
    await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`)
    renderSucceeded = true
    console.log(`Video complete: ${outputPath}`)
    console.log(`Render metadata: ${metadataPath}`)
  } finally {
    if (encoder?.child && encoder.child.exitCode == null) encoder.child.kill('SIGKILL')
    if (browser) await browser.close().catch(() => {})
    if (!renderSucceeded && await pathExists(generatedPath)) await unlink(generatedPath).catch(() => {})
  }
}

main().catch((error) => {
  console.error(`Timeline render failed: ${error.stack || error.message}`)
  process.exitCode = 1
})
