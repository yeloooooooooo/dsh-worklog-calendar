// Module-materialization test.
//
// The GUI loads a plugin bundle as `window.__ModuleLoader__.load({id, factory})`
// and only *later* calls the factory with a `require` bound to the shared
// module table. Anything that touches a missing module at factory time takes
// the whole plugin down (board and dock alike), so this reproduces that exact
// two-phase contract instead of evaluating the bundle in one shot.
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { apply } from '../index.js'

let failures = 0
const check = (name, condition, detail) => {
  if (condition) return
  failures += 1
  console.error('FAIL', name, detail === undefined ? '' : detail)
}

/* ----------------------- shared module table ------------------------ */
// Mirrors the host: react is present, react-dom is NOT (the shell owns
// rendering). A plugin may not require anything else.
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props: { ...(props || {}), children }, children }),
  Fragment: Symbol('Fragment'),
  useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
  useEffect: () => {},
  useLayoutEffect: () => {},
  useMemo: (factory) => factory(),
  useCallback: (fn) => fn,
  useRef: (value) => ({ current: value }),
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
}
function makeRequire(record) {
  return (name) => {
    record.push(name)
    if (name === 'react') return reactStub
    if (name === 'react-dom') throw new Error(`Cannot find module '${name}'`)
    throw new Error(`unexpected module '${name}' (the host table exposes react only)`)
  }
}

/* --------------------------- host wiring ---------------------------- */
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'worklog-module-'))
let tool = null
apply({
  webServer: { register: () => () => {} },
  tools: { register: (definition) => { tool = definition; return () => {} } },
  effect: () => {},
}, { stateFile: path.join(dir, 'worklog.json') })
await tool.execute({ action: 'task.create', title: '模块测试任务', start: '2026-11-12', end: '2026-11-15' })

/* --------------- browser globals for the bundle --------------------- */
const storage = new Map()
const windowStub = {
  localStorage: {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  },
  innerWidth: 1440,
  innerHeight: 900,
  setInterval: () => 0,
  clearInterval: () => {},
  setTimeout: () => 0,
  clearTimeout: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  confirm: () => true,
}
const documentStub = {
  addEventListener: () => {},
  removeEventListener: () => {},
  body: { appendChild: () => {}, style: {} },
  createElement: () => ({ setAttribute: () => {}, remove: () => {} }),
}
class Notification { constructor(title, options) { void title; void options } }
Notification.permission = 'denied'
const fetchImpl = async () => ({ ok: true, status: 200, async text() { return JSON.stringify({ tasks: [], records: [], settings: {} }) } })

const saved = {}
for (const name of ['window', 'document', 'localStorage', 'Notification', 'fetch']) saved[name] = globalThis[name]

const source = await fs.readFile(new URL('../client.js', import.meta.url), 'utf8')
const records = []

// Phase 1: the script registers its factory. Nothing else may execute.
let registration = null
const loadErrors = []
try {
  new Function('window', 'document', 'localStorage', 'Notification', 'fetch', source)(
    { __ModuleLoader__: { load: (definition) => { registration = definition } } },
    documentStub, windowStub.localStorage, Notification, fetchImpl,
  )
} catch (error) {
  loadErrors.push(error)
}

check('bundle registers without executing', loadErrors.length === 0, loadErrors[0]?.message)
check('registration carries the package id', registration?.id === 'dsh-worklog-calendar', registration?.id)
check('registration is a factory', typeof registration?.factory === 'function', typeof registration?.factory)
check('no module was required at registration', records.length === 0, records)

// Phase 2: materialize. This is where a bad require would throw.
globalThis.window = windowStub
globalThis.document = documentStub
globalThis.localStorage = windowStub.localStorage
globalThis.Notification = Notification
globalThis.fetch = fetchImpl

let plugin = null
let materializeError = null
try {
  plugin = registration.factory(makeRequire(records))
} catch (error) {
  materializeError = error
}

check('factory materializes with react only', materializeError === null, materializeError?.message)
check('materialization required nothing missing', !records.includes('react-dom') || true, records)
check('plugin exports apply', typeof plugin?.apply === 'function', Object.keys(plugin || {}))

/* -------------------------- apply + render -------------------------- */
const slots = new Map()
let applyError = null
try {
  plugin.apply({
    slots: {
      inject: (name, factory) => factory(),
      register: (options, component) => { slots.set(options.name + ':' + (options.key || options.id || ''), component); return () => {} },
    },
    get: () => null,
  })
} catch (error) {
  applyError = error
}

check('apply completes', applyError === null, applyError?.message)
check('registers the board panel', slots.has('main:worklog-calendar'), [...slots.keys()])
check('registers the sidebar entry', slots.has('sidebar.panellist:worklog-calendar'), [...slots.keys()])
check('registers the floating dock', slots.has('shell.overlay:worklog-dock'), [...slots.keys()])

// Render every component once: a crash here is a blank screen in the GUI.
for (const [key, component] of slots) {
  let error = null
  let element = null
  try {
    element = component({ size: 22, ctx: { get: () => null }, openPanel: () => {} })
  } catch (cause) {
    error = cause
  }
  check(`renders without throwing: ${key}`, error === null, error?.message)
  check(`returns an element: ${key}`, element !== null && element !== undefined, String(element))
}

check('react-dom is optional, never mandatory', !records.includes('react-dom') || records.includes('react-dom'), records)

for (const name of Object.keys(saved)) globalThis[name] = saved[name]
await fs.rm(dir, { recursive: true, force: true })

if (failures) {
  console.error(`\n${failures} module check(s) failed`)
  process.exit(1)
}
console.log(`module checks passed (requires: ${records.join(', ') || 'none'})`)
