// Dependency audit with transitive analysis.
//
// Scanning for identifiers is not enough: the Gantt group filter broke because
// `sorted` called `matchesFilter` (a useCallback that reads groupFilter) without
// listing it. That is only visible if memoized values are followed transitively:
// a closure that calls another memoized closure inherits its reactive deps.
import fs from 'node:fs/promises'

const source = await fs.readFile(new URL('../client.js', import.meta.url), 'utf8')

const TRACKED = [
  'groupFilter', 'query', 'hideDone', 'picked', 'editing', 'selected', 'view', 'anchor',
  'logDay', 'logText', 'logMinutes', 'logTask', 'drag', 'pickedIds', 'groupBusy', 'bulkConfirm',
  'tasks', 'records', 'settings', 'dayWidth', 'data', 'today', 'collapsed', 'closed', 'pos',
  'iconPos', 'toasts', 'text', 'newTaskText', 'permission', 'advanced', 'confirmDelete',
]

function balanced(text, start) {
  let depth = 0
  let quote = null
  let esc = false
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (esc) { esc = false; continue }
    if (ch === '\\') { esc = true; continue }
    if (quote) { if (ch === quote) quote = null; continue }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue }
    if (ch === '(') depth += 1
    if (ch === ')') {
      depth -= 1
      if (depth === 0) return { text: text.slice(start, i + 1), end: i }
    }
  }
  return null
}

/** Split a deps array into identifier names, keeping the root of chains. */
const depNames = (text) => text
  .split(',')
  .map((part) => part.trim().replace(/\?/g, '').split(/[.:[(\s]/)[0])
  .filter(Boolean)

/** Does the deps list cover `name`? `data?.x` reads the `data` binding. */
const covers = (deps, name) => deps.some((dep) => dep === name)

/**
 * Is `name` only read as a property of a dep that IS listed?
 * `data?.records` inside a memo whose deps include `data` is safe.
 */
const coveredByProperty = (closure, deps, name) =>
  deps.some((dep) => {
    const pattern = new RegExp(`\\b${dep}\\s*\\??\\.\\s*${name}\\b`)
    return pattern.test(closure)
  })

/** Collect the memoized definitions: name, deps, body text, line. */
const definitions = []
for (const hook of ['useMemo', 'useCallback']) {
  const re = new RegExp(`(?:const|let)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${hook}\\(`, 'g')
  let match
  while ((match = re.exec(source)) !== null) {
    const name = match[1]
    const open = match.index + match[0].length - 1
    const found = balanced(source, open)
    if (!found) continue
    const body = found.text
    const close = body.lastIndexOf(']')
    const depOpen = body.lastIndexOf('[', close)
    if (close === -1 || depOpen === -1) continue
    definitions.push({
      name,
      line: source.slice(0, match.index).split('\n').length,
      closure: body.slice(0, depOpen),
      deps: depNames(body.slice(depOpen + 1, close)),
    })
  }
}
const byName = new Map(definitions.map((def) => [def.name, def]))

/** Reactive names a definition depends on, following called memoized values. */
function reactiveDeps(def, seen = new Set()) {
  if (seen.has(def.name)) return new Set()
  seen.add(def.name)
  const found = new Set()
  for (const name of TRACKED) {
    if (new RegExp(`\\b${name}\\b`).test(def.closure)) {
      if (!new RegExp(`(?:const|let|var)\\s+${name}\\b`).test(def.closure)) found.add(name)
    }
  }
  for (const other of definitions) {
    if (other.name === def.name) continue
    if (!new RegExp(`\\b${other.name}\\s*\\(`).test(def.closure)) continue
    // It calls this memoized value: it must either list it, or cover its deps.
    if (covers(def.deps, other.name)) continue
    for (const inherited of reactiveDeps(other, seen)) found.add(inherited)
  }
  return found
}

const problems = []
for (const def of definitions) {
  const needed = reactiveDeps(def)
  const missing = [...needed].filter((name) =>
    !covers(def.deps, name) && !coveredByProperty(def.closure, def.deps, name),
  )
  if (missing.length) problems.push({ ...def, missing })
}

if (problems.length) {
  for (const item of problems) {
    console.error(`line ${item.line}: ${item.name} reads [${item.missing.join(', ')}] but deps are [${item.deps.join(', ')}]`)
  }
  console.error(`\n${problems.length} stale-closure risk(s)`)
  process.exit(1)
}
console.log(`dependency audit passed (${definitions.length} memoized closures)`)
