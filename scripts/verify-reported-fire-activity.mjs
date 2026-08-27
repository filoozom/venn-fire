import assert from 'node:assert/strict'

import {
  REPORTED_FIRE_ACTIVITY_LIFETIME_MS,
  latestReportedFireActivity,
} from '../src/reportedFireActivity.js'

const reportAt = Date.parse('2026-08-27T16:12:00.000Z')
const report = {
  id: 'vedia:restart',
  timestampMs: reportAt,
  title: 'Hautes Fagnes : une reprise de feu mobilise les pompiers',
  detail: 'Une reprise de feu plus importante s’est déclarée dans le secteur nord-est. Elle est désormais contrôlée, mais les opérations de noyage se poursuivent.',
  sourceName: 'Vedia (local reporting)',
  sourceUrl: 'https://example.test/restart',
}

const current = latestReportedFireActivity([report], reportAt + 5 * 60 * 60 * 1000)
assert.equal(current?.headline, 'Re-ignition reported in the north-east sector')
assert.equal(current?.status, 'Reported controlled; damping-down operations continue.')
assert.equal(current?.controlled, true)

assert.equal(latestReportedFireActivity([report], reportAt - 1), null)
assert.equal(latestReportedFireActivity(
  [report],
  reportAt + REPORTED_FIRE_ACTIVITY_LIFETIME_MS,
), null)
assert.equal(latestReportedFireActivity([{
  ...report,
  title: 'N68 remains closed',
  detail: 'Traffic restrictions continue.',
}], reportAt + 1), null)

console.log(JSON.stringify({
  headline: current.headline,
  status: current.status,
  lifetimeHours: REPORTED_FIRE_ACTIVITY_LIFETIME_MS / 3_600_000,
}, null, 2))
