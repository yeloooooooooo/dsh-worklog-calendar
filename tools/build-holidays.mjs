// Build the bundled holiday table from the holiday-cn dataset.
//
// Source: https://github.com/NateScarlet/holiday-cn — a machine-readable copy
// of the State Council's annual 放假安排 notices. The generator records the
// source paper for each year so the bundled data stays auditable, and it is
// run only when a new year is published; the plugin then refreshes from the
// same upstream at runtime if a year is missing.
//
// Usage: node .tools/build-holidays.mjs 2025 2026 2027
import fs from 'node:fs/promises'

const years = process.argv.slice(2).filter((arg) => /^\d{4}$/.test(arg))
if (!years.length) {
  console.error('usage: node .tools/build-holidays.mjs 2025 2026 ...')
  process.exit(1)
}

const out = { source: 'https://github.com/NateScarlet/holiday-cn', builtAt: new Date().toISOString(), years: {} }

for (const year of years) {
  const url = `https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/${year}.json`
  const response = await fetch(url)
  if (!response.ok) {
    console.error(`skip ${year}: HTTP ${response.status}`)
    continue
  }
  const data = await response.json()
  // Only the facts the plugin needs: which days are off, which weekend days
  // are worked, and the festival name for display.
  out.years[year] = {
    paper: (data.papers || [])[0] || null,
    days: data.days.map((day) => ({
      date: day.date,
      name: day.name,
      off: Boolean(day.isOffDay),
    })),
  }
  console.error(`fetched ${year}: ${data.days.length} days`)
}

const target = new URL('../holidays.json', import.meta.url)
await fs.writeFile(target, JSON.stringify(out, null, 2) + '\n', 'utf8')
console.error(`wrote ${target.pathname}`)
