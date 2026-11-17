// Drag behaviour test for the floating dock.
//
// Renders the real dock component, then drives its pointerdown → pointermove →
// pointerup pipeline through the exact handlers React would call. A headless
// browser is not available in this sandbox, so this asserts the logic and the
// resulting style, not the painted pixels.
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { apply } from '../index.js'

/* --------------------------- minimal React --------------------------- */
const Fragment = Symbol('Fragment')
function createElement(type, props, ...children) {
  const flat = []
  const push = (child) => {
    if (child === null || child === undefined || child === false || child === true) return
    if (Array.isArray(child)) { child.forEach(push); return }
    flat.push(child)
  }
  children.forEach(push)
  return { type, props: { ...(props || {}), children: flat }, key: props?.key ?? null }
}
let currentInstance = null
const effectQueue = []
function hookSlot(initial) {
  const instance = currentInstance
  const index = instance.cursor++
  if (!(index in instance.slots)) instance.slots[index] = typeof initial === 'function' ? initial() : initial
  return index
}
function useState(initial) {
  const instance = currentInstance
  const index = hookSlot(initial)
  return [instance.slots[index], (next) => {
    instance.slots[index] = typeof next === 'function' ? next(instance.slots[index]) : next
    instance.dirty = true
  }]
}
function useEffect(effect, deps) {
  const instance = currentInstance
  const index = hookSlot(undefined)
  const previous = instance.effects[index]
  const same = previous && deps && previous.deps && deps.length === previous.deps.length
    && deps.every((item, i) => Object.is(item, previous.deps[i]))
  if (same) return
  instance.effects[index] = { deps }
  if (currentInstance === instance) effectQueue.push(effect)
}
function useLayoutEffect() {}
function useMemo(factory, deps) {
  const instance = currentInstance
  const index = hookSlot(undefined)
  const box = instance.memo[index]
  const same = box && deps && box.deps && deps.length === box.deps.length && deps.every((item, i) => Object.is(item, box.deps[i]))
  if (!same) instance.memo[index] = { deps, value: factory() }
  return instance.memo[index].value
}
function useCallback(fn, deps) { return useMemo(() => fn, deps) }
function useRef(value) {
  const index = hookSlot(undefined)
  if (!currentInstance.refs[index]) currentInstance.refs[index] = { current: value }
  return currentInstance.refs[index]
}
function useSyncExternalStore(subscribe, getSnapshot) { return getSnapshot() }
const React = { createElement, Fragment, useState, useEffect, useMemo, useCallback, useRef, useSyncExternalStore }

/* ---------------------------- instance tree --------------------------- */
// Unlike a plain tree dump, this keeps the owning instance so a re-render
// after a state update can be produced again with the same hooks.
function buildNode(node, owner) {
  if (node === null || node === undefined || node === false || node === true) return null
  if (typeof node === 'string' || typeof node === 'number') return { text: String(node), owner }
  if (Array.isArray(node)) return node.map((child) => buildNode(child, owner)).filter(Boolean)
  if (!node || typeof node !== 'object' || !('type' in node)) return null
  const { type } = node
  const props = node.props || {}
  if (type === Fragment) return (props.children || []).map((child) => buildNode(child, owner)).filter(Boolean)
  if (typeof type === 'function') {
    let instance = instanceByType.get(type)
    if (!instance) {
      instance = { cursor: 0, slots: {}, memo: {}, refs: {}, effects: {}, dirty: false, component: type }
      instanceByType.set(type, instance)
    }
    instance.cursor = 0
    const prev = currentInstance
    currentInstance = instance
    let element
    try {
      element = type(props)
    } finally {
      currentInstance = prev
    }
    const children = buildNode(element, instance)
    return { type, instance, children: Array.isArray(children) ? children : [children].filter(Boolean) }
  }
  return {
    type: String(type),
    props,
    owner,
    children: (props.children || []).map((child) => buildNode(child, owner)).filter(Boolean),
  }
}

function find(node, predicate, out = []) {
  if (!node) return out
  if (Array.isArray(node)) { node.forEach((child) => find(child, predicate, out)); return out }
  if (node.text !== undefined) return out
  if (predicate(node)) out.push(node)
  ;(node.children || []).forEach((child) => find(child, predicate, out))
  return out
}

/* --------------------------- browser stubs --------------------------- */
const storage = new Map()
const listeners = new Map()
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
  addEventListener: (type, fn) => { listeners.set(type, [...(listeners.get(type) || []), fn]) },
  removeEventListener: (type, fn) => { listeners.set(type, (listeners.get(type) || []).filter((item) => item !== fn)) },
  confirm: () => true,
}
const documentStub = {
  addEventListener: (type, fn) => { listeners.set(type, [...(listeners.get(type) || []), fn]) },
  removeEventListener: (type, fn) => { listeners.set(type, (listeners.get(type) || []).filter((item) => item !== fn)) },
  body: { appendChild: () => {} },
  createElement: () => ({ setAttribute: () => {}, remove: () => {} }),
}
function dispatch(type, event) {
  for (const fn of listeners.get(type) || []) fn(event)
}
class Notification { constructor(title, options) { void title; void options } }
Notification.permission = 'denied'

/* ------------------------------ harness ------------------------------ */
let failures = 0
const check = (name, condition, detail) => {
  if (condition) return
  failures += 1
  console.error('FAIL', name, detail === undefined ? '' : detail)
}

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'worklog-drag-'))
let tool = null
apply({
  webServer: { register: () => () => {} },
  tools: { register: (definition) => { tool = definition; return () => {} } },
  effect: () => {},
}, { stateFile: path.join(dir, 'worklog.json') })

const day = (offset) => {
  const date = new Date(Date.now() + offset * 86400000)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
await tool.execute({ action: 'task.create', title: '拖动测试任务', start: day(0), end: day(2), status: 'doing', progress: 30 })

const fetchImpl = async (url, options = {}) => {
  const payload = options.body ? JSON.parse(options.body) : Object.fromEntries(new URLSearchParams(String(url).split('?')[1] || ''))
  return { ok: true, status: 200, async text() { return JSON.stringify(await tool.execute(payload)) } }
}

const source = await fs.readFile(new URL('../client.js', import.meta.url), 'utf8')
let plugin = null
windowStub.__ModuleLoader__ = { load: (definition) => { plugin = definition.factory((name) => {
  if (name === 'react') return React
  throw new Error('unexpected require ' + name)
}) } }
const loaderWindow = windowStub
// The bundle reads the real globals (window/document), exactly as in the GUI;
// only the loader entry is passed in explicitly.
const savedGlobals = {}
for (const name of ['window', 'document', 'localStorage', 'Notification', 'fetch']) savedGlobals[name] = globalThis[name]
globalThis.window = windowStub
globalThis.document = documentStub
globalThis.localStorage = windowStub.localStorage
globalThis.Notification = Notification
globalThis.fetch = fetchImpl
new Function('window', 'document', 'localStorage', 'Notification', 'fetch', source)(
  loaderWindow, documentStub, windowStub.localStorage, Notification, fetchImpl,
)
void savedGlobals

const slots = new Map()
plugin.apply({
  slots: { inject: (name, factory) => factory(), register: (options, component) => { slots.set(options.name + ':' + (options.key || options.id || ''), component); return () => {} } },
  get: () => null,
})

/* give the store its initial data load */
const dockComponent = slots.get('shell.overlay:worklog-dock')
// Reuse one instance object per component type so hooks (and their state)
// survive re-renders, the way React keeps a mounted component's state.
const instanceByType = new Map()
function renderDock() {
  return buildNode(createElement(dockComponent, { ctx: { get: () => null }, openPanel: () => {} }), null)
}

async function mount() {
  let last = null
  for (let pass = 0; pass < 8; pass += 1) {
    effectQueue.length = 0
    last = renderDock()
    if (!effectQueue.length) break
    for (const effect of effectQueue.splice(0)) effect()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return last
}

let tree = await mount()
const floatRoot = () => find(tree, (node) => node.props?.className === 'wl-float')[0] || null
check('dock mounted open', Boolean(floatRoot()), 'no .wl-float')

const initialStyle = floatRoot().props.style
check('initial position uses left/top', Number.isFinite(initialStyle.left) && Number.isFinite(initialStyle.top), initialStyle)

/* --------------------------- drag the header -------------------------- */
// The header is the drag handle; find it through the rendered tree.
const head = () => find(floatRoot(), (node) => String(node.props?.className || '').includes('wl-float-head'))[0]
check('drag handle exists', Boolean(head()), 'no header')

const headNode = head()
check('header accepts pointer down', typeof headNode.props?.onPointerDown === 'function', Object.keys(headNode.props || {}))

// Pointer down at (1000, 300) with the panel at (initial.left, initial.top):
// grab the header 20px in from its left edge and 10px from the top.
const grabX = initialStyle.left + 20
const grabY = initialStyle.top + 10
headNode.props.onPointerDown({
  button: 0,
  clientX: grabX,
  clientY: grabY,
  currentTarget: {
    closest: () => ({ getBoundingClientRect: () => ({ left: initialStyle.left, top: initialStyle.top, width: 308, height: 420 }) }),
  },
})

check('pointermove listener registered', (listeners.get('pointermove') || []).length === 1, (listeners.get('pointermove') || []).length)
check('pointerup listener registered', (listeners.get('pointerup') || []).length === 1)

// Drag 200px left and 120px up.
dispatch('pointermove', { clientX: grabX - 200, clientY: grabY - 120 })
tree = await mount()

const movedStyle = floatRoot().props.style
check('drag moved the panel horizontally', movedStyle.left === initialStyle.left - 200, { from: initialStyle.left, to: movedStyle.left })
check('drag moved the panel vertically', movedStyle.top === initialStyle.top - 120, { from: initialStyle.top, to: movedStyle.top })

// Release: the position is remembered.
dispatch('pointerup', {})
check('drag listeners are released', (listeners.get('pointermove') || []).length === 0, (listeners.get('pointermove') || []).length)

const stored = JSON.parse(storage.get('worklog.float.v1') || 'null')
check('position persisted', stored && stored.x === movedStyle.left && stored.y === movedStyle.top, stored)

// Remount: the remembered position is restored.
tree = await mount()
const restoredStyle = floatRoot().props.style
check('position restored on remount', restoredStyle.left === movedStyle.left && restoredStyle.top === movedStyle.top,
  { previous: movedStyle, restored: restoredStyle })

/* --------------------------- clamp behaviour -------------------------- */
// A drag far past the top-left corner must stay inside the viewport.
const head2 = head()
head2.props.onPointerDown({
  button: 0,
  clientX: grabX,
  clientY: grabY,
  currentTarget: {
    closest: () => ({ getBoundingClientRect: () => ({ left: restoredStyle.left, top: restoredStyle.top, width: 308, height: 420 }) }),
  },
})
dispatch('pointermove', { clientX: -5000, clientY: -5000 })
tree = await mount()
const clampedStyle = floatRoot().props.style
check('drag clamps at the top-left edge', clampedStyle.left >= 8 && clampedStyle.top >= 8, clampedStyle)
dispatch('pointerup', {})

// And past the bottom-right corner: the header stays reachable.
const head3 = head()
head3.props.onPointerDown({
  button: 0,
  clientX: grabX,
  clientY: grabY,
  currentTarget: {
    closest: () => ({ getBoundingClientRect: () => ({ left: clampedStyle.left, top: clampedStyle.top, width: 308, height: 420 }) }),
  },
})
dispatch('pointermove', { clientX: 99999, clientY: 99999 })
tree = await mount()
const clamped2 = floatRoot().props.style
check('drag clamps at the bottom-right edge', clamped2.left + 308 <= 1440 && clamped2.top + 56 <= 900, clamped2)
dispatch('pointerup', {})

/* ---------------------------- icon drag ------------------------------- */
// A collapsed dock is one icon; it must drag to a new spot and open on a tap.
storage.set('worklog.collapsed.v1', 'true')
storage.set('worklog.icon.v1', JSON.stringify({ x: 700, y: 200 }))
// The instance cache keeps old useState values; drop it so the new persisted
// state is read on a fresh mount.
instanceByType.clear()
tree = await mount()
const iconEl = find(tree, (node) => String(node.props?.className || '').includes('wl-icon'))[0]
check('collapsed dock shows an icon', Boolean(iconEl), 'no .wl-icon')
const iconStart = iconEl.props.style
check('icon uses its saved position', iconStart.left === 700 && iconStart.top === 200, iconStart)

iconEl.props.onPointerDown({ button: 0, pointerType: 'mouse', clientX: 710, clientY: 210 })
dispatch('pointermove', { clientX: 610, clientY: 260 })
tree = await mount()
const iconMoved = find(tree, (node) => String(node.props?.className || '').includes('wl-icon'))[0]
check('icon follows the pointer', iconMoved.props.style.left === 600 && iconMoved.props.style.top === 250, iconMoved.props.style)
dispatch('pointerup', {})
const iconStored = JSON.parse(storage.get('worklog.icon.v1') || 'null')
check('icon position persisted', iconStored && iconStored.x === 600 && iconStored.y === 250, iconStored)

// A tap (no movement) expands the panel instead of moving it.
storage.delete('worklog.collapsed.v1')
instanceByType.clear()
tree = await mount()
check('expanded dock returns after untoggle', Boolean(find(tree, (node) => node.props?.className === 'wl-float')[0]), 'no .wl-float')

/* ----------------------- pointer capture path ------------------------- */
// In a real Chromium, setPointerCapture redirects pointermove to the capturing
// element: document listeners then never fire. Exercise that branch.
const captureListeners = new Map()
function addTo(map, type, fn) { map.set(type, [...(map.get(type) || []), fn]) }
function removeFrom(map, type, fn) { map.set(type, (map.get(type) || []).filter((item) => item !== fn)) }
const captureTarget = {
  setPointerCapture() { this._captured = true },
  hasPointerCapture() { return Boolean(this._captured) },
  releasePointerCapture() { this._captured = false },
  addEventListener: (type, fn) => addTo(captureListeners, type, fn),
  removeEventListener: (type, fn) => removeFrom(captureListeners, type, fn),
  getBoundingClientRect: () => ({ left: clamped2.left, top: clamped2.top, width: 308, height: 420 }),
  closest: () => ({ getBoundingClientRect: () => ({ left: clamped2.left, top: clamped2.top, width: 308, height: 420 }) }),
}
const head4 = head()
head4.props.onPointerDown({ button: 0, pointerId: 7, pointerType: 'mouse', clientX: clamped2.left + 20, clientY: clamped2.top + 10, currentTarget: captureTarget })
check('capture registers listeners on the target', (captureListeners.get('pointermove') || []).length === 1, [...captureListeners.keys()])

for (const fn of captureListeners.get('pointermove') || []) fn({ clientX: clamped2.left + 20 - 80, clientY: clamped2.top + 10 - 40 })
tree = await mount()
const capturedStyle = floatRoot().props.style
check('drag works under pointer capture', capturedStyle.left === clamped2.left - 80, { from: clamped2.left, to: capturedStyle.left })
for (const fn of captureListeners.get('pointerup') || []) fn({})
check('capture released on pointerup', captureTarget._captured === false, captureTarget._captured)

/* --------------------------- window resize --------------------------- */
// Shrinking the window must pull a remembered position back into view.
windowStub.innerWidth = 900
windowStub.innerHeight = 600
dispatch('resize', {})
tree = await mount()
const resized = floatRoot().props.style
check('resize keeps the panel visible', resized.left + 308 <= 900 && resized.top + 56 <= 600, resized)

await fs.rm(dir, { recursive: true, force: true })

if (failures) {
  console.error(`\n${failures} drag check(s) failed`)
  process.exit(1)
}
console.log('drag checks passed')
