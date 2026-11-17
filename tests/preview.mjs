// Static preview build: renders the real plugin UI to plain HTML with the real
// host data, so it can be screenshotted in Chrome and checked visually.
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { apply } from '../index.js'

/* -------- tiny React shim (same slice as the render test) -------- */
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

/* ---------------------------- renderer ---------------------------- */
function renderNode(node) {
  if (node === null || node === undefined || node === false || node === true) return null
  if (typeof node === 'string' || typeof node === 'number') return { text: String(node) }
  if (Array.isArray(node)) return node.map(renderNode).filter(Boolean)
  if (!node || typeof node !== 'object' || !('type' in node)) return null
  const { type, props } = node
  if (type === Fragment) return renderNode(props.children)
  if (typeof type === 'function') {
    const prev = currentInstance
    const instance = { cursor: 0, slots: {}, memo: {}, refs: {}, effects: {}, dirty: false }
    currentInstance = instance
    const element = type(props)
    currentInstance = prev
    return renderNode(element)
  }
  return { type: String(type), props, children: (props.children || []).map(renderNode).filter(Boolean) }
}

const VOID = new Set(['input', 'img', 'br', 'hr', 'meta', 'link', 'source'])
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }

function styleText(style) {
  if (!style) return ''
  return Object.entries(style)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => {
      const name = key.startsWith('--') ? key : key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())
      return `${name}:${typeof value === 'number' ? value + 'px' : value}`
    })
    .join(';')
}

function toHtml(tree) {
  if (!tree) return ''
  if (Array.isArray(tree)) return tree.map(toHtml).join('')
  if (tree.text !== undefined) return tree.text.replace(/[&<>]/g, (c) => ESCAPES[c])
  const { type, props, children } = tree
  if (type === 'style') return `<style>${(children || []).map((child) => child.text ?? '').join('')}</style>`
  const attributes = []
  const skip = new Set(['children', 'style', 'key', 'autoFocus', 'dangerouslySetInnerHTML'])
  for (const [key, value] of Object.entries(props || {})) {
    if (skip.has(key) || value === undefined || value === null || value === false) continue
    if (typeof value === 'function') continue
    if (key === 'className') { attributes.push(`class="${String(value).replace(/"/g, '&quot;')}"`); continue }
    if (key === 'value' && ['input', 'textarea', 'select'].includes(type)) { attributes.push(`value="${String(value).replace(/"/g, '&quot;')}"`); continue }
    if (key === 'checked') { if (value) attributes.push('checked'); continue }
    attributes.push(`${key}="${String(value).replace(/"/g, '&quot;')}"`)
  }
  const style = styleText(props?.style)
  if (style) attributes.push(`style="${style.replace(/"/g, '&quot;')}"`)
  if (type === 'select') {
    const wanted = props?.value
    const inner = (children || []).map((child) => {
      if (!child || child.text !== undefined) return toHtml(child)
      const cloned = { ...child, props: { ...(child.props || {}) } }
      if (String(cloned.props.value) === String(wanted)) cloned.props.selected = true
      else delete cloned.props.selected
      return toHtml(cloned)
    }).join('')
    return `<select ${attributes.filter((a) => !a.startsWith('value=')).join(' ')}>${inner}</select>`
  }
  if (VOID.has(type)) return `<${type} ${attributes.join(' ')}>`
  const inner = type === 'textarea'
    ? (props?.value ?? '')
    : (children || []).map(toHtml).join('')
  return `<${type} ${attributes.join(' ')}>${inner}</${type}>`
}

async function render(element) {
  let tree = null
  for (let pass = 0; pass < 5; pass += 1) {
    effectQueue.length = 0
    tree = renderNode(element)
    if (!effectQueue.length) break
    const pending = effectQueue.splice(0)
    for (const effect of pending) effect()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return tree
}

/* --------------------------- host wiring -------------------------- */
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'worklog-preview-'))
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
const today = day(0)

await tool.execute({ action: 'task.create', title: '甘特图与日历视图联调', project: '示例工作流', start: day(-3), end: day(5), status: 'doing', progress: 45, priority: 'high', remindAt: `${today}T09:30`, remindLead: 15 })
await tool.execute({ action: 'task.create', title: '需求梳理与数据结构', project: '示例工作流', start: day(-8), end: day(-4), status: 'done' })
await tool.execute({ action: 'task.create', title: '浮窗提醒联调', project: '示例工作流', start: day(-6), end: day(-2), status: 'blocked' })
await tool.execute({ action: 'task.create', title: '插件文档与截图', project: '交付', start: day(2), end: day(7), status: 'todo', priority: 'normal' })
await tool.execute({ action: 'task.create', title: 'v1 发布评审', project: '交付', start: day(8), end: day(8), status: 'todo', milestone: true, priority: 'high' })
await tool.execute({ action: 'task.create', title: '持续打磨体验（无期限）', project: '示例工作流', start: day(-1), end: null, status: 'doing', progress: 35 })
await tool.execute({ action: 'record.create', content: '完成甘特图拖动与日期换算，处理跨月边界', minutes: 135, date: today })
await tool.execute({ action: 'record.create', content: '浮窗改用 shell.overlay，拖动位置存 localStorage', minutes: 60, date: today })
await tool.execute({ action: 'record.create', content: '补齐提醒去重，避免刷新后重复弹出', minutes: 45, date: today })

// Seed phases on one task so the nested Gantt rows are visible.
const phaseHost = (await tool.execute({ action: 'snapshot' })).tasks[0]
if (phaseHost) {
  await tool.execute({ action: 'phase', phaseAction: 'create', taskId: phaseHost.id, name: '需求调研', start: day(-8), end: day(-2), outcome: '梳理出 12 个模块', status: 'done' })
  await tool.execute({ action: 'phase', phaseAction: 'create', taskId: phaseHost.id, name: '联调实现', start: day(-1), end: day(5), outcome: '' })
}

// Seed a long-term group so its chip styling is visible.
await tool.execute({ action: 'group', groupAction: 'create', name: '长期跟进', focus: false })
await tool.execute({ action: 'task.create', title: '长线项目维护', group: '长期跟进', start: day(-10), end: null })

// Seed a check-in and a note so the completion log has something to show.
const firstTask = (await tool.execute({ action: 'snapshot' })).tasks[0]
await tool.execute({ action: 'checkin.set', taskId: firstTask.id, date: today, done: true })

/* -------- browser stubs -------- */
const storage = new Map()
const window = {
  localStorage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: (k) => storage.delete(k) },
  innerWidth: 1440, innerHeight: 940,
  setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {},
  addEventListener: () => {}, removeEventListener: () => {}, confirm: () => true,
}
const injectedStyles = []
const document = {
  addEventListener: () => {},
  removeEventListener: () => {},
  head: {
    appendChild(node) { injectedStyles.push(node.textContent || '') },
    querySelector() { return null },
  },
  body: { appendChild: () => {}, style: {} },
  createElement: () => {
    const node = { setAttribute() {}, remove() {}, textContent: '' }
    return node
  },
}
const fetchImpl = async (url, options = {}) => {
  const payload = options.body ? JSON.parse(options.body) : Object.fromEntries(new URLSearchParams(String(url).split('?')[1] || ''))
  return { ok: true, status: 200, async text() { return JSON.stringify(await tool.execute(payload)) } }
}
class Notification { constructor(title, options) { void title; void options } }
Notification.permission = 'granted'

/* -------- load the real client bundle -------- */
const source = await fs.readFile(new URL('../client.js', import.meta.url), 'utf8')
let plugin = null
window.__ModuleLoader__ = { load: (definition) => { plugin = definition.factory((name) => {
  if (name === 'react') return React
  throw new Error('unexpected require ' + name)
}) } }

const prev = {}
for (const name of ['window', 'document', 'localStorage', 'Notification', 'fetch']) { prev[name] = globalThis[name] }
globalThis.window = window
globalThis.document = document
globalThis.localStorage = window.localStorage
globalThis.Notification = Notification
globalThis.fetch = fetchImpl
try {
  new Function('window', 'document', 'localStorage', 'Notification', 'fetch', source)(window, document, window.localStorage, Notification, fetchImpl)
} finally {
  for (const name of Object.keys(prev)) globalThis[name] = prev[name]
}

const slots = new Map()
plugin.apply({
  slots: { inject: (name, factory) => factory(), register: (options, component) => { slots.set(options.name + ':' + (options.key || options.id || ''), component); return () => {} } },
  get: () => ({ selectPanel: () => {} }),
})

const VIEW = process.argv[2] || 'calendar'
const MONTH = process.argv[3] || ''
storage.set('worklog.view.v1', JSON.stringify(VIEW))
if (MONTH) storage.set('worklog.month.v1', JSON.stringify(MONTH))
if (MONTH) {
  // The board reads its anchor from state; seed it through the same snapshot
  // month the host would return.
  await tool.execute({ action: 'snapshot', month: MONTH })
}
const board = await render(React.createElement(slots.get('main:worklog-calendar'), { ctx: { get: () => null } }))
const dock = process.env.WL_NO_DOCK
  ? ''
  : await render(React.createElement(slots.get('shell.overlay:worklog-dock'), { ctx: { get: () => null }, openPanel: () => {} }))

const boardHtml = toHtml(board)
const dockHtml = toHtml(dock)

const page = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>工作记录 · 预览</title>
<style>
  :root{
    --dsw-alias-bg-base:#ffffff; --dsw-alias-bg-layer-1:#fafafa; --dsw-alias-bg-layer-2:#f2f3f5;
    --dsw-alias-label-primary:#1b1c1e; --dsw-alias-label-secondary:#787b80;
    --dsw-alias-border-l1:#e3e5e8; --dsw-alias-border-l2:#c9ccd1; --dsw-alias-border-l3:#dcdfe3;
    --dsw-alias-brand-primary:#4f6ef7; --dsw-alias-state-error-primary:#d93a3a;
    --dsw-alias-state-success-primary:#1f9d55; --dsw-alias-state-warn-primary:#c98a12;
    --dsw-alias-bg-mask-1:rgba(0,0,0,.3);
  }
  html,body{margin:0;height:100%;font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif}
  body{background:var(--dsw-alias-bg-base);display:flex;flex-direction:column;height:auto;min-height:100%}
  .frame{min-height:900px}
  .frame{flex:1;min-height:0;display:flex}
  .fake-sidebar{width:200px;background:#f4f5f7;border-right:1px solid var(--dsw-alias-border-l3);padding:16px 12px;font-size:12px;color:#787b80}
  .fake-sidebar div{padding:7px 10px;border-radius:8px;margin-bottom:3px}
  .fake-sidebar div.active{background:#e4e9ff;color:#3b56c9;font-weight:650}
  .stage{flex:1;min-width:0;position:relative;overflow:hidden}
</style>
${injectedStyles.length ? '<style data-worklog="styles">' + injectedStyles.join('\n') + '</style>' : ''}
</head>
<body>
<div class="frame">
  <div class="fake-sidebar">
    <div>对话</div><div>项目地图</div><div class="active">工作记录</div><div>插件市场</div>
  </div>
  <div class="stage">${boardHtml}</div>
</div>
${dockHtml}
</body></html>`

const out = new URL('./preview.html', import.meta.url)
await fs.writeFile(out, page, 'utf8')
await fs.rm(dir, { recursive: true, force: true })
console.log('wrote', out.pathname, 'view:', VIEW)
