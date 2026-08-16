import pg from 'pg'
import { attachDatabasePool } from '@vercel/functions'

const { Pool } = pg

const pools = new Map()
const queries = new Map()

const SELF_HOSTED_DEFAULTS = Object.freeze({
  port: 41_637,
  user: 'venn-fire',
  database: 'venn-fire',
  servername: 'venn-fire-postgres',
})

function positiveInteger(value, fallback, maximum) {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback
  return Math.min(parsed, maximum)
}

export function postgresUrl(environment = process.env) {
  const environmentKey = postgresEnvironmentKey(environment)
  if (environmentKey) return environmentKey
  return environment.DATABASE_URL?.trim()
    || environment.POSTGRES_URL?.trim()
    || ''
}

function requiredEnvironmentValue(environment, key) {
  const value = environment[key]?.trim()
  if (!value) throw new Error(`${key} is required when PG_CA_PEM is configured`)
  return value
}

function selfHostedValues(environment = process.env) {
  if (!environment.PG_CA_PEM?.trim()) return null
  return {
    host: requiredEnvironmentValue(environment, 'PGHOST'),
    port: positiveInteger(environment.PGPORT, SELF_HOSTED_DEFAULTS.port, 65_535),
    user: environment.PGUSER?.trim() || SELF_HOSTED_DEFAULTS.user,
    password: requiredEnvironmentValue(environment, 'PGPASSWORD'),
    database: environment.PGDATABASE?.trim() || SELF_HOSTED_DEFAULTS.database,
    ca: environment.PG_CA_PEM.replace(/\\n/g, '\n').trim(),
    servername: environment.PGSSL_SERVERNAME?.trim() || SELF_HOSTED_DEFAULTS.servername,
  }
}

export function postgresEnvironmentKey(environment = process.env) {
  const values = selfHostedValues(environment)
  if (!values) return ''
  const user = encodeURIComponent(values.user)
  const host = encodeURIComponent(values.host)
  const database = encodeURIComponent(values.database)
  const servername = encodeURIComponent(values.servername)
  return `pg-env://${user}@${host}:${values.port}/${database}?servername=${servername}`
}

export function postgresPoolOptions(url, environment = process.env) {
  if (!url) throw new Error('PostgreSQL connection configuration is required')
  const selfHosted = selfHostedValues(environment)
  const usesSelfHostedEnvironment = selfHosted && url === postgresEnvironmentKey(environment)
  const connection = usesSelfHostedEnvironment
    ? {
        host: selfHosted.host,
        port: selfHosted.port,
        user: selfHosted.user,
        password: selfHosted.password,
        database: selfHosted.database,
        ssl: {
          ca: selfHosted.ca,
          servername: selfHosted.servername,
          rejectUnauthorized: true,
        },
        enableChannelBinding: true,
      }
    : { connectionString: url }
  return {
    ...connection,
    // Vercel can create many warm function instances. Keep each instance small;
    // a PgBouncer endpoint in front of a self-hosted server is still strongly
    // recommended for production traffic.
    max: positiveInteger(environment.DATABASE_POOL_MAX, 5, 20),
    connectionTimeoutMillis: positiveInteger(environment.DATABASE_CONNECT_TIMEOUT_MS, 8_000, 60_000),
    idleTimeoutMillis: positiveInteger(environment.DATABASE_IDLE_TIMEOUT_MS, 5_000, 300_000),
    maxLifetimeSeconds: positiveInteger(environment.DATABASE_MAX_LIFETIME_SECONDS, 300, 3_600),
    allowExitOnIdle: true,
    application_name: environment.DATABASE_APPLICATION_NAME?.trim() || 'venn-fire-vercel',
  }
}

export function postgresPool(url = postgresUrl(), environment = process.env) {
  if (!url) throw new Error('PostgreSQL connection configuration is required')
  if (!pools.has(url)) {
    const pool = new Pool(postgresPoolOptions(url, environment))
    pool.on('error', (error) => {
      console.error('Unexpected PostgreSQL pool error:', error?.message || error)
    })
    if (environment.VERCEL === '1') attachDatabasePool(pool)
    pools.set(url, pool)
  }
  return pools.get(url)
}

// Keep the rows-only contract used throughout the application. Both the old
// Neon HTTP driver and the test fakes returned arrays directly; adapting pg here
// avoids coupling every ingest module to a particular database driver.
export function postgresQuery(url = postgresUrl(), environment = process.env) {
  if (!url) throw new Error('PostgreSQL connection configuration is required')
  if (!queries.has(url)) {
    const pool = postgresPool(url, environment)
    queries.set(url, async (text, parameters = []) => {
      const result = await pool.query(text, parameters)
      return result.rows
    })
  }
  return queries.get(url)
}

export async function closePostgresPools() {
  const activePools = [...pools.values()]
  pools.clear()
  queries.clear()
  await Promise.allSettled(activePools.map((pool) => pool.end()))
}
