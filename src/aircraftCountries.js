const AIRCRAFT_COUNTRIES = Object.freeze({
  BE: Object.freeze({ code: 'BE', name: 'Belgium' }),
  DE: Object.freeze({ code: 'DE', name: 'Germany' }),
  NL: Object.freeze({ code: 'NL', name: 'Netherlands' }),
  NO: Object.freeze({ code: 'NO', name: 'Norway' }),
  SE: Object.freeze({ code: 'SE', name: 'Sweden' }),
})

// ICAO allocates these Mode-S address blocks to the five countries whose
// aircraft supported the incident. Prefer the transponder allocation over a
// painted registration: Dutch military Chinooks use D-### serials that would
// otherwise look like German civil registrations.
const ICAO_COUNTRY_RANGES = Object.freeze([
  { start: 0x3c0000, end: 0x3fffff, code: 'DE' },
  { start: 0x448000, end: 0x44ffff, code: 'BE' },
  { start: 0x478000, end: 0x47ffff, code: 'NO' },
  { start: 0x480000, end: 0x487fff, code: 'NL' },
  { start: 0x4a8000, end: 0x4affff, code: 'SE' },
])

const REGISTRATION_COUNTRIES = Object.freeze([
  { pattern: /^OO-/iu, code: 'BE' },
  { pattern: /^PH-/iu, code: 'NL' },
  { pattern: /^LN-/iu, code: 'NO' },
  { pattern: /^SE-/iu, code: 'SE' },
  { pattern: /^D-/iu, code: 'DE' },
])

export function countryFlagEmoji(countryCode) {
  const code = String(countryCode ?? '').trim().toUpperCase()
  if (!/^[A-Z]{2}$/u.test(code)) return ''
  return [...code].map((character) => (
    String.fromCodePoint(0x1f1e6 + character.charCodeAt(0) - 65)
  )).join('')
}

export function aircraftCountry(aircraft = {}) {
  const explicitCode = String(
    aircraft.countryCode ?? aircraft.country?.code ?? '',
  ).trim().toUpperCase()
  if (AIRCRAFT_COUNTRIES[explicitCode]) return AIRCRAFT_COUNTRIES[explicitCode]

  const icao24 = String(aircraft.icao24 ?? aircraft.hex ?? '').trim().toLowerCase()
  if (/^[0-9a-f]{6}$/u.test(icao24)) {
    const address = Number.parseInt(icao24, 16)
    const range = ICAO_COUNTRY_RANGES.find(({ start, end }) => address >= start && address <= end)
    if (range) return AIRCRAFT_COUNTRIES[range.code]
  }

  // GRZLY is the incident callsign used by the Dutch CH-47 fleet. This also
  // keeps a useful flag when an imported observation is missing its Mode-S ID.
  if (/^GRZLY\d{1,3}$/iu.test(String(aircraft.callSign ?? aircraft.flight ?? '').trim())) {
    return AIRCRAFT_COUNTRIES.NL
  }

  const registration = String(aircraft.registration ?? aircraft.r ?? '').trim()
  const match = REGISTRATION_COUNTRIES.find(({ pattern }) => pattern.test(registration))
  return match ? AIRCRAFT_COUNTRIES[match.code] : null
}

export function aircraftCountryFields(aircraft = {}) {
  const country = aircraftCountry(aircraft)
  return country
    ? {
        countryCode: country.code,
        countryName: country.name,
        countryFlag: countryFlagEmoji(country.code),
      }
    : {}
}
