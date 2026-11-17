// Smoke test for the host half: drives every action against a temp store and
// asserts the shapes the browser half depends on.
import { apply } from '../index.js'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'worklog-test-'))
const stateFile = path.join(dir, 'worklog.json')

let tool = null
let route = null
const disposers = []
const ctx = {
  webServer: {
    register(definition) {
      route = definition
      return () => { route = null }
    },
  },
  tools: {
    register(definition) {
      tool = definition
      return () => { tool = null }
    },
  },
  effect(factory) {
    disposers.push(factory())
  },
}

apply(ctx, { stateFile })
if (!tool || !route) throw new Error('plugin did not register its seams')

const run = (input) => tool.execute(input)

let failures = 0
function check(name, condition, detail) {
  if (condition) return
  failures += 1
  console.error(`FAIL ${name}`, detail ?? '')
}

// --- empty store ---------------------------------------------------------
let snap = await run({ action: 'snapshot' })
check('empty tasks', Array.isArray(snap.tasks) && snap.tasks.length === 0, snap)
check('empty records', Array.isArray(snap.records) && snap.records.length === 0)
check('default settings', snap.settings.digestAt === '09:30', snap.settings)
check('stats shape', Array.isArray(snap.stats.last30) && snap.stats.last30.length === 30)

// --- create tasks --------------------------------------------------------
const today = new Date()
const day = (offset) => {
  const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

let created = await run({ action: 'task.create', title: '写插件', project: '工具', start: day(-2), end: day(3), status: 'doing', progress: 40, priority: 'high' })
const taskId = created.task.id
check('task id is uuid-ish', typeof taskId === 'string' && taskId.length >= 32, taskId)
check('progress kept', created.task.progress === 40, created.task)
check('span kept', created.task.start === day(-2) && created.task.end === day(3), created.task)

const done = await run({ action: 'task.create', title: '已完成项', start: day(-5), end: day(-4), status: 'done', progress: 10 })
check('done forces 100%', done.task.progress === 100, done.task.progress)
check('done stamps doneAt', typeof done.task.doneAt === 'string')

const overdue = await run({ action: 'task.create', title: '逾期项', start: day(-9), end: day(-3), status: 'todo' })

snap = await run({ action: 'snapshot', day: day(0) })
check('three tasks', snap.tasks.length === 3, snap.tasks.length)
check('today bucket has spanning task', snap.digest.today.some((item) => item.id === taskId), snap.digest.today.map((t) => t.title))
check('overdue bucket', snap.digest.overdue.some((item) => item.id === overdue.task.id), snap.digest.overdue.map((t) => t.title))
check('done excluded from digest', !snap.digest.today.some((item) => item.id === done.task.id))
check('projects grouped', snap.projects.some((item) => item.name === '工具'))

// --- validation ----------------------------------------------------------
const inverted = await run({ action: 'task.update', id: taskId, start: day(5), end: day(1) })
check('inverted range collapses', inverted.task.end === day(5), inverted.task)

const clamped = await run({ action: 'task.update', id: taskId, progress: 500 })
check('progress clamped', clamped.task.progress === 100, clamped.task.progress)

const badDay = await run({ action: 'task.update', id: taskId, start: '2026-02-31' })
check('impossible date rejected', badDay.task.start !== '2026-02-31', badDay.task.start)

let threw = false
try { await run({ action: 'task.update', id: 'nope', title: 'x' }) } catch { threw = true }
check('missing task throws', threw)

threw = false
try { await run({ action: 'nope' }) } catch { threw = true }
check('unknown action throws', threw)

// restore a sane span
await run({ action: 'task.update', id: taskId, start: day(-2), end: day(3), progress: 40 })

// --- move ----------------------------------------------------------------
let moved = await run({ action: 'task.move', id: taskId, delta: 2 })
check('move shifts both ends', moved.task.start === day(0) && moved.task.end === day(5), moved.task)
moved = await run({ action: 'task.move', id: taskId, delta: -2, edge: 'start' })
check('start edge moves only start', moved.task.start === day(-2) && moved.task.end === day(5), moved.task)
moved = await run({ action: 'task.move', id: taskId, delta: 10, edge: 'end' })
check('end edge moves only end', moved.task.start === day(-2) && moved.task.end === day(15), moved.task)
moved = await run({ action: 'task.move', id: taskId, delta: -40, edge: 'end' })
check('end cannot cross start', moved.task.end === moved.task.start, moved.task)

// --- open-ended tasks ----------------------------------------------------
// A task without a deadline is normal: it appears every day from its start and
// can never be overdue.
const open = await run({ action: 'task.create', title: '持续优化', start: day(0), end: null })
check('open-ended accepted', open.task.end === null, open.task.end)
let openSnap = await run({ action: 'snapshot', day: day(30) })
check('open-ended shows every day', openSnap.digest.today.some((item) => item.id === open.task.id), openSnap.digest.today.map((t) => t.title))
check('open-ended never overdue', !openSnap.digest.overdue.some((item) => item.id === open.task.id), openSnap.digest.overdue.map((t) => t.title))

const openedMove = await run({ action: 'task.move', id: open.task.id, delta: 3 })
check('open-ended moves its start', openedMove.task.start === day(3), openedMove.task)
check('open-ended stays open', openedMove.task.end === null, openedMove.task.end)

const dated = await run({ action: 'task.update', id: open.task.id, end: day(10) })
check('a deadline can be added later', dated.task.end === day(10), dated.task.end)
const reopened = await run({ action: 'task.update', id: open.task.id, end: null })
check('a deadline can be cleared again', reopened.task.end === null, reopened.task.end)
await run({ action: 'task.delete', id: open.task.id })

// --- bulk operations -----------------------------------------------------
const bulkA = await run({ action: 'task.create', title: '批量A', start: day(0), end: day(2) })
const bulkB = await run({ action: 'task.create', title: '批量B', start: day(1), end: day(3) })
const bulkIds = [bulkA.task.id, bulkB.task.id]

let bulk = await run({ action: 'task.bulk', ids: bulkIds, op: 'set', status: 'doing', priority: 'high' })
check('bulk set count', bulk.changed === 2, bulk.changed)
check('bulk set applied', bulk.tasks.filter((t) => bulkIds.includes(t.id)).every((t) => t.status === 'doing' && t.priority === 'high'))

bulk = await run({ action: 'task.bulk', ids: bulkIds, op: 'move', delta: 5 })
check('bulk move shifts both', bulk.tasks.filter((t) => t.id === bulkA.task.id)[0].start === day(5), bulk.tasks.filter((t) => t.id === bulkA.task.id)[0].start)
check('bulk move keeps span', bulk.tasks.filter((t) => t.id === bulkB.task.id)[0].end === day(8), bulk.tasks.filter((t) => t.id === bulkB.task.id)[0].end)

bulk = await run({ action: 'task.bulk', ids: bulkIds, op: 'complete' })
check('bulk complete', bulk.tasks.filter((t) => bulkIds.includes(t.id)).every((t) => t.status === 'done' && t.progress === 100))

bulk = await run({ action: 'task.bulk', ids: bulkIds, op: 'reopen' })
check('bulk reopen', bulk.tasks.filter((t) => bulkIds.includes(t.id)).every((t) => t.status === 'todo' && t.doneAt === null))

// Batch edits are all-or-nothing on validation.
threw = false
try { await run({ action: 'task.bulk', ids: [...bulkIds, 'missing-id'], op: 'complete' }) } catch { threw = true }
check('bulk rejects unknown ids', threw)
const stillTodo = await run({ action: 'snapshot' })
check('rejected bulk changed nothing', stillTodo.tasks.filter((t) => bulkIds.includes(t.id)).every((t) => t.status === 'todo'))

threw = false
try { await run({ action: 'task.bulk', ids: [], op: 'complete' }) } catch { threw = true }
check('bulk rejects empty selection', threw)

threw = false
try { await run({ action: 'task.bulk', ids: bulkIds, op: 'nonsense' }) } catch { threw = true }
check('bulk rejects unknown op', threw)

bulk = await run({ action: 'task.bulk', ids: [bulkA.task.id], op: 'delete' })
check('bulk delete removes one', !bulk.tasks.some((t) => t.id === bulkA.task.id) && bulk.tasks.some((t) => t.id === bulkB.task.id))

// --- records -------------------------------------------------------------
const record = await run({ action: 'record.create', content: '写完了宿主端', minutes: 90, date: day(0), taskId })
check('record created', record.record.content === '写完了宿主端', record.record)
check('today minutes', record.stats.today.minutes === 90, record.stats.today)
check('heatmap length', record.stats.last30.length === 30)
check('heatmap has today', record.stats.last30[29].date === day(0), record.stats.last30[29])

threw = false
try { await run({ action: 'record.create', content: '   ' }) } catch { threw = true }
check('blank record rejected', threw)

const minutesClamped = await run({ action: 'record.update', id: record.record.id, minutes: 99999 })
check('minutes clamped', minutesClamped.record.minutes === 1440, minutesClamped.record.minutes)

// --- reminders -----------------------------------------------------------
const reminder = await run({
  action: 'task.update', id: taskId,
  remindAt: `${day(1)}T09:30`, remindLead: 15,
})
check('remindAt normalized', reminder.task.remindAt === `${day(1)}T09:30`, reminder.task.remindAt)
check('remindLead kept', reminder.task.remindLead === 15, reminder.task.remindLead)

const badReminder = await run({ action: 'task.update', id: taskId, remindAt: 'tomorrow-ish' })
check('bad reminder cleared', badReminder.task.remindAt === null, badReminder.task.remindAt)

// --- settings ------------------------------------------------------------
const settings = await run({ action: 'settings.update', settings: { digestAt: '08:15', defaultLead: 20, dayWidth: 999, sortBy: 'priority' } })
check('digest time set', settings.settings.digestAt === '08:15', settings.settings)
check('lead set', settings.settings.defaultLead === 20)
check('dayWidth clamped', settings.settings.dayWidth === 64, settings.settings.dayWidth)
check('sort set', settings.settings.sortBy === 'priority')

const badTime = await run({ action: 'settings.update', settings: { digestAt: '25:99' } })
check('bad time rejected', badTime.settings.digestAt === '08:15', badTime.settings.digestAt)

// --- persistence ---------------------------------------------------------
await fs.access(stateFile)
const onDisk = JSON.parse(await fs.readFile(stateFile, 'utf8'))
// Count-agnostic: disk must mirror the live snapshot exactly.
const liveForDisk = await run({ action: 'snapshot' })
check('persisted tasks match memory', onDisk.tasks.length === liveForDisk.tasks.length, { disk: onDisk.tasks.length, memory: liveForDisk.tasks.length })
check('persisted records match memory', onDisk.records.length === liveForDisk.records.length, { disk: onDisk.records.length, memory: liveForDisk.records.length })
check('persisted schema', onDisk.schema === 1)
check('atomic write leaves no temp', (await fs.readdir(dir)).every((name) => !name.endsWith('.tmp')), await fs.readdir(dir))

// --- delete keeps records ------------------------------------------------
const afterDelete = await run({ action: 'task.delete', id: taskId })
check('task removed', !afterDelete.tasks.some((item) => item.id === taskId))
const orphan = afterDelete.records.find((item) => item.content === '写完了宿主端')
check('record survives task delete', Boolean(orphan))
check('orphan record detached', orphan && orphan.taskId === null, orphan && orphan.taskId)

// --- reload keeps records (regression) -----------------------------------
// A record with no task used to be normalised to taskId:"null" and then
// dropped by migration as an orphan, emptying the log on every restart.
const reloadDir = await fs.mkdtemp(path.join(os.tmpdir(), 'worklog-reload-'))
const reloadFile = path.join(reloadDir, 'worklog.json')
function activate(file) {
  let instance = null
  apply({
    webServer: { register: () => () => {} },
    tools: { register: (definition) => { instance = definition; return () => {} } },
    effect: () => {},
  }, { stateFile: file })
  return instance
}
const first = activate(reloadFile)
await first.execute({ action: 'task.create', title: '跨重启任务', start: day(0), end: day(1) })
await first.execute({ action: 'record.create', content: '无归属记录', minutes: 25, date: day(0) })
const second = activate(reloadFile)
const reloaded = await second.execute({ action: 'snapshot' })
check('records survive reload', reloaded.records.length === 1, reloaded.records.length)
check('detached record stays detached', reloaded.records[0]?.taskId === null, reloaded.records[0]?.taskId)
check('record content survives', reloaded.records[0]?.content === '无归属记录', reloaded.records[0]?.content)
check('tasks survive reload', reloaded.tasks.length === 1, reloaded.tasks.length)
await fs.rm(reloadDir, { recursive: true, force: true })

// --- check-ins: "did I work on this today" -------------------------------
const checkinDay = day(0)
const ciTask = await run({ action: 'task.create', title: '打卡任务', start: checkinDay })
check('checkin starts empty', (await run({ action: 'snapshot' })).checkin.marked.length === 0)

let ci = await run({ action: 'checkin.toggle', taskId: ciTask.task.id })
check('checkin marks the task', ci.done === true, ci.done)
check('checkin appears in snapshot', ci.checkin.marked.includes(ciTask.task.id), ci.checkin)
check('checkin starts a todo task', ci.tasks.find((t) => t.id === ciTask.task.id).status === 'doing', ci.tasks.find((t) => t.id === ciTask.task.id).status)

ci = await run({ action: 'checkin.toggle', taskId: ciTask.task.id })
check('checkin toggles off', ci.done === false && !ci.checkin.marked.includes(ciTask.task.id))

const ciYesterday = await run({ action: 'checkin.set', taskId: ciTask.task.id, date: day(-1), done: true })
const todayView = await run({ action: 'snapshot', day: day(0) })
check('yesterday checkin not counted today', !todayView.checkin.marked.includes(ciTask.task.id))
check('checkin is idempotent', (await run({ action: 'checkin.set', taskId: ciTask.task.id, date: day(-1), done: true })).checkin.marked.length === (await run({ action: 'checkin.set', taskId: ciTask.task.id, date: day(-1), done: true })).checkin.marked.length)

// --- time accounting: blocked time must not count as work ----------------
const timed = await run({ action: 'task.create', title: '计时任务', start: day(0), status: 'todo' })
await run({ action: 'task.update', id: timed.task.id, status: 'doing' })
await run({ action: 'task.update', id: timed.task.id, status: 'blocked' })
const sum = await run({ action: 'summary' })
const row = sum.durations.find((item) => item.taskId === timed.task.id)
check('summary reports the task', Boolean(row), sum.durations.map((d) => d.title))
check('timing row has fields', row && typeof row.workingMinutes === 'number' && typeof row.blockedMinutes === 'number', row)
check('history records transitions', (await run({ action: 'snapshot' })).tasks.find((t) => t.id === timed.task.id).history.length >= 3,
  (await run({ action: 'snapshot' })).tasks.find((t) => t.id === timed.task.id).history)
check('summary counts blocked tasks', sum.counts.blocked >= 1, sum.counts)
check('rollup groups by project', Array.isArray(sum.rollup) && sum.rollup.length >= 1, sum.rollup)

// --- bulk status/priority (the board's dropdowns) ------------------------
const b1 = await run({ action: 'task.create', title: '批量状态A', start: day(0) })
const b2 = await run({ action: 'task.create', title: '批量状态B', start: day(0) })
let bulkState = await run({ action: 'task.bulk', ids: [b1.task.id, b2.task.id], op: 'set', status: 'blocked' })
check('bulk set status', bulkState.tasks.filter((t) => [b1.task.id, b2.task.id].includes(t.id)).every((t) => t.status === 'blocked'))
bulkState = await run({ action: 'task.bulk', ids: [b1.task.id, b2.task.id], op: 'set', priority: 'low', project: '批量项目' })
check('bulk set priority and project', bulkState.tasks.filter((t) => [b1.task.id, b2.task.id].includes(t.id)).every((t) => t.priority === 'low' && t.project === '批量项目'))
await run({ action: 'task.bulk', ids: [b1.task.id, b2.task.id], op: 'delete' })

// --- groups --------------------------------------------------------------
let grouped = await run({ action: 'group', groupAction: 'create', name: '本周必做' })
check('group created', grouped.groups.some((g) => g.name === '本周必做'), grouped.groups)

threw = false
try { await run({ action: 'group', groupAction: 'create', name: '本周必做' }) } catch { threw = true }
check('duplicate group rejected', threw)

const gTask = await run({ action: 'task.create', title: '分组任务', start: day(0), group: '本周必做' })
check('task carries a group', gTask.task.group === '本周必做', gTask.task.group)
grouped = await run({ action: 'snapshot' })
check('group counts its tasks', grouped.groups.find((g) => g.name === '本周必做')?.tasks === 1, grouped.groups)

// Bulk assign a group, the way the batch bar does it.
const g2 = await run({ action: 'task.create', title: '待归档', start: day(0) })
await run({ action: 'task.bulk', ids: [g2.task.id], op: 'set', group: '本周必做' })
const afterBulkGroup = await run({ action: 'snapshot' })
check('bulk sets group', afterBulkGroup.tasks.find((t) => t.id === g2.task.id).group === '本周必做')
check('bulk group counted', afterBulkGroup.groups.find((g) => g.name === '本周必做').tasks === 2, afterBulkGroup.groups)

// Rename carries the tasks with it; delete only detaches them.
await run({ action: 'group', groupAction: 'rename', from: '本周必做', name: '冲刺周' })
const renamed = await run({ action: 'snapshot' })
check('rename moves tasks', renamed.tasks.filter((t) => t.group === '冲刺周').length === 2, renamed.tasks.map((t) => t.group))
check('rename keeps one group', renamed.groups.length === 1 && renamed.groups[0].name === '冲刺周', renamed.groups)

const deleted = await run({ action: 'group', groupAction: 'delete', name: '冲刺周' })
check('delete removes the group', deleted.groups.length === 0, deleted.groups)
check('delete detaches tasks', deleted.tasks.filter((t) => t.group === '').length >= 2, deleted.tasks.map((t) => t.group))
check('delete keeps the tasks', deleted.tasks.some((t) => t.title === '分组任务'))


// --- a grouped task is never reported as 未分组 ---------------------------
// Regression: projectList() only read `project`, so a task filed under a group
// showed up as ungrouped in the board's rollup.
const onlyGroup = await run({ action: 'task.create', title: '只有分组', group: '课程开发', start: day(0) })
const onlyProject = await run({ action: 'task.create', title: '只有项目', project: '交付', start: day(0) })
const neither = await run({ action: 'task.create', title: '都没有', start: day(0) })
const rollupLabels = (await run({ action: 'snapshot' })).projects
check('group becomes the label', rollupLabels.some((p) => p.name === '课程开发'), rollupLabels)
check('project keeps its own label', rollupLabels.some((p) => p.name === '交付'), rollupLabels)
// Other fixtures may also be unfiled; what matters is that the grouped task
// is not counted there.
const ungrouped = rollupLabels.find((p) => p.name === '未分组')?.count || 0
const earliest = (await run({ action: 'snapshot' })).tasks.filter((task) => !task.project && !task.group).length
check('未分组 counts only truly unfiled tasks', ungrouped === earliest, { ungrouped, earliest })
const summaryLabels = (await run({ action: 'summary' })).rollup.map((r) => r.project)
check('summary agrees with the board', summaryLabels.includes('课程开发') && summaryLabels.includes('交付'), summaryLabels)
await run({ action: 'task.bulk', ids: [onlyGroup.task.id, onlyProject.task.id, neither.task.id], op: 'delete' })


// --- working days and public holidays ------------------------------------
// Data comes from the State Council's annual notice (see holidays.json).
const cal = await run({ action: 'snapshot', day: '2026-11-12' })
check('snapshot carries a calendar', Array.isArray(cal.calendar?.days), cal.calendar)
check('calendar covers the month', cal.calendar.days.length === 30, cal.calendar?.days?.length)

const byDay = (list, day) => list.find((entry) => entry.day === day)
check('ordinary weekday is a workday', byDay(cal.calendar.days, '2026-11-12')?.off === false, byDay(cal.calendar.days, '2026-11-12'))
check('ordinary weekend is off', byDay(cal.calendar.days, '2026-11-14')?.off === true, byDay(cal.calendar.days, '2026-11-14'))

// 2026-10-01 is 国庆节 (off); 2026-10-10 is a 调休 workday (Saturday worked).
const oct = await run({ action: 'snapshot', day: '2026-10-01' })
check('holiday is off', byDay(oct.calendar.days, '2026-10-01')?.off === true, byDay(oct.calendar.days, '2026-10-01'))
check('holiday is named', byDay(oct.calendar.days, '2026-10-01')?.name === '国庆节', byDay(oct.calendar.days, '2026-10-01'))
check('makeup Saturday is a workday', byDay(oct.calendar.days, '2026-10-10')?.off === false, byDay(oct.calendar.days, '2026-10-10'))
check('makeup day is flagged', byDay(oct.calendar.days, '2026-10-10')?.makeup === true, byDay(oct.calendar.days, '2026-10-10'))

// A new task defaults onto a working day, not a weekend.
const holidayDay = await run({ action: 'task.create', title: '国庆期间新任务', start: '2026-10-01' })
check('explicit start is respected', holidayDay.task.start === '2026-10-01', holidayDay.task.start)
const autoStart = await run({ action: 'task.create', title: '自动排到工作日' })
const autoKind = (await run({ action: 'snapshot', day: autoStart.task.start })).calendar.days
check('auto start lands on a workday', autoKind.find((entry) => entry.day === autoStart.task.start)?.off === false, autoStart.task.start)
check('auto start is not a weekend', ![0, 6].includes(new Date(autoStart.task.start + 'T00:00:00Z').getUTCDay()), autoStart.task.start)

// Turning the rule off lets tasks start on a weekend again.
await run({ action: 'settings.update', settings: { workdaysOnly: false } })
const weekendTask = await run({ action: 'task.create', title: '周末也排', start: '2026-11-14', end: '2026-11-14' })
check('rule off keeps the weekend', weekendTask.task.start === '2026-11-14', weekendTask.task.start)
await run({ action: 'settings.update', settings: { workdaysOnly: true } })
await run({ action: 'task.bulk', ids: [holidayDay.task.id, autoStart.task.id, weekendTask.task.id], op: 'delete' })

// --- paging months returns that month's classification -------------------
// Regression: the snapshot always classified the reference day's month, so the
// calendar showed no holiday tints after paging away from today.
const oct2026 = await run({ action: 'snapshot', month: '2026-10' })
check('month request is honoured', oct2026.calendar.month === '2026-10', oct2026.calendar.month)
check('october has 31 days', oct2026.calendar.days.length === 31, oct2026.calendar.days.length)
check('october carries national-day holidays',
  oct2026.calendar.days.filter((entry) => entry.holiday).length === 7,
  oct2026.calendar.days.filter((entry) => entry.holiday).map((entry) => entry.day))
check('october carries a makeup day',
  oct2026.calendar.days.filter((entry) => entry.makeup).length === 1,
  oct2026.calendar.days.filter((entry) => entry.makeup).map((entry) => entry.day))

const feb2026 = await run({ action: 'snapshot', month: '2026-02' })
check('february is classified separately', feb2026.calendar.month === '2026-02', feb2026.calendar.month)
check('february has spring-festival holidays',
  feb2026.calendar.days.filter((entry) => entry.holiday).length === 9,
  feb2026.calendar.days.filter((entry) => entry.holiday).length)

// A bad month value falls back to the reference day's month rather than throwing.
const badMonth = await run({ action: 'snapshot', month: 'not-a-month', day: '2026-10-05' })
check('bad month falls back', badMonth.calendar.month === '2026-10', badMonth.calendar.month)


// --- rest days hide work until it is checked off --------------------------
// Rule: a weekend or holiday cell shows no tasks by default. A task checked off
// for that day reappears — that is evidence work actually happened.
const restProbe = await run({ action: 'task.create', title: '跨周末任务', start: '2026-11-13', end: '2026-11-16' })
const restSnap = await run({ action: 'snapshot', month: '2026-11' })
const kindOf = (day) => restSnap.calendar.days.find((entry) => entry.day === day)
check('friday is a workday', kindOf('2026-11-13')?.off === false, kindOf('2026-11-13'))
check('saturday is a rest day', kindOf('2026-11-14')?.off === true, kindOf('2026-11-14'))
check('sunday is a rest day', kindOf('2026-11-15')?.off === true, kindOf('2026-11-15'))

// The display rule the client applies, reproduced against real data.
const visibleOn = (day, checkins) => {
  const fact = kindOf(day)
  const checked = new Set(checkins.filter((row) => row.date === day).map((row) => row.taskId))
  return [restProbe.task].filter((task) => {
    const covered = task.start <= day && (!task.end || task.end >= day)
    if (!covered) return checked.has(task.id)
    if (fact?.off) return checked.has(task.id)
    return true
  }).length
}
const emptyCheckins = []
const checkedSaturday = [{ taskId: restProbe.task.id, date: '2026-11-14' }]
check('workday shows the task', visibleOn('2026-11-13', emptyCheckins) === 1)
check('rest day shows nothing by default', visibleOn('2026-11-14', emptyCheckins) === 0)
check('checked rest day shows the task', visibleOn('2026-11-14', checkedSaturday) === 1)
check('other rest day stays empty', visibleOn('2026-11-15', checkedSaturday) === 0)
await run({ action: 'task.delete', id: restProbe.task.id })


// --- non-focus groups stay out of the everyday surfaces ------------------
// A long-term follow-up group must not push its tasks at the user daily: they
// are hidden from the dock and the calendar, but remain in the data and the
// Gantt view. focusTaskIds is the single rule both surfaces read.
await run({ action: 'group', groupAction: 'create', name: '日常重点', focus: true })
await run({ action: 'group', groupAction: 'create', name: '长期跟进', focus: false })

const focusProbe = await run({ action: 'task.create', title: '日常任务', group: '日常重点', start: '2026-11-12' })
const lazyProbe = await run({ action: 'task.create', title: '长线任务', group: '长期跟进', start: '2026-11-12' })
const plainProbe = await run({ action: 'task.create', title: '无分组任务', start: '2026-11-12' })

let focusSnap = await run({ action: 'snapshot', month: '2026-11' })
let focused = new Set(focusSnap.focusTaskIds)
check('focus group task is everyday', focused.has(focusProbe.task.id))
check('non-focus group task is not everyday', !focused.has(lazyProbe.task.id), focused.size)
check('ungrouped task is everyday', focused.has(plainProbe.task.id))

check('group list marks focus', focusSnap.groups.find((g) => g.name === '长期跟进')?.focus === false,
  focusSnap.groups)
check('focus groups sort first', focusSnap.groups[0].focus !== false, focusSnap.groups.map((g) => [g.name, g.focus]))

// The task still exists: hiding it from the dock is not deleting it.
check('sidelined task is still stored',
  focusSnap.tasks.some((task) => task.id === lazyProbe.task.id))

// Flipping the flag brings it back without touching the tasks.
await run({ action: 'group', groupAction: 'focus', name: '长期跟进', focus: true })
focusSnap = await run({ action: 'snapshot', month: '2026-11' })
focused = new Set(focusSnap.focusTaskIds)
check('focus can be turned back on', focused.has(lazyProbe.task.id))

// And off again.
await run({ action: 'group', groupAction: 'focus', name: '长期跟进', focus: false })
focusSnap = await run({ action: 'snapshot', month: '2026-11' })
check('focus can be turned off again', !new Set(focusSnap.focusTaskIds).has(lazyProbe.task.id))
check('flag is persisted on the group', focusSnap.groups.find((g) => g.name === '长期跟进')?.focus === false)

// Reordering groups must not silently re-focus a sidelined group.
const reordered = await run({ action: 'group', groupAction: 'reorder', order: ['长期跟进', '日常重点'] })
check('reorder preserves the focus flag',
  reordered.groups.find((g) => g.name === '长期跟进')?.focus === false, reordered.groups)

await run({ action: 'task.bulk', ids: [focusProbe.task.id, lazyProbe.task.id, plainProbe.task.id], op: 'delete' })
await run({ action: 'group', groupAction: 'delete', name: '长期跟进' })
await run({ action: 'group', groupAction: 'delete', name: '日常重点' })



// --- phases belong to ONE project ----------------------------------------
// A "project" is a task: the top-level piece of work being delivered. Phases
// record what each stretch of that project produced.
const projA = await run({ action: 'task.create', title: '智能课程开发', group: '课程开发', start: '2026-11-01' })
const projB = await run({ action: 'task.create', title: '雷达车底座测试', group: '独立小项目', start: '2026-11-01' })

const pa1 = await run({
  action: 'phase', phaseAction: 'create',
  taskId: projA.task.id, name: '需求调研',
  start: '2026-11-01', end: '2026-11-15',
  outcome: '梳理出 12 个课程模块',
})
check('phase created on a project', pa1.phase?.name === '需求调研', pa1.phase)
check('phase records its project', pa1.phase.taskId === projA.task.id, pa1.phase.taskId)
check('phase keeps its outcome', pa1.phase.outcome === '梳理出 12 个课程模块', pa1.phase.outcome)

// A phase cannot exist without a project.
threw = false
try { await run({ action: 'phase', phaseAction: 'create', name: '无主阶段' }) } catch { threw = true }
check('phase requires a project', threw)

threw = false
try { await run({ action: 'phase', phaseAction: 'create', taskId: 'not-a-task', name: '幽灵阶段' }) } catch { threw = true }
check('phase rejects an unknown project', threw)

const pa2 = await run({
  action: 'phase', phaseAction: 'create',
  taskId: projA.task.id, name: '联调实现',
  start: '2026-11-16', end: '2026-12-10',
})
// A second project's phase must not mix with the first.
const pb1 = await run({
  action: 'phase', phaseAction: 'create',
  taskId: projB.task.id, name: '结构验证',
  start: '2026-11-05', end: '2026-11-20',
})

let phSnap = await run({ action: 'snapshot', month: '2026-11' })
const projAPhases = phSnap.phases.filter((p) => p.taskId === projA.task.id)
check('phases are scoped to their project', projAPhases.length === 2,
  phSnap.phases.map((p) => [p.name, p.taskId]))
check('phases sort by start', projAPhases.map((p) => p.name).join(',') === '需求调研,联调实现',
  projAPhases.map((p) => p.name))
check('phases name their project',
  phSnap.phases.find((p) => p.name === '需求调研')?.projectTitle === '智能课程开发',
  phSnap.phases.map((p) => p.projectTitle))
check('other project keeps its own phase',
  phSnap.phases.filter((p) => p.taskId === projB.task.id).length === 1,
  phSnap.phases.map((p) => p.taskId))

// Progress and dates are derived.
const p1 = phSnap.phases.find((p) => p.name === '需求调研')
check('phase reports its window', p1.start === '2026-11-01' && p1.end === '2026-11-15', p1)
// Progress is derived from the phase's own window unless marked done.
check('phase progress is within 0-100', p1.progress >= 0 && p1.progress <= 100, p1.progress)
const freshPhase = await run({
  action: 'phase', phaseAction: 'create',
  taskId: projB.task.id, name: '进度探针',
  start: day(-5), end: day(5),
})
const probe = (await run({ action: 'snapshot', month: '2026-11' })).phases.find((p) => p.name === '进度探针')
check('unfinished phase reports elapsed progress', probe.progress > 0 && probe.progress < 100, probe.progress)
check('a marked-done phase is 100%',
  (await run({ action: 'snapshot', month: '2026-11' })).phases.find((p) => p.name === '需求调研')?.progress === 100,
  (await run({ action: 'snapshot', month: '2026-11' })).phases.find((p) => p.name === '需求调研')?.progress)
await run({ action: 'phase', phaseAction: 'delete', id: freshPhase.phase.id })

// Editing keeps the project link and can rewrite the outcome.
const phEdit = await run({
  action: 'phase', phaseAction: 'update', id: pa1.phase.id,
  outcome: '最终梳理出 14 个模块', status: 'done',
})
check('phase update rewrites the outcome', phEdit.phase.outcome === '最终梳理出 14 个模块', phEdit.phase.outcome)
check('phase update keeps the project', phEdit.phase.taskId === projA.task.id, phEdit.phase.taskId)
check('phase status update', phEdit.phase.status === 'done', phEdit.phase.status)

// A phase can be moved to another project.
const phaseMoved = await run({ action: 'phase', phaseAction: 'update', id: pa2.phase.id, taskId: projB.task.id })
check('phase can move projects', phaseMoved.phase.taskId === projB.task.id, phaseMoved.phase.taskId)

// Deleting a phase never deletes its project.
await run({ action: 'phase', phaseAction: 'delete', id: pb1.phase.id })
phSnap = await run({ action: 'snapshot', month: '2026-11' })
check('deleted phase is gone', !phSnap.phases.some((p) => p.name === '结构验证'))
check('project survives phase deletion', phSnap.tasks.some((t) => t.id === projB.task.id))

// Deleting the project clears its phases (they have no owner any more).
await run({ action: 'task.delete', id: projA.task.id })
phSnap = await run({ action: 'snapshot', month: '2026-11' })
const orphanReloaded = await run({ action: 'snapshot', month: '2026-11' })
check('deleting a project drops its phases',
  !orphanReloaded.phases.some((p) => p.taskId === projA.task.id),
  orphanReloaded.phases.map((p) => p.taskId))

await run({ action: 'task.bulk', ids: [projB.task.id], op: 'delete' })

// --- corruption recovery -------------------------------------------------
// A running store keeps its in-memory copy (single writer), so recovery is
// observed through a fresh activation over the damaged file.
const corruptFile = path.join(dir, 'corrupt.json')
await fs.writeFile(corruptFile, '{ this is not json', 'utf8')
let recoveredTool = null
apply({
  webServer: { register: () => () => {} },
  tools: { register: (definition) => { recoveredTool = definition; return () => {} } },
  effect: () => {},
}, { stateFile: corruptFile })
const recovered = await recoveredTool.execute({ action: 'snapshot' })
check('corrupt file recovers to empty', recovered.tasks.length === 0)
check('corrupt file reported', (recovered.warnings || []).length === 1, recovered.warnings)
const backups = (await fs.readdir(dir)).filter((name) => name.includes('.corrupt-'))
check('corrupt file backed up', backups.length === 1, await fs.readdir(dir))

// --- HTTP route ----------------------------------------------------------
function fakeRequest(method, url, body) {
  const chunks = body === undefined ? [] : [Buffer.from(body, 'utf8')]
  return {
    method,
    url,
    async *[Symbol.asyncIterator]() { yield* chunks },
  }
}
function fakeResponse() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers || {} },
    end(value) { if (value !== undefined) this.body = String(value) },
    json() { return JSON.parse(this.body) },
  }
}

async function call(method, url, payload, raw = false) {
  const res = fakeResponse()
  const body = payload === undefined ? undefined : (raw ? payload : JSON.stringify(payload))
  await route.handler(fakeRequest(method, url, body), res)
  return res
}

const getEmpty = await call('GET', '/api/worklog-calendar?action=snapshot')
check('GET 200', getEmpty.status === 200, getEmpty.status)
check('GET shape', Array.isArray(getEmpty.json().tasks))

const postCreate = await call('POST', '/api/worklog-calendar', { action: 'task.create', title: '经 HTTP 创建', start: day(0), end: day(2) })
check('POST create', postCreate.status === 200 && postCreate.json().task.title === '经 HTTP 创建', postCreate.body.slice(0, 200))

// The HTTP route must forward every parameter the board sends. A dropped
// `month` made the calendar return today's month for every request, which is
// why holiday colours never showed up.
const octViaHttp = await call('GET', '/api/worklog-calendar?action=snapshot&month=2026-10')
check('GET forwards month', octViaHttp.json().calendar?.month === '2026-10', octViaHttp.json().calendar?.month)
check('GET month carries holidays',
  (octViaHttp.json().calendar?.days || []).filter((entry) => entry.holiday).length === 7,
  (octViaHttp.json().calendar?.days || []).filter((entry) => entry.holiday).length)

const postBad = await call('POST', '/api/worklog-calendar', { action: 'task.update', id: 'nope' })
check('POST error is 400', postBad.status === 400, postBad.status)
check('POST error carries message', typeof postBad.json().error === 'string')

const postBroken = await call('POST', '/api/worklog-calendar', '{broken', true)
check('malformed JSON is 400', postBroken.status === 400, postBroken.status)

const methodNotAllowed = await call('DELETE', '/api/worklog-calendar')
check('DELETE is 405', methodNotAllowed.status === 405, methodNotAllowed.status)

const head = await call('HEAD', '/api/worklog-calendar')
check('HEAD 200', head.status === 200)
check('HEAD has no body', head.body === '', JSON.stringify(head.body))

// --- tool metadata -------------------------------------------------------
check('tool name', tool.name === 'worklog', tool.name)
check('tool params', tool.parameters.required.includes('action'))
check('tool render', tool.output.render({ action: 'snapshot' }, { tasks: [] })[0].type === 'text')

// --- disposal ------------------------------------------------------------
for (const dispose of disposers) dispose()
check('route disposed', route === null)
check('tool disposed', tool === null)

await fs.rm(dir, { recursive: true, force: true })

if (failures) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('all host checks passed')
