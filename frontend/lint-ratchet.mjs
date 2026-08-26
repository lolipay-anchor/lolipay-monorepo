import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const baseline = JSON.parse(readFileSync(new URL('./lint-baseline.json', import.meta.url), 'utf8'))
const apps = Object.keys(baseline).sort()

let worse = false
let better = false

for (const app of apps) {
  let messages = 0
  try {
    const out = execFileSync('npx', ['eslint', '.', '-f', 'json'], {
      cwd: new URL(`./apps/${app}/`, import.meta.url),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    messages = JSON.parse(out).reduce((n, f) => n + f.messages.length, 0)
  } catch (err) {
    if (typeof err.stdout !== 'string' || err.stdout.length === 0) {
      console.error(`${app}: eslint could not run — ${err.message.split('\n')[0]}`)
      process.exitCode = 1
      continue
    }
    messages = JSON.parse(err.stdout).reduce((n, f) => n + f.messages.length, 0)
  }

  const allowed = baseline[app]
  if (messages > allowed) {
    console.error(`${app}: ${messages} findings, up from ${allowed} — this change adds lint debt`)
    worse = true
  } else if (messages < allowed) {
    console.log(`${app}: ${messages} findings, down from ${allowed} — lower the baseline`)
    better = true
  } else {
    console.log(`${app}: ${messages} findings, unchanged`)
  }
}

if (worse) {
  console.error('\nThe baseline is a ceiling, not a target. Fix what you added, or fix something older.')
  process.exit(1)
}
if (better) console.log('\nFewer findings than the baseline. Update lint-baseline.json so the gain is kept.')
