#!/usr/bin/env node

// Keeps every non-live data source refreshed.
//
// The two serverless routes (live-situation, firms-situation) already refresh on
// request. Everything else is imported once and then frozen, which is fine for a
// closed incident and wrong for an ongoing one. This daemon re-runs each importer
// on its own schedule.
//
// Intervals are matched to how fast each source actually changes, not to how
// often we would like fresh data. Polling a twice-daily product every five
// minutes produces hundreds of identical responses, wastes the provider's
// bandwidth and, for FIRMS, risks having the key throttled. The tick is short so
// that fast sources are timely; slow sources simply are not due on most ticks.

import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

const SOURCES = [
  {
    key: 'rmi',
    label: 'RMI Mont Rigi observations',
    // The station itself reports every ten minutes; polling faster cannot
    // produce a new record.
    intervalMs: 10 * MINUTE,
    reason: 'Station publishes every 10 minutes',
    command: ['scripts/import-rmi-observations.mjs', '--start', '2026-08-14T11:00:00Z'],
    snapshotArgs: ['--write-snapshot'],
    verify: 'scripts/verify-rmi-snapshot.mjs',
  },
  {
    key: 'firms',
    label: 'NASA FIRMS detections',
    // Roughly 6-10 overpasses a day with about 3 hours of latency. Thirty
    // minutes is already far faster than the data can change.
    intervalMs: 30 * MINUTE,
    reason: '~8 overpasses/day, ~3 h latency',
    command: [
      'scripts/import-firms-detections.mjs',
      '--date', '2026-08-14', '--dayRange', '3',
      '--bbox', '5.85,50.42,6.30,50.70',
    ],
    snapshotArgs: ['--write-snapshot'],
    verify: 'scripts/verify-firms-snapshot.mjs',
    requiresEnv: 'FIRMS_MAP_KEY',
  },
  {
    key: 'effis',
    label: 'Copernicus EFFIS burned area',
    intervalMs: 6 * HOUR,
    reason: 'EFFIS rapid damage assessment updates twice daily',
    command: ['scripts/import-effis-burned-area.mjs'],
  },
  {
    key: 'ems',
    label: 'Copernicus EMS activations',
    intervalMs: HOUR,
    reason: 'Activations are irregular; hourly is responsive enough',
    command: ['scripts/import-ems-activations.mjs'],
  },
  {
    key: 'sentinel2',
    label: 'Sentinel-2 post-fire scene',
    intervalMs: HOUR,
    reason: 'Revisit over this point is 2-5 days',
    command: ['scripts/check-sentinel2.mjs'],
  },
]

// Deliberately excluded: the ADS-B replay scan downloads roughly 350 MB of
// heatmap tiles per run and rebuilds a historical record that does not change
// once a day is complete. Live aircraft are served by the live-situation route.
// Run `pnpm scan:aircraft` by hand when a new day needs importing.

const DEFAULTS = {
  tickSeconds: 60,
  statusPath: '.local-data/refresh-status.json',
  only: '',
}

function parseArgs(argv) {
  const options = { ...DEFAULTS, writeSnapshots: true, once: false }
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--') continue
    if (token === '--once') { options.once = true; continue }
    if (token === '--no-write-snapshots') { options.writeSnapshots = false; continue }
    const key = token.replace(/^--/, '')
    const value = argv[index + 1]
    if (!(key in options) || value == null) throw new Error(`Unknown or incomplete argument: ${token}`)
    options[key] = key === 'tickSeconds' ? Number(value) : value
    index += 1
  }
  return options
}

function log(message) {
  process.stdout.write(`${new Date().toISOString()}  ${message}\n`)
}

function run(command, timeoutMs = 10 * MINUTE) {
  return new Promise((resolve) => {
    const child = spawn('node', command, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() })
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: String(error.message ?? error) })
    })
  })
}

const state = new Map()

async function refresh(source, options) {
  const entry = state.get(source.key)

  if (source.requiresEnv && !process.env[source.requiresEnv]) {
    entry.status = 'skipped'
    entry.detail = `${source.requiresEnv} is not set`
    entry.nextDueAt = Date.now() + source.intervalMs
    return
  }

  const command = [...source.command]
  if (options.writeSnapshots && source.snapshotArgs) command.push(...source.snapshotArgs)

  const startedAt = Date.now()
  const result = await run(command)
  const durationMs = Date.now() - startedAt

  if (result.code !== 0) {
    entry.consecutiveFailures += 1
    entry.status = 'failed'
    entry.detail = (result.stderr || result.stdout || `exit ${result.code}`).split('\n').slice(-2).join(' ')
    entry.lastFailureAt = new Date().toISOString()
    // Back off on repeated failure so a broken or rate-limited source is not
    // hammered, but never past one hour.
    const backoff = Math.min(source.intervalMs * 2 ** entry.consecutiveFailures, HOUR)
    entry.nextDueAt = Date.now() + backoff
    log(`FAIL  ${source.label}: ${entry.detail} (retry in ${Math.round(backoff / MINUTE)} min)`)
    return
  }

  entry.consecutiveFailures = 0
  entry.status = 'ok'
  entry.lastSuccessAt = new Date().toISOString()
  entry.durationMs = durationMs
  entry.detail = result.stdout.split('\n').filter(Boolean).slice(-1)[0] ?? ''
  entry.nextDueAt = Date.now() + source.intervalMs

  // A snapshot that fails its own verifier must be reported loudly: it means the
  // bundled data no longer matches the retained source responses.
  if (options.writeSnapshots && source.verify) {
    const verification = await run([source.verify])
    entry.verified = verification.code === 0
    if (verification.code !== 0) {
      entry.status = 'verify-failed'
      entry.detail = (verification.stderr || verification.stdout).split('\n').slice(-1)[0]
      log(`VERIFY FAILED  ${source.label}: ${entry.detail}`)
      return
    }
  }

  log(`ok    ${source.label} (${(durationMs / 1000).toFixed(1)}s) ${entry.detail}`)
}

async function writeStatus(options) {
  const statusPath = path.resolve(options.statusPath)
  await mkdir(path.dirname(statusPath), { recursive: true })
  await writeFile(statusPath, `${JSON.stringify({
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    tickSeconds: options.tickSeconds,
    writeSnapshots: options.writeSnapshots,
    sources: SOURCES.map((source) => ({
      key: source.key,
      label: source.label,
      intervalMinutes: source.intervalMs / MINUTE,
      intervalReason: source.reason,
      ...state.get(source.key),
      nextDueAt: new Date(state.get(source.key).nextDueAt).toISOString(),
    })),
  }, null, 2)}\n`, 'utf8')
}

async function main() {
  const options = parseArgs(process.argv)
  const selected = options.only
    ? SOURCES.filter((source) => options.only.split(',').includes(source.key))
    : SOURCES
  if (!selected.length) throw new Error(`No sources matched --only ${options.only}`)

  for (const source of selected) {
    state.set(source.key, {
      status: 'pending',
      detail: '',
      consecutiveFailures: 0,
      lastSuccessAt: null,
      lastFailureAt: null,
      durationMs: null,
      verified: null,
      nextDueAt: 0,
    })
  }

  log(`Refresh daemon starting · tick ${options.tickSeconds}s · snapshots ${options.writeSnapshots ? 'on' : 'off'}`)
  for (const source of selected) {
    log(`  ${source.key.padEnd(10)} every ${String(source.intervalMs / MINUTE).padStart(4)} min — ${source.reason}`)
  }

  let stopping = false
  // The tick sleep must be interruptible. A plain setTimeout would keep the
  // process alive for up to a full tick after SIGTERM, past the grace period a
  // container runtime allows, and the daemon would be killed instead of exiting.
  let wakeFromSleep = null
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      if (stopping) process.exit(1)
      stopping = true
      log(`${signal} received, finishing current tick then exiting`)
      if (wakeFromSleep) wakeFromSleep()
    })
  }

  function sleep(milliseconds) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { wakeFromSleep = null; resolve() }, milliseconds)
      wakeFromSleep = () => { clearTimeout(timer); wakeFromSleep = null; resolve() }
    })
  }

  do {
    const due = selected.filter((source) => Date.now() >= state.get(source.key).nextDueAt)
    // Sequential rather than concurrent: these are independent providers and
    // there is no deadline that justifies bursting requests at all of them.
    for (const source of due) {
      if (stopping) break
      await refresh(source, options)
    }
    if (due.length) await writeStatus(options)
    if (options.once || stopping) break
    await sleep(options.tickSeconds * 1000)
  } while (!stopping)

  await writeStatus(options)
  log('Refresh daemon stopped')
}

main().catch((error) => {
  console.error(error.message ?? error)
  process.exitCode = 1
})
