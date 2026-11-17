/**
 * Host half of the work-log calendar plugin.
 *
 * A small, dependency-free JSON store plus two seams:
 *
 *   - an HTTP route for the browser half (`/api/worklog-calendar`), which
 *     answers GET reads and POST mutations;
 *   - a model tool (`worklog`) so the agent can read and write the same
 *     records the user sees in the Gantt board.
 *
 * The store is a single file under the plugin directory: it survives plugin
 * restarts, moves with the folder, and never lives in the DSH profile where a
 * profile reset would take it away. Writes are serialised and atomic (write a
 * temp file, then rename) so a crash mid-write cannot truncate the data.
 *
 * Domain model
 * ------------
 * tasks[]    the Gantt rows: a title, a project, an inclusive day span
 *            (start/end as local `YYYY-MM-DD`), a status, progress and an
 *            optional reminder instant.
 * records[]  the work log: short entries ("今天做了什么") attached to a day
 *            and optionally to a task. Minutes are optional.
 * settings   reminder and display preferences shared by both halves.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/
const STATUSES = ['todo', 'doing', 'blocked', 'done']
const PRIORITIES = ['low', 'normal', 'high']
const MAX_TEXT = 2000

const json = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })

const nowIso = () => new Date().toISOString()

/** Local calendar day of a Date, not the UTC one. */
function dayOf(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function addDays(day, count) {
  const [y, m, d] = day.split('-').map(Number)
  const date = new Date(y, m - 1, d + count)
  return dayOf(date)
}

function dayDiff(from, to) {
  const parse = (value) => {
    const [y, m, d] = value.split('-').map(Number)
    return Date.UTC(y, m - 1, d)
  }
  return Math.round((parse(to) - parse(from)) / 86400000)
}

function clampText(value, limit = MAX_TEXT) {
  return String(value ?? '').slice(0, limit)
}

function normalizeDay(value, fallback) {
  const text = String(value ?? '').trim()
  if (!DATE_RE.test(text)) return fallback
  const [y, m, d] = text.split('-').map(Number)
  const probe = new Date(y, m - 1, d)
  // Reject impossible dates such as 2026-02-31.
  if (probe.getFullYear() !== y || probe.getMonth() !== m - 1 || probe.getDate() !== d) return fallback
  return text
}

function normalizeTime(value, fallback) {
  const text = String(value ?? '').trim()
  return TIME_RE.test(text) ? text : fallback
}

/** `YYYY-MM-DDTHH:mm` in local time, the shape `<input type="datetime-local">` emits. */
function normalizeInstant(value) {
  const text = String(value ?? '').trim()
  if (!text) return null
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(text)
  if (!match) return null
  const day = normalizeDay(match[1], null)
  if (!day || !TIME_RE.test(match[2])) return null
  return `${day}T${match[2]}`
}

function normalizeStatus(value, fallback = 'todo') {
  return STATUSES.includes(value) ? value : fallback
}

function normalizePriority(value, fallback = 'normal') {
  return PRIORITIES.includes(value) ? value : fallback
}

function normalizeTask(input, base) {
  const previous = base || {}
  const start = normalizeDay(input?.start, previous.start || dayOf())
  // An end is optional: most tasks only get a deadline once it is known, and
  // until then they are open-ended rather than fake-dated.
  const endRaw = input?.end === undefined ? previous.end : input.end
  const explicitOpen = input?.openEnded === true || endRaw === null || endRaw === ''
  const rawEnd = explicitOpen ? null : normalizeDay(endRaw, start)
  // A dated span always reads forward: an inverted range collapses onto start.
  const end = rawEnd === null ? null : (dayDiff(start, rawEnd) < 0 ? start : rawEnd)
  const status = normalizeStatus(input?.status, previous.status || 'todo')
  const progressRaw = Number(input?.progress)
  const progress = Number.isFinite(progressRaw)
    ? Math.max(0, Math.min(100, Math.round(progressRaw)))
    : previous.progress ?? 0
  return {
    ...previous,
    title: clampText(input?.title ?? previous.title ?? '', 120).trim() || '未命名任务',
    detail: clampText(input?.detail ?? previous.detail ?? ''),
    project: clampText(input?.project ?? previous.project ?? '', 40).trim(),
    // Free-text grouping, independent of project (see groupList()).
    group: clampText(input?.group === undefined ? previous.group ?? '' : input.group, 40).trim(),
    start,
    end,
    status,
    priority: normalizePriority(input?.priority, previous.priority || 'normal'),
    // Done is 100% by definition; otherwise keep the user's number.
    progress: status === 'done' ? 100 : progress,
    color: /^#[0-9a-f]{3,8}$/i.test(String(input?.color ?? '')) ? String(input.color) : previous.color || null,
    milestone: input?.milestone === undefined ? Boolean(previous.milestone) : Boolean(input.milestone),
    remindAt: input?.remindAt === undefined ? previous.remindAt || null : normalizeInstant(input.remindAt),
    remindLead: Number.isFinite(Number(input?.remindLead)) ? Number(input.remindLead) : previous.remindLead ?? 10,
    doneAt: status === 'done' ? previous.doneAt || nowIso() : null,
    // Append-only status history: { status, at }. Time-in-state is derived
    // from it, so a task blocked for a week does not count as working time.
    history: appendHistory(previous.history, status, previous.status, previous.createdAt),
    createdAt: previous.createdAt || nowIso(),
    updatedAt: nowIso(),
  }
}

/**
 * Record a status transition. Only real transitions are appended, so repeated
 * saves do not inflate the history, and a task created already-done still gets
 * one opening entry.
 */
function appendHistory(previousHistory, status, previousStatus, createdAt) {
  const history = Array.isArray(previousHistory) ? [...previousHistory] : []
  if (!history.length) {
    history.push({ status: previousStatus || status, at: createdAt || nowIso() })
  }
  const last = history[history.length - 1]
  if (last.status !== status) history.push({ status, at: nowIso() })
  return history
}

function normalizeRecord(input, base) {
  const previous = base || {}
  const date = normalizeDay(input?.date, previous.date || dayOf())
  const minutesRaw = Number(input?.minutes)
  const minutes = Number.isFinite(minutesRaw) ? Math.max(0, Math.min(1440, Math.round(minutesRaw))) : previous.minutes ?? 0
  const content = clampText(input?.content ?? previous.content ?? '').trim()
  // An absent or empty taskId means "not attached to a task". String() would
  // turn null into "null" — a truthy id that never matches a task, which used
  // to make migration drop the record as an orphan.
  const rawTaskId = input?.taskId === undefined ? previous.taskId : input.taskId
  const taskId = rawTaskId === null || rawTaskId === undefined || rawTaskId === ''
    ? null
    : String(rawTaskId)
  return {
    ...previous,
    taskId,
    date,
    minutes,
    content: content || previous.content || '',
    createdAt: previous.createdAt || nowIso(),
    updatedAt: nowIso(),
  }
}

const TASK_FIELDS = [
  'title', 'detail', 'project', 'group', 'start', 'end', 'status', 'priority',
  'progress', 'color', 'milestone', 'remindAt', 'remindLead',
]
const RECORD_FIELDS = ['taskId', 'date', 'minutes', 'content']

/**
 * Collect writable fields from a tool call. The tool exposes flat parameters
 * for convenience, so a caller may pass `title` directly; `patch` / `task`
 * (or `record`) lets a caller nest them instead. An explicit nested object
 * wins over the flat field of the same name.
 */
function pickPatch(input, fields, nestedKeys = ['patch', 'task', 'record']) {
  const flat = {}
  for (const field of fields) if (input?.[field] !== undefined) flat[field] = input[field]
  for (const key of nestedKeys) {
    const nested = input?.[key]
    if (nested && typeof nested === 'object') Object.assign(flat, nested)
  }
  return flat
}

const DEFAULT_SETTINGS = {
  /** Daily digest time; the floating window fires it once per day per client. */
  digestAt: '09:30',
  /** Remind this many minutes before a task's `remindAt` lead-in, in minutes. */
  defaultLead: 10,
  /** Show the floating window on load. */
  floatEnabled: true,
  /** Sort order of the Gantt rows. */
  sortBy: 'start',
  /** Pixel width of one day column in the Gantt board. */
  dayWidth: 26,
  /** Keep new tasks on working days (skips weekends and public holidays). */
  workdaysOnly: true,
}

function loadHolidayTable() {
  try {
    const file = config_holidayFile()
    if (!file) return {}
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    // A missing or unreadable table degrades to weekends-only, never crashes.
    return {}
  }
}

function config_holidayFile() {
  try {
    return fileURLToPath(new URL('./holidays.json', import.meta.url))
  } catch {
    return null
  }
}

function makeStore(config) {
  // The store lives next to the plugin unless `stateFile` says otherwise, so a
  // fresh install works with no configuration at all. `process.cwd()` would be
  // the host's working directory, which is not ours and not stable.
  const stateFile = path.resolve(
    config?.stateFile || fileURLToPath(new URL('./data/worklog.json', import.meta.url)),
  )
  const holidays = loadHolidayTable()
  let cache = null
  // One write at a time: two overlapping saves would race the rename.
  let queue = Promise.resolve()

  function empty() {
    return { schema: 1, tasks: [], records: [], checkins: [], groups: [], phases: [], holidays, settings: { ...DEFAULT_SETTINGS } }
  }

  function migrate(raw) {
    if (!raw || typeof raw !== 'object') return empty()
    const tasks = Array.isArray(raw.tasks) ? raw.tasks.map((task) => normalizeTask(task, task)) : []
    const ids = new Set(tasks.map((task) => task.id))
    const records = Array.isArray(raw.records)
      ? raw.records.map((record) => normalizeRecord(record, record)).filter((record) => !record.taskId || ids.has(record.taskId))
      : []
    return {
      schema: 1,
      tasks,
      records,
      // A refreshed table in the file wins; otherwise fall back to the bundle.
      holidays: Object.keys(raw.holidays || {}).length ? raw.holidays : holidays,
      groups: Array.isArray(raw.groups)
        ? raw.groups
            .filter((group) => group && String(group.name || '').trim())
            .map((group, index) => ({
              name: clampText(group.name, 40).trim(),
              order: Number.isFinite(Number(group.order)) ? Number(group.order) : index,
              focus: group.focus !== false,
              createdAt: group.createdAt || nowIso(),
            }))
        : [],
      phases: Array.isArray(raw.phases)
        ? raw.phases
            .filter((phase) => phase && String(phase.name || '').trim())
            .filter((phase) => phase.taskId && ids.has(String(phase.taskId)))
            .map((phase) => normalizePhase(phase, phase, String(phase.taskId)))
        : [],
      checkins: Array.isArray(raw.checkins)
        ? raw.checkins
            .filter((row) => row && row.taskId && row.date)
            .filter((row) => ids.has(String(row.taskId)))
            .map((row) => ({
              id: String(row.id || randomUUID()),
              taskId: String(row.taskId),
              date: normalizeDay(row.date, dayOf()),
              minutes: Math.max(0, Math.min(1440, Math.round(Number(row.minutes) || 0))),
              createdAt: row.createdAt || nowIso(),
            }))
        : [],
      settings: { ...DEFAULT_SETTINGS, ...(raw.settings || {}) },
    }
  }

  async function load() {
    if (cache) return cache
    try {
      cache = migrate(JSON.parse(await fs.readFile(stateFile, 'utf8')))
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        // A corrupt file is preserved for inspection instead of being silently
        // overwritten by the next save.
        const backup = `${stateFile}.corrupt-${Date.now()}`
        await fs.rename(stateFile, backup).catch(() => undefined)
        cache = empty()
        cache.warnings = [`数据文件无法解析，已备份为 ${path.basename(backup)} 并从空库开始。`]
      } else {
        cache = empty()
      }
    }
    return cache
  }

  async function persist(state) {
    const run = async () => {
      await fs.mkdir(path.dirname(stateFile), { recursive: true })
      const temp = `${stateFile}.${process.pid}.tmp`
      await fs.writeFile(temp, JSON.stringify(state, null, 2), 'utf8')
      await fs.rename(temp, stateFile)
    }
    const result = queue.then(run, run)
    queue = result.then(() => undefined, () => undefined)
    return result
  }

  /* ----------------------------- queries ----------------------------- */

  /* --------------------------- calendar facts --------------------------- */

  /**
   * Working-day rules, driven by the bundled holiday table.
   *
   * A day is a working day unless it is a weekend — except that a weekend can
   * be a 调休 workday (班), and a weekday can be a holiday (休). Both come from
   * the State Council notice, so the plugin never guesses.
   */
  function calendarFacts(state) {
    return state.holidays && typeof state.holidays === 'object' ? state.holidays : {}
  }

  function holidayEntry(facts, day) {
    const year = String(day).slice(0, 4)
    const table = facts.years?.[year]
    if (!table || !Array.isArray(table.days)) return null
    return table.days.find((entry) => entry.date === day) || null
  }

  /** Classify one day: { off, holiday, name, weekend, makeup }. */
  function dayKind(facts, day, settings) {
    const weekend = [0, 6].includes(new Date(dayNumUtc(day) * 86400000).getUTCDay())
    const entry = holidayEntry(facts, day)
    const skipWeekends = settings?.workdaysOnly !== false
    if (entry) {
      // 班 marks a weekend that is worked; 休 marks a holiday that is not.
      const off = entry.off
      return {
        day,
        off,
        weekend,
        makeup: off === false && weekend,
        holiday: off === true,
        name: entry.name || '',
      }
    }
    return { day, off: weekend && skipWeekends, weekend, makeup: false, holiday: false, name: '' }
  }

  /**
   * First working day on or after `day`. Used to keep new tasks off weekends
   * and holidays unless the user explicitly disagrees.
   */
  function nextWorkday(facts, day, settings) {
    let cursor = day
    for (let guard = 0; guard < 370; guard += 1) {
      if (!dayKind(facts, cursor, settings).off) return cursor
      cursor = addDays(cursor, 1)
    }
    return day
  }

  /** Working days between two inclusive days. */
  function countWorkdays(facts, from, to, settings) {
    if (dayDiff(from, to) < 0) return 0
    let count = 0
    let cursor = from
    for (let guard = 0; guard <= dayDiff(from, to) && guard < 4000; guard += 1) {
      if (!dayKind(facts, cursor, settings).off) count += 1
      cursor = addDays(cursor, 1)
    }
    return count
  }

  /** All classified days in a month, for the calendar grid. */
  function monthDays(facts, month, settings) {
    const [year, mon] = String(month).split('-').map(Number)
    if (!Number.isFinite(year) || !Number.isFinite(mon)) return []
    const last = new Date(Date.UTC(year, mon, 0)).getUTCDate()
    const rows = []
    for (let d = 1; d <= last; d += 1) {
      const day = `${year}-${String(mon).padStart(2, '0')}-${String(d).padStart(2, '0')}`
      rows.push(dayKind(facts, day, settings))
    }
    return rows
  }

  /** UTC day number for a `YYYY-MM-DD` string. */
  function dayNumUtc(day) {
    const [y, m, d] = String(day).split('-').map(Number)
    return Math.round(Date.UTC(y, m - 1, d) / 86400000)
  }

  /** Group tasks into the three buckets the UI and the tool both need. */
  function digest(state, day = dayOf()) {
    const active = state.tasks.filter((task) => task.status !== 'done')
    // An open-ended task covers every day from its start onward.
    const covers = (task, when) => dayDiff(task.start, when) >= 0 && (!task.end || dayDiff(when, task.end) >= 0)
    const today = active.filter((task) => covers(task, day))
    // Only a real, past deadline can be overdue.
    const overdue = active.filter((task) => Boolean(task.end) && dayDiff(task.end, day) > 0)
    const upcoming = active
      .filter((task) => dayDiff(day, task.start) > 0 && dayDiff(day, task.start) <= 7)
      .sort((a, b) => (a.start < b.start ? -1 : 1))
    return { today, overdue, upcoming }
  }

  function recordStats(state, day = dayOf()) {
    const byDay = new Map()
    for (const record of state.records) {
      const bucket = byDay.get(record.date) || { date: record.date, minutes: 0, count: 0 }
      bucket.minutes += record.minutes || 0
      bucket.count += 1
      byDay.set(record.date, bucket)
    }
    const last30 = []
    for (let i = 29; i >= 0; i -= 1) {
      const date = addDays(day, -i)
      last30.push(byDay.get(date) || { date, minutes: 0, count: 0 })
    }
    return {
      today: byDay.get(day) || { date: day, minutes: 0, count: 0 },
      last30,
      totalMinutes: state.records.reduce((sum, record) => sum + (record.minutes || 0), 0),
    }
  }

  /**
   * Time spent per task, derived from the status history.
   *
   * Only states that represent actual work accrue time: `doing` counts.
   * `todo`, `blocked` and `done` are paused or finished, so a task blocked for
   * a week does not inflate its working time — which is the whole point of
   * marking it blocked.
   */
  function taskDurations(state, now = Date.now()) {
    const WORKING = new Set(['doing'])
    const rows = []
    for (const task of state.tasks) {
      const history = Array.isArray(task.history) && task.history.length
        ? task.history
        : [{ status: task.status, at: task.createdAt || nowIso() }]
      let workingMs = 0
      let pausedMs = 0
      for (let i = 0; i < history.length; i += 1) {
        const entered = Date.parse(history[i].at)
        if (!Number.isFinite(entered)) continue
        const until = i + 1 < history.length ? Date.parse(history[i + 1].at) : now
        const span = Math.max(0, (Number.isFinite(until) ? until : now) - entered)
        if (WORKING.has(history[i].status)) workingMs += span
        else if (history[i].status === 'blocked') pausedMs += span
      }
      const startedAt = history.find((entry) => entry.status === 'doing')?.at || null
      const finishedAt = history.find((entry) => entry.status === 'done')?.at || task.doneAt || null
      rows.push({
        taskId: task.id,
        title: task.title,
        project: task.project || task.group || '未分组',
        color: task.color || null,
        status: task.status,
        workingMinutes: Math.round(workingMs / 60000),
        blockedMinutes: Math.round(pausedMs / 60000),
        startedAt,
        finishedAt,
        // Calendar days from first "doing" to "done" (or now), inclusive.
        leadDays: startedAt
          ? Math.max(1, dayDiff(dayOf(new Date(startedAt)), dayOf(new Date(finishedAt || now))) + 1)
          : null,
        checkinDays: (state.checkins || []).filter((row) => row.taskId === task.id).length,
      })
    }
    return rows.sort((a, b) => b.workingMinutes - a.workingMinutes)
  }

  /** Per-project rollup used by the summary view. */
  function projectRollup(state) {
    const durations = taskDurations(state)
    const byProject = new Map()
    for (const row of durations) {
      const bucket = byProject.get(row.project) || {
        project: row.project,
        tasks: 0,
        done: 0,
        workingMinutes: 0,
        blockedMinutes: 0,
      }
      bucket.tasks += 1
      if (row.status === 'done') bucket.done += 1
      bucket.workingMinutes += row.workingMinutes
      bucket.blockedMinutes += row.blockedMinutes
      byProject.set(row.project, bucket)
    }
    return [...byProject.values()].sort((a, b) => b.workingMinutes - a.workingMinutes)
  }

  /** Today's check-in state, for the dock's "did I do this today" list. */
  function checkinView(state, day = dayOf()) {
    const rows = state.checkins || []
    const marked = new Set(rows.filter((row) => row.date === day).map((row) => row.taskId))
    return { day, marked: [...marked], total: rows.filter((row) => row.date === day).length }
  }

  /**
   * Groups are a first-class grouping of tasks, separate from `project`.
   * A project is the workstream a task belongs to; a group is how the user
   * wants the board chunked right now ("本周必做", "等对方回复"). Tasks carry a
   * group name (free text, like project), and the store maintains the ordered
   * list so a group survives even while it has no tasks.
   */
  /* ------------------------------ phases ------------------------------ */

  /**
   * Phases are dated milestones that belong to ONE project.
   *
   * A project here is a task — the top-level piece of work the user tracks
   * ("智能课程开发", "雷达车底座测试"). Its phases record what each stretch of
   * that project delivered, which is what a long-running project is remembered
   * by. Phases therefore key on the task id, not on a group label: grouping is
   * an organising device, the project is the thing being delivered.
   */
  function normalizePhase(input, base, taskId) {
    const previous = base || {}
    const start = normalizeDay(input?.start, previous.start || dayOf())
    const rawEnd = normalizeDay(input?.end, previous.end || start)
    const end = dayDiff(start, rawEnd) < 0 ? start : rawEnd
    return {
      ...previous,
      id: previous.id || randomUUID(),
      taskId: previous.taskId || taskId,
      name: clampText(input?.name ?? previous.name ?? '', 60).trim() || '未命名阶段',
      start,
      end,
      // What this phase delivered. This is the point of the feature.
      outcome: clampText(input?.outcome ?? previous.outcome ?? '', 2000),
      status: ['planned', 'active', 'done'].includes(input?.status)
        ? input.status
        : previous.status || 'planned',
      createdAt: previous.createdAt || nowIso(),
      updatedAt: nowIso(),
    };
  }

  /** Every phase with the project it belongs to and its derived progress. */
  function phaseList(state) {
    return (state.phases || []).map((phase) => {
      const project = state.tasks.find((task) => task.id === phase.taskId) || null
      const today = dayOf()
      // A phase counts as done when marked so, or when its window has passed.
      const span = dayDiff(phase.start, phase.end) + 1
      const elapsed = dayDiff(phase.start, today) + 1
      const timed = Math.max(0, Math.min(100, Math.round((elapsed / Math.max(1, span)) * 100)))
      return {
        ...phase,
        projectTitle: project ? project.title : '（项目已删除）',
        projectMissing: !project,
        // A finished phase is 100%; otherwise progress is how far through its
        // own window it is, which is the honest reading for a dated stage.
        progress: phase.status === 'done' ? 100 : timed,
        current: dayDiff(phase.start, today) >= 0 && dayDiff(today, phase.end) >= 0,
        overdue: dayDiff(phase.end, today) > 0 && phase.status !== 'done',
      }
    })
  }

  async function phaseAction(state, input) {
    const action = String(input.phaseAction || input.op || '')
    state.phases = Array.isArray(state.phases) ? state.phases : []
    const taskId = String(input.taskId || input.projectId || '')
    const id = String(input.id || '')

    if (action === 'create') {
      // A phase must attach to a real project.
      const project = state.tasks.find((task) => task.id === taskId)
      if (!project) throw new Error('阶段必须属于一个项目（需要有效的 taskId）')
      const phase = normalizePhase(input, null, taskId)
      state.phases.push(phase)
      return phase
    }
    if (action === 'update') {
      const index = state.phases.findIndex((phase) => phase.id === id)
      if (index === -1) throw new Error('阶段不存在：' + id)
      const current = state.phases[index]
      // Moving a phase to another project is allowed.
      const next = normalizePhase(input, current, current.taskId)
      if (taskId && taskId !== current.taskId) {
        if (!state.tasks.some((task) => task.id === taskId)) throw new Error('目标项目不存在')
        next.taskId = taskId
      }
      state.phases[index] = next
      return next
    }
    if (action === 'delete') {
      const target = state.phases.find((phase) => phase.id === id)
      if (!target) throw new Error('阶段不存在：' + id)
      state.phases = state.phases.filter((phase) => phase.id !== id)
      return target
    }
    throw new Error('未知阶段操作：' + (action || '(空)'))
  }

  function groupList(state) {
    const counts = new Map()
    const doneCounts = new Map()
    for (const task of state.tasks) {
      const name = task.group || ''
      if (!name) continue
      counts.set(name, (counts.get(name) || 0) + 1)
      if (task.status === 'done') doneCounts.set(name, (doneCounts.get(name) || 0) + 1)
    }
    const declared = Array.isArray(state.groups) ? state.groups : []
    const names = new Set([...declared.map((group) => group.name), ...counts.keys()])
    return [...names].map((name) => {
      const meta = declared.find((group) => group.name === name)
      return {
        name,
        order: meta?.order ?? 999,
        // Default true: a group is everyday work unless marked otherwise.
        focus: meta ? meta.focus !== false : true,
        tasks: counts.get(name) || 0,
        done: doneCounts.get(name) || 0,
      }
    }).sort((a, b) => {
      // Focused groups first, so the everyday list stays on top.
      if (a.focus !== b.focus) return a.focus ? -1 : 1
      return a.order - b.order || a.name.localeCompare(b.name)
    })
  }

  /** Create, rename and delete groups; deleting a group detaches its tasks. */
  async function groupAction(state, input) {
    const action = String(input.groupAction || input.op || '')
    const name = clampText(input.name ?? input.group ?? '', 40).trim()
    state.groups = Array.isArray(state.groups) ? state.groups : []

    if (action === 'create') {
      if (!name) throw new Error('分组名不能为空')
      if (state.groups.some((group) => group.name === name)) throw new Error('分组已存在：' + name)
      state.groups.push({
        name,
        order: state.groups.length,
        // Non-focus groups are long-term follow-ups.
        focus: input.focus === undefined ? true : Boolean(input.focus),
        createdAt: nowIso(),
      })
      return
    }
    if (action === 'focus') {
      // Toggle whether a group counts as everyday work.
      if (!name) throw new Error('需要分组名')
      const group = state.groups.find((item) => item.name === name)
      const focus = input.focus === undefined ? true : Boolean(input.focus)
      if (group) group.focus = focus
      else state.groups.push({ name, order: state.groups.length, focus, createdAt: nowIso() })
      return
    }
    if (action === 'rename') {
      const from = clampText(input.from ?? input.oldName ?? '', 40).trim()
      if (!from || !name) throw new Error('需要 from 和 name')
      const group = state.groups.find((item) => item.name === from)
      if (group) group.name = name
      else state.groups.push({ name, order: state.groups.length, createdAt: nowIso() })
      for (const task of state.tasks) if (task.group === from) task.group = name
      return
    }
    if (action === 'delete') {
      state.groups = state.groups.filter((group) => group.name !== name)
      // Tasks outlive their group: only the label is cleared.
      for (const task of state.tasks) if (task.group === name) task.group = ''
      return
    }
    if (action === 'reorder') {
      const order = Array.isArray(input.order) ? input.order.map(String) : []
      state.groups = order
        .map((item, index) => {
          const existing = state.groups.find((group) => group.name === item)
          return { name: item, order: index, focus: existing?.focus !== false, createdAt: existing?.createdAt || nowIso() }
        })
      return
    }
    throw new Error('未知分组操作：' + (action || '(空)'))
  }

  /**
   * Workstream rollup. A task's label is its project, else its group — people
   * often file work into a group and leave the project empty, and collapsing
   * those into 未分组 made a correctly-grouped task look unfiled.
   */
  function projectList(state) {
    const counts = new Map()
    for (const task of state.tasks) {
      const name = task.project || task.group || '未分组'
      counts.set(name, (counts.get(name) || 0) + 1)
    }
    return [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count)
  }

  /**
   * Ids of tasks that belong on the everyday surfaces. A task in a non-focus
   * group is a long-term follow-up: it still exists, still shows in the Gantt
   * view and still counts in summaries, but it is not pushed at the user every
   * day. Ungrouped tasks are always in focus.
   */
  function focusTaskIds(state) {
    const groups = groupList(state)
    const sidelined = new Set(groups.filter((group) => group.focus === false).map((group) => group.name))
    return state.tasks
      .filter((task) => !sidelined.has(task.group || ''))
      .map((task) => task.id)
  }

  function snapshot(state, day = dayOf(), input = {}) {
    return {
      tasks: state.tasks,
      records: state.records,
      checkins: state.checkins || [],
      settings: state.settings,
      projects: projectList(state),
      groups: groupList(state),
      phases: phaseList(state),
      // Which tasks count as everyday work; the dock and the calendar completion
      // log filter on this, while the Gantt view ignores it.
      focusTaskIds: focusTaskIds(state),
      calendar: (() => {
        // The board pages through months; classify whichever one it shows.
        const requested = /^\d{4}-\d{2}$/.test(String(input.month || ''))
          ? String(input.month)
          : String(day).slice(0, 7)
        return {
          month: requested,
          days: monthDays(calendarFacts(state), requested, state.settings),
        }
      })(),
      digest: digest(state, day),
      stats: recordStats(state, day),
      durations: taskDurations(state),
      rollup: projectRollup(state),
      checkin: checkinView(state, day),
      today: day,
      storeFile: stateFile,
      warnings: state.warnings || [],
    }
  }

  /* ---------------------------- mutations ---------------------------- */

  function findTask(state, id) {
    const task = state.tasks.find((item) => item.id === id)
    if (!task) throw new Error(`任务不存在：${id}`)
    return task
  }

  async function run(input = {}) {
    const action = String(input.action || 'snapshot')
    const state = await load()
    const day = normalizeDay(input.day, dayOf())

    switch (action) {
      case 'snapshot':
        return snapshot(state, day, input)

      case 'task.create': {
        const patch = pickPatch(input, TASK_FIELDS)
        // Default the start onto a working day. An explicit start always wins,
        // and so does an explicit opt-out for this task.
        if (patch.start === undefined && state.settings.workdaysOnly !== false) {
          patch.start = nextWorkday(calendarFacts(state), dayOf(), state.settings)
        }
        if (patch.start && patch.end === undefined && state.settings.workdaysOnly !== false) {
          // A single-day default should also land on a working day.
          patch.end = nextWorkday(calendarFacts(state), normalizeDay(patch.start, dayOf()), state.settings)
        }
        const task = normalizeTask(patch, { id: randomUUID() })
        state.tasks.push(task)
        await persist(state)
        return { task, ...snapshot(state, day) }
      }

      case 'task.update': {
        const index = state.tasks.findIndex((item) => item.id === input.id)
        if (index === -1) throw new Error(`任务不存在：${input.id}`)
        const task = normalizeTask(pickPatch(input, TASK_FIELDS), state.tasks[index])
        state.tasks[index] = task
        await persist(state)
        return { task, ...snapshot(state, day) }
      }

      case 'task.move': {
        // Drag from the Gantt board: shift both ends by an integer day count,
        // or pin one end for a resize gesture.
        const task = findTask(state, input.id)
        const delta = Math.round(Number(input.delta) || 0)
        const openEnded = !task.end
        let start = task.start
        let end = task.end
        if (input.edge === 'start') start = addDays(task.start, delta)
        else if (input.edge === 'end' && end) end = addDays(end, delta)
        else {
          start = addDays(task.start, delta)
          // An open-ended task has no far edge to move; only start travels.
          if (end) end = addDays(end, delta)
        }
        if (end && dayDiff(start, end) < 0) {
          if (input.edge === 'start') start = end
          else end = start
        }
        void openEnded
        const moved = normalizeTask({ start, end }, task)
        state.tasks[state.tasks.indexOf(task)] = moved
        await persist(state)
        return { task: moved, ...snapshot(state, day) }
      }

      case 'task.delete': {
        findTask(state, input.id)
        state.tasks = state.tasks.filter((item) => item.id !== input.id)
        // A phase without its project has no owner: drop it with the project.
        if (Array.isArray(state.phases)) {
          state.phases = state.phases.filter((phase) => phase.taskId !== input.id)
        }
        // Records survive their task: the log is history, the task is a plan.
        for (const record of state.records) if (record.taskId === input.id) record.taskId = null
        await persist(state)
        return snapshot(state, day)
      }

      case 'task.bulk': {
        // Batch edits over an explicit id list: the board's multi-select and
        // the agent both drive this. Every id must exist, so a stale selection
        // reports the problem instead of silently skipping rows.
        const ids = Array.isArray(input.ids) ? [...new Set(input.ids.map(String))] : []
        if (!ids.length) throw new Error('没有选中任务')
        const wanted = new Set(ids)
        const known = new Set(state.tasks.map((task) => task.id))
        const missing = ids.filter((id) => !known.has(id))
        if (missing.length) throw new Error('任务不存在：' + missing.join(', '))

        const op = String(input.op || input.operation || '').trim()
        const patch = pickPatch(input, TASK_FIELDS)
        const delta = Math.round(Number(input.delta) || 0)
        const hasPatch = Object.keys(patch).length > 0
        if (!op && !hasPatch) throw new Error('批量操作需要 op 或要修改的字段')
        if (op === 'move' && !delta) throw new Error('批量移动需要 delta（整数天）')

        // Compute replacements first, then apply, so a validation error cannot
        // leave a half-edited selection.
        const replacements = new Map()
        for (const task of state.tasks) {
          if (!wanted.has(task.id)) continue
          if (op === 'delete') { replacements.set(task.id, null); continue }
          if (op === 'move') {
            replacements.set(task.id, normalizeTask({
              start: addDays(task.start, delta),
              end: task.end ? addDays(task.end, delta) : null,
            }, task))
            continue
          }
          if (op === 'complete') { replacements.set(task.id, normalizeTask({ status: 'done' }, task)); continue }
          if (op === 'reopen') { replacements.set(task.id, normalizeTask({ status: 'todo', doneAt: null }, task)); continue }
          if (op === 'set' || (op === '' && hasPatch)) { replacements.set(task.id, normalizeTask(patch, task)); continue }
          throw new Error('未知批量操作：' + op)
        }

        if (op === 'delete') {
          state.tasks = state.tasks.filter((task) => !wanted.has(task.id))
          for (const record of state.records) if (record.taskId && wanted.has(record.taskId)) record.taskId = null
        } else {
          for (const [id, next] of replacements) {
            const index = state.tasks.findIndex((task) => task.id === id)
            if (index !== -1) state.tasks[index] = next
          }
        }

        await persist(state)
        return { changed: replacements.size, ...snapshot(state, day) }
      }

      case 'record.create': {
        if (!String(pickPatch(input, RECORD_FIELDS).content ?? '').trim()) throw new Error('记录内容不能为空')
        const record = normalizeRecord(pickPatch(input, RECORD_FIELDS), { id: randomUUID() })
        state.records.push(record)
        await persist(state)
        return { record, ...snapshot(state, day) }
      }

      case 'record.update': {
        const index = state.records.findIndex((item) => item.id === input.id)
        if (index === -1) throw new Error(`记录不存在：${input.id}`)
        const record = normalizeRecord(pickPatch(input, RECORD_FIELDS), state.records[index])
        state.records[index] = record
        await persist(state)
        return { record, ...snapshot(state, day) }
      }

      case 'record.delete': {
        state.records = state.records.filter((item) => item.id !== input.id)
        await persist(state)
        return snapshot(state, day)
      }

      /**
       * Daily check-ins: "I worked on this task today". Deliberately separate
       * from task.status — a task can span weeks, be done overall, or be
       * blocked, while the question here is only "did I touch it today".
       * Idempotent per (taskId, date) so toggling is safe.
       */
      case 'checkin.set': {
        const taskId = String(input.taskId || input.id || '')
        if (!taskId) throw new Error('缺少 taskId')
        const task = findTask(state, taskId)
        const date = normalizeDay(input.date, dayOf())
        const wanted = input.done === undefined ? true : Boolean(input.done)
        state.checkins = Array.isArray(state.checkins) ? state.checkins : []
        state.checkins = state.checkins.filter((row) => !(row.taskId === taskId && row.date === date))
        if (wanted) {
          state.checkins.push({
            id: randomUUID(),
            taskId,
            date,
            minutes: Math.max(0, Math.min(1440, Math.round(Number(input.minutes) || 0))),
            createdAt: nowIso(),
          })
          // A check-in on a not-started task implicitly starts it, so the board
          // never shows "worked today" on something still marked 待开始.
          if (task.status === 'todo') {
            const index = state.tasks.findIndex((item) => item.id === taskId)
            state.tasks[index] = normalizeTask({ status: 'doing' }, task)
          }
        }
        await persist(state)
        return { taskId, date, done: wanted, ...snapshot(state, day) }
      }

      case 'checkin.toggle': {
        const taskId = String(input.taskId || input.id || '')
        if (!taskId) throw new Error('缺少 taskId')
        const task = findTask(state, taskId)
        const date = normalizeDay(input.date, dayOf())
        state.checkins = Array.isArray(state.checkins) ? state.checkins : []
        const existing = state.checkins.find((row) => row.taskId === taskId && row.date === date)
        if (existing) {
          state.checkins = state.checkins.filter((row) => row !== existing)
          await persist(state)
          return { taskId, date, done: false, ...snapshot(state, day) }
        }
        state.checkins.push({
          id: randomUUID(),
          taskId,
          date,
          minutes: Math.max(0, Math.min(1440, Math.round(Number(input.minutes) || 0))),
          createdAt: nowIso(),
        })
        if (task.status === 'todo') {
          const index = state.tasks.findIndex((item) => item.id === taskId)
          state.tasks[index] = normalizeTask({ status: 'doing' }, task)
        }
        await persist(state)
        return { taskId, date, done: true, ...snapshot(state, day) }
      }

      case 'group': {
        await groupAction(state, input)
        await persist(state)
        return snapshot(state, day)
      }

      /**
       * Refresh the holiday table from the upstream dataset.
       *
       * The bundled holidays.json covers a few years; this pulls the current
       * year (and the next, once published) so a new year's notice arrives
       * without shipping a plugin update. Everything is cached in the store,
       * so a network failure leaves the existing table untouched.
       */
      case 'holidays.refresh': {
        const years = input.years && Array.isArray(input.years)
          ? input.years.map(String)
          : [String(new Date().getFullYear()), String(new Date().getFullYear() + 1)]
        const results = []
        const merged = { ...(state.holidays || {}) }
        merged.years = { ...(merged.years || {}) }
        for (const year of years) {
          try {
            const response = await fetch(`https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/${year}.json`, {
              headers: { accept: 'application/json' },
              signal: AbortSignal.timeout(8000),
            })
            if (!response.ok) { results.push({ year, ok: false, reason: `HTTP ${response.status}` }); continue }
            const data = await response.json()
            if (!data || !Array.isArray(data.days)) { results.push({ year, ok: false, reason: '数据格式不符' }); continue }
            merged.years[year] = {
              paper: (data.papers || [])[0] || null,
              days: data.days.map((day) => ({ date: day.date, name: day.name, off: Boolean(day.isOffDay) })),
            }
            results.push({ year, ok: true, days: data.days.length })
          } catch (error) {
            results.push({ year, ok: false, reason: error?.message || String(error) })
          }
        }
        merged.source = 'https://github.com/NateScarlet/holiday-cn'
        merged.builtAt = nowIso()
        state.holidays = merged
        await persist(state)
        return { results, ...snapshot(state, day) }
      }

      case 'phase': {
        const result = await phaseAction(state, input)
        await persist(state)
        return { phase: result, ...snapshot(state, day) }
      }

      case 'summary': {
        return {
          day,
          rollup: projectRollup(state),
          durations: taskDurations(state),
          checkin: checkinView(state, day),
          counts: {
            tasks: state.tasks.length,
            done: state.tasks.filter((task) => task.status === 'done').length,
            active: state.tasks.filter((task) => task.status !== 'done').length,
            blocked: state.tasks.filter((task) => task.status === 'blocked').length,
          },
        }
      }

      case 'settings.update':
      case 'config': {
        const patch = input.settings || input.patch || {}
        if (patch.digestAt !== undefined) state.settings.digestAt = normalizeTime(patch.digestAt, state.settings.digestAt)
        if (patch.defaultLead !== undefined) state.settings.defaultLead = Math.max(0, Math.min(1440, Number(patch.defaultLead) || 0))
        if (patch.floatEnabled !== undefined) state.settings.floatEnabled = Boolean(patch.floatEnabled)
        if (patch.sortBy !== undefined) state.settings.sortBy = ['start', 'priority', 'project', 'status'].includes(patch.sortBy) ? patch.sortBy : state.settings.sortBy
        if (patch.dayWidth !== undefined) state.settings.dayWidth = Math.max(14, Math.min(64, Number(patch.dayWidth) || 26))
        if (patch.workdaysOnly !== undefined) state.settings.workdaysOnly = Boolean(patch.workdaysOnly)
        await persist(state)
        return snapshot(state, day)
      }

      default:
        throw new Error(`未知操作：${action}`)
    }
  }

  return { run, snapshot: async (day) => snapshot(await load(), day), stateFile }
}

export const inject = ['tools', 'webServer']

export function apply(ctx, config) {
  const store = makeStore(config)

  const route = ctx.webServer.register({
    kind: 'exact',
    path: '/api/worklog-calendar',
    handler: async (req, res) => {
      const send = (value, status = 200) => {
        const body = JSON.stringify(value)
        res.writeHead(status, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'content-length': Buffer.byteLength(body),
        })
        res.end(req.method === 'HEAD' ? undefined : body)
      }
      try {
        if (req.method === 'GET' || req.method === 'HEAD') {
          const url = new URL(req.url || '/', 'http://localhost')
          send(await store.run({
            action: url.searchParams.get('action') || 'snapshot',
            day: url.searchParams.get('day') || undefined,
            // The board pages through months; without forwarding this the host
            // always classified the reference day's month, so holidays never
            // appeared after switching months.
            month: url.searchParams.get('month') || undefined,
          }))
          return
        }
        if (req.method !== 'POST') {
          res.writeHead(405, { allow: 'GET, HEAD, POST' })
          res.end()
          return
        }
        // Bodies are small (one task or record); cap them so a runaway client
        // cannot exhaust memory.
        const chunks = []
        let size = 0
        for await (const chunk of req) {
          size += chunk.length
          if (size > 256 * 1024) throw new Error('请求体过大')
          chunks.push(chunk)
        }
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
        send(await store.run(payload))
      } catch (error) {
        send({ error: error?.message || String(error) }, 400)
      }
    },
  })

  const unregister = ctx.tools.register({
    name: 'worklog',
    description:
      'Read and write the user\'s work-log calendar (tasks on a Gantt board plus dated work records). ' +
      'Actions: "snapshot" reads tasks, records, today\'s digest and stats; "task.create"/"task.update"/"task.move"/"task.delete" manage planned tasks; ' +
      '"record.create"/"record.update"/"record.delete" manage dated work-log entries; "settings.update" changes reminder preferences. ' +
      'Dates are local calendar days in YYYY-MM-DD, start/end are inclusive.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: [
            'snapshot', 'task.create', 'task.update', 'task.move', 'task.delete', 'task.bulk',
            'record.create', 'record.update', 'record.delete', 'settings.update', 'config',
            'checkin.set', 'checkin.toggle', 'summary', 'group', 'holidays.refresh', 'phase',
          ],
          description: 'Operation to perform.',
        },
        id: { type: 'string', description: 'Task or record id for update/move/delete.' },
        ids: { type: 'array', items: { type: 'string' }, description: 'Task ids for task.bulk.' },
        op: { type: 'string', enum: ['set', 'move', 'complete', 'reopen', 'delete'], description: 'For task.bulk: what to do with every selected task.' },
        done: { type: 'boolean', description: 'For checkin.set: whether the task was worked on that day.' },
        day: { type: 'string', description: 'Reference day for the digest and stats (YYYY-MM-DD); defaults to today.' },
        edge: { type: 'string', enum: ['start', 'end'], description: 'For task.move: pin one edge while shifting the other; omit to shift both.' },
        delta: { type: 'number', description: 'For task.move: whole days to shift.' },
        title: { type: 'string', description: 'Task title.' },
        detail: { type: 'string', description: 'Task notes.' },
        project: { type: 'string', description: 'Project or workstream name.' },
        group: { type: 'string', description: 'Grouping label used to chunk the board, independent of project.' },
        groupAction: { type: 'string', enum: ['create', 'rename', 'delete', 'reorder', 'focus'], description: 'For action "group". "focus" marks a group as everyday work (true) or a long-term follow-up hidden from the dock and calendar (false).' },
        phaseAction: { type: 'string', enum: ['create', 'update', 'delete'], description: 'For action "phase": manage dated phases of ONE project (the project is a task; pass its taskId).' },
        phaseId: { type: 'string', description: 'Phase id for phase update/delete (same as id).' },
        start: { type: 'string', description: 'Phase start day (YYYY-MM-DD).' },
        outcome: { type: 'string', description: 'What the phase delivered; the record a long project is remembered by.' },
        focus: { type: 'boolean', description: 'For group create/focus: whether the group is everyday work. Default true.' },
        from: { type: 'string', description: 'For group rename: the existing name.' },
        name: { type: 'string', description: 'For group create/rename/delete: the group name.' },
        order: { type: 'array', items: { type: 'string' }, description: 'For group reorder: group names in display order.' },
        start: { type: 'string', description: 'Task start day (YYYY-MM-DD).' },
        end: { type: 'string', description: 'Task end day (YYYY-MM-DD, inclusive).' },
        status: { type: 'string', enum: ['todo', 'doing', 'blocked', 'done'], description: 'Task status.' },
        priority: { type: 'string', enum: ['low', 'normal', 'high'], description: 'Task priority.' },
        progress: { type: 'number', description: 'Completion percentage 0-100.' },
        remindAt: { type: 'string', description: 'Local reminder instant (YYYY-MM-DDTHH:mm).' },
        content: { type: 'string', description: 'Work-log entry text.' },
        minutes: { type: 'number', description: 'Work-log entry duration in minutes.' },
        taskId: { type: 'string', description: 'Task a record belongs to.' },
        date: { type: 'string', description: 'Record day (YYYY-MM-DD).' },
        settings: { type: 'object', additionalProperties: true, description: 'Settings patch for settings.update.' },
      },
      required: ['action'],
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      return await store.run(args || {})
    },
  })

  ctx.effect(() => () => {
    route()
    unregister()
  }, 'worklog-calendar resources')
}
