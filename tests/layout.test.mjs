// Layout audit of the generated preview HTML.
//
// Chrome cannot launch inside this sandbox, so the screenshot step is replaced
// by structural checks over the real rendered markup: the calendar grid must be
// a complete 6×7 month, the Gantt track must have real pixel widths, and the
// floating dock must be positioned inside the viewport.
import fs from 'node:fs/promises'

const html = await fs.readFile(new URL('./preview.html', import.meta.url), 'utf8')

// Which view was rendered? Decide from body markup: the stylesheet always
// contains every rule, so matching raw HTML would find .wl-railCell even in
// the calendar view.
const bodyHtml = html.slice(html.indexOf('<body'))
const isGantt = /class="wl-railCell"/.test(bodyHtml)
const isCalendar = /class="wl-cal-cell/.test(bodyHtml)

let failures = 0
const check = (name, condition, detail) => {
  if (condition) return
  failures += 1
  console.error('FAIL', name, detail === undefined ? '' : detail)
}

const styleOf = (tag) => {
  const match = /style="([^"]*)"/.exec(tag)
  return match ? match[1] : ''
}
const classesOf = (tag) => (/(?:class|className)="([^"]*)"/.exec(tag) || [])[1] || ''



/* ------------------------------ calendar ------------------------------ */
const weekTags = [...html.matchAll(/<div class="wl-cal-week"[^>]*>/g)].map((m) => m[0])
if (isCalendar) check('calendar renders six weeks', weekTags.length === 6, weekTags.length)

const cellTags = [...html.matchAll(/<div class="wl-cal-cell[^"]*"[^>]*>/g)].map((m) => m[0])
if (isCalendar) check('calendar renders 42 day cells', cellTags.length === 42, cellTags.length)

const dowTags = [...html.matchAll(/<div class="wl-cal-dow"[^>]*>/g)].map((m) => m[0])
if (isCalendar) {
  check('calendar has a weekday header', dowTags.length === 7, dowTags.length)
  check('week starts on Monday', /周[一二三四五六日]/.test(html), 'no 周X headers')
}

const todayCells = cellTags.filter((tag) => classesOf(tag).split(' ').includes('today'))
const renderedMonth = /wl-cal-cell[^"]*\.today/.test(bodyHtml) ? true : false
if (renderedMonth) check('calendar marks today', todayCells.length === 1, todayCells.length)

const outsideCells = cellTags.filter((tag) => classesOf(tag).split(' ').includes('outside'))
if (isCalendar) check('adjacent-month days are dimmed', outsideCells.length > 0, outsideCells.length)

// The month grid is a completion log: a completed-count badge and glyphs for
// check-offs and notes. No load bar, no category dots, no assignee counts.
const doneBadges = [...bodyHtml.matchAll(/<em class="wl-cal-done"[^>]*>(✓\d+)<\/em>/g)].map((m) => m[1])
if (isCalendar) {
  check('calendar shows completed counts', doneBadges.length >= 1, doneBadges.length)
  check('completed counts use a check glyph', doneBadges.every((label) => label.startsWith('✓')), doneBadges.slice(0, 5))
}

const markTags = [...bodyHtml.matchAll(/<i class="wl-cal-mark ([a-z]+)"[^>]*>([^<]*)<\/i>/g)].map((m) => ({ kind: m[1], glyph: m[2] }))
if (isCalendar) {
  check('calendar shows completion glyphs', markTags.length >= 1, markTags.length)
  check('completion glyphs are ticks', markTags.every((mark) => mark.kind === 'note' ? mark.glyph === '✎' : mark.glyph === '✓'), markTags.slice(0, 5))
  check('calendar dropped the load bar', !bodyHtml.includes('wl-cal-load'), 'load bar still rendered')
  check('calendar dropped category dots', !bodyHtml.includes('wl-cal-dot'), 'category dots still rendered')
}

// The side panel must carry the detail the grid no longer shows.
const sideHtml = bodyHtml.slice(bodyHtml.indexOf('class="wl-side"'))
if (isCalendar) {
  check('side panel lists completed work', /完成[^<]*<\/h3>/.test(sideHtml) || sideHtml.includes('完成'), 'no completion section')
  check('side panel lists notes', sideHtml.includes('备注'), 'no notes section')
}

// No task titles may leak into the calendar.
if (isCalendar) check('calendar hides task names', !/甘特图与日历视图联调|浮窗提醒联调|需求梳理/.test(html.slice(html.indexOf('wl-cal'), html.indexOf('wl-logs'))), 'a title leaked into the grid')

// A day header number must appear in every cell.
// The day number element now also carries the task count badge.
const dayNums = [...html.matchAll(/<div class="wl-cal-daynum"[^>]*>(\d+)/g)].map((m) => Number(m[1]))
if (isCalendar) check('every cell shows its day number', dayNums.length === 42, dayNums.length)
if (isCalendar) check('day numbers are valid', dayNums.every((n) => n >= 1 && n <= 31), dayNums.slice(0, 8))

/* ----------------------------- controls ------------------------------ */
check('view switch rendered', html.includes('wl-switch-btn') && html.includes('甘特'), 'missing view switch')
// The month is now a pair of selects inside a navigator, not one label.
check('month navigator rendered', (html.match(/wl-month-select/g) || []).length >= 2,
  (html.match(/wl-month-select/g) || []).length)
check('month navigator has arrows', (html.match(/wl-nav-btn/g) || []).length >= 2,
  (html.match(/wl-nav-btn/g) || []).length)
check('new-task button rendered', html.includes('+ 新任务'))
check('float toggle rendered', html.includes('浮窗：开') || html.includes('浮窗：关'), 'missing float toggle')
check('record composer rendered', html.includes('Ctrl+Enter 提交'))

/* --------------------------- floating dock --------------------------- */
check('dock root rendered', html.includes('class="wl-float"'))
const dockTag = /<div class="wl-float"[^>]*>/.exec(html)
const dockStyle = styleOf(dockTag ? dockTag[0] : '')
check('dock placed with left/top', /left:\d+px/.test(dockStyle) && /top:\d+px/.test(dockStyle), dockStyle)
check('dock has a drag handle', html.includes('class="wl-float-head"'))
check('dock offers collapse to icon', />—</.test(html), 'no collapse control')
check('dock offers a real close', /title="关闭浮窗/.test(html), 'no close control')
check('dock has quick add', html.includes('class="wl-float-input"'))
check('dock can open the board', html.includes('打开日历看板'))

/* ------------------------- no leaked placeholders --------------------- */
const body = html.slice(html.indexOf('<body'))
check('no undefined in output', !/undefined|\bNaN\b|\[object Object\]/.test(body), (/(undefined|NaN|\[object Object\])/.exec(body) || [])[0])

// --- zone tinting: the rules must reach the page, not just the source -----
if (isCalendar) {
  const sheet = html.slice(html.indexOf('<style>'), html.indexOf('</head>'))
  for (const zone of ['rest', 'holiday', 'makeup']) {
    check('page carries the ' + zone + ' tint rule', sheet.includes('.wl-cal-cell.' + zone + '{'), zone)
  }
  check('page tints rest days', /class="wl-cal-cell [^"]*(rest|weekend)/.test(bodyHtml), 'no rest cell')
}

// --- Gantt view: rail checkboxes must be present and legible -------------
let railBoxes = []

if (isGantt) {
  railBoxes = [...html.matchAll(/<span class="wl-cal-check([^"]*)"[^>]*>([^<]*)<\/span>/g)]
  check('gantt renders a checkbox per row', railBoxes.length >= 3, railBoxes.length)
  check('gantt checkbox state is explicit', railBoxes.every((m) => m[1].includes(' on') || m[2] === ''), railBoxes.map((m) => m[2]))
  check('gantt rail is not a nested button', !/wl-railCell[^>]*role="button"/.test(html), 'rail still role=button')
  check('gantt title is its own control', (html.match(/wl-rail-open/g) || []).length >= 3, (html.match(/wl-rail-open/g) || []).length)

  // Phases draw as segments INSIDE the task bar, pinned to its lower edge.
  const strips = (html.match(/wl-bar-phases/g) || []).length
  const segments = (html.match(/class="wl-bar-phase[ "]/g) || []).length
  check('task bars carry a segment strip', strips >= 1, strips)
  check('phases render as bar segments', segments >= 1, segments)
  // Offsets are day-width pixels measured from the bar start.
  const segTag = /<i class="wl-bar-phase[^"]*"[^>]*style="[^"]*left:[0-9]+px/.exec(html)
  check('segment offsets are pixel values', Boolean(segTag), (html.match(/<i class="wl-bar-phase[^>]*/) || [])[0])
}

await fs.rm(new URL('./preview.html', import.meta.url), { force: true })

if (failures) {
  console.error(`\n${failures} layout check(s) failed`)
  process.exit(1)
}
console.log(`layout audit passed (${cellTags.length} day cells, ${doneBadges.length} completed badges, ${markTags.length} marks, ${railBoxes.length} gantt checkboxes)`)
