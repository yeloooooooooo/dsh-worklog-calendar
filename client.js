window.__ModuleLoader__.load({
  id: 'dsh-worklog-calendar',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } = React;

    /* ------------------------------------------------------------------ *
     * Small date utilities
     * All day arithmetic runs on integer day numbers derived from UTC
     * midnight, so a local DST shift can never move a bar by one day.
     * ------------------------------------------------------------------ */

    const pad2 = (n) => String(n).padStart(2, '0');
    const dayOf = (date = new Date()) =>
      `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
    const dayNum = (day) => {
      const [y, m, d] = String(day).split('-').map(Number);
      return Math.round(Date.UTC(y, m - 1, d) / 86400000);
    };
    const numDay = (n) => {
      const date = new Date(n * 86400000);
      return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
    };
    const addDays = (day, count) => numDay(dayNum(day) + count);
    const diffDays = (from, to) => dayNum(to) - dayNum(from);
    const weekday = (day) => ['日', '一', '二', '三', '四', '五', '六'][new Date(dayNum(day) * 86400000).getUTCDay()];
    const isWeekend = (day) => [0, 6].includes(new Date(dayNum(day) * 86400000).getUTCDay());
    const monthOf = (day) => day.slice(0, 7);
    // A task covers every day from its start; without an end it never closes.
    const covers = (task, day) => diffDays(task.start, day) >= 0 && (!task.end || diffDays(day, task.end) >= 0);
    const isOverdue = (task, day) => task.status !== 'done' && Boolean(task.end) && diffDays(task.end, day) > 0;
    const formatMinutes = (minutes) => {
      const total = Math.max(0, Math.round(minutes || 0));
      if (total < 60) return `${total} 分钟`;
      const hours = Math.floor(total / 60);
      const rest = total % 60;
      return rest ? `${hours} 小时 ${rest} 分` : `${hours} 小时`;
    };
    const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

    const STATUS = {
      todo: { label: '待开始', tone: 'todo' },
      doing: { label: '进行中', tone: 'doing' },
      blocked: { label: '受阻', tone: 'blocked' },
      done: { label: '已完成', tone: 'done' },
    };
    const PRIORITY = { low: '低', normal: '中', high: '高' };

    /** Fallback palette; an explicit task.color always wins. */
    const PALETTE = [
      '#4f6ef7', '#12a06a', '#d2691e', '#8b5cf6',
      '#0e9aa7', '#d94a6a', '#b58900', '#5a6b7b',
      '#7c5cd6', '#2f9e6f', '#c05621', '#2c7fb8',
    ];

    /**
     * Assign colours by first-seen order rather than by hashing the name.
     * A hash collides: distinct project names can map to the same blue, which is
     * exactly the case where the colours failed to tell workstreams apart.
     * Sequential assignment guarantees distinct colours for distinct names as
     * long as there are fewer names than palette entries.
     */
    const makeColorBook = () => {
      const assigned = new Map();
      return (name) => {
        const key = String(name || '未分组');
        if (!assigned.has(key)) assigned.set(key, PALETTE[assigned.size % PALETTE.length]);
        return assigned.get(key);
      };
    };
    /**
     * Colour for a task: an explicit choice wins, otherwise the project, then
     * the group. Group is checked too because grouping is what people actually
     * fill in — keying only on project left every task the same colour.
     */
    /** Solid form of a task colour, for borders and accents. */
    const colorMixin = (color, percent) => `color-mix(in srgb, ${color} ${percent}%, transparent)`;

    /**
     * Fill strength for a bar, 0-100. This is *the* visual encoding of progress:
     * colour depth, not a thin overlay line, so a glance across the chart reads
     * as "how far along is each thing".
     */
    const barFill = (task) => {
      if (task.status === 'done') return 100;
      // Bars carry their project colour at a readable depth; progress is drawn
      // separately so an unfinished task never looks washed out.
      const progress = Math.max(0, Math.min(100, Number(task.progress) || 0));
      return Math.round(62 + progress * 0.32);
    };

    /** Label a task is coloured by: project first, then group, then 未分组. */
    const labelOf = (task) => String(task.project || task.group || '未分组');
    // Default resolver for code paths without a board-owned book (the dock).
    const fallbackBook = makeColorBook();
    const colorOf = (task) => task.color || fallbackBook(labelOf(task));

    /**
     * Effective status at a given day. A task whose start day has arrived is
     * "in progress" without the user flipping a switch — work that has begun
     * should not sit in 待开始. Explicit states (blocked / done) always win, and
     * nothing is ever auto-completed: finishing stays a human decision.
     */
    const statusAt = (task, day) => {
      if (task.status === 'blocked' || task.status === 'done') return task.status;
      if (diffDays(task.start, day) >= 0) return 'doing';
      return task.status;
    };
    // Is the task running on its own by now, rather than flagged by the user?
    const autoStarted = (task, day) => task.status === 'todo' && statusAt(task, day) === 'doing';

    const css = `
.wl-root{--wl-phase-late:#e5484d;position:relative;height:100%;min-height:0;display:flex;flex-direction:column;box-sizing:border-box;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;overflow:hidden}
.wl-root *{box-sizing:border-box}
.wl-root button{font:inherit;cursor:pointer;color:inherit}
.wl-head{display:flex;align-items:center;gap:14px;flex-wrap:wrap;padding:14px 24px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);flex-shrink:0}
.wl-brand{display:flex;align-items:center;gap:9px;font-size:14px;font-weight:750;letter-spacing:-.01em}
.wl-mark{width:24px;height:24px;border-radius:8px;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);display:grid;place-items:center;font-size:13px}
.wl-head-actions{display:flex;align-items:center;gap:6px;margin-left:auto;flex-wrap:wrap}
.wl-btn{border:1.5px solid color-mix(in srgb,var(--dsw-alias-label-primary) 24%,transparent);background:var(--dsw-alias-bg-base);border-radius:9px;padding:7px 11px;font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-primary);transition:border-color .13s,background .13s,transform .06s;white-space:nowrap;cursor:pointer}
.wl-btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,var(--dsw-alias-bg-base))}
.wl-btn:active:not(:disabled){transform:scale(.98)}
.wl-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.wl-btn:disabled{opacity:.5;cursor:default}
.wl-btn.primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);font-weight:650}
.wl-btn.icon{padding:7px 9px;line-height:1}
.wl-btn.on{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,transparent);color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent)}
.wl-month{min-width:112px;text-align:center;font-size:13px;font-weight:650}
.wl-monthnav{display:inline-flex;align-items:center;gap:2px;border:1.5px solid var(--dsw-alias-brand-primary);border-radius:11px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,var(--dsw-alias-bg-layer-1));padding:2px;box-shadow:0 1px 4px color-mix(in srgb,var(--dsw-alias-brand-primary) 22%,transparent)}
.wl-nav-btn{border:0;background:transparent;color:var(--dsw-alias-brand-primary);width:30px;height:28px;border-radius:8px;font-size:17px;font-weight:700;line-height:1;display:grid;place-items:center;cursor:pointer}
.wl-nav-btn:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 20%,transparent)}
.wl-nav-btn:active{transform:scale(.94)}
.wl-month-cur{display:inline-flex;align-items:center;gap:1px;padding:0 2px}
.wl-month-select{border:0;background:transparent;color:var(--dsw-alias-brand-primary);font:inherit;font-size:13.5px;font-weight:800;letter-spacing:-.01em;padding:4px 2px;border-radius:6px;cursor:pointer;outline:none}
.wl-month-select:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,transparent)}
.wl-month-select:focus{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent)}
.wl-select{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:9px;padding:7px 9px;font-size:12.5px}
.wl-stats{display:flex;gap:10px;padding:12px 24px 0;flex-wrap:wrap;flex-shrink:0}
.wl-stat{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:11px;padding:8px 13px;min-width:96px}
.wl-stat b{display:block;font-size:18px;font-weight:750;letter-spacing:-.02em;line-height:1.2}
.wl-stat span{color:var(--dsw-alias-label-secondary);font-size:11px}
.wl-stat.warn b{color:var(--dsw-alias-state-error-primary)}
.wl-body{flex:1;min-height:0;display:flex;padding:12px 24px 20px;gap:16px}
.wl-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:14px;min-height:0}
.wl-groups{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:0 24px 8px;flex-shrink:0}
.wl-phase-block{border:1.5px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 34%,transparent);border-left-width:4px;border-radius:10px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 5%,var(--dsw-alias-bg-base));padding:9px 10px;display:flex;flex-direction:column;gap:7px}
.wl-phase-block>label{font-size:11.5px;font-weight:750;color:var(--dsw-alias-brand-primary);letter-spacing:.02em;text-transform:none}
.wl-phase-add{border:1.5px dashed color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,transparent);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,transparent);color:var(--dsw-alias-brand-primary);border-radius:9px;padding:8px 10px;font-size:12px;font-weight:700;width:100%;cursor:pointer;transition:background .13s,border-color .13s}
.wl-phase-add:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,transparent);border-color:var(--dsw-alias-brand-primary)}
.wl-phase-edit{display:flex;flex-direction:column;gap:7px;padding:9px;border-radius:9px;border:1.5px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,transparent);background:var(--dsw-alias-bg-base)}
.wl-phase-actions{display:flex;gap:6px}
.wl-chip{border:1.5px solid color-mix(in srgb,var(--dsw-alias-label-primary) 26%,transparent);background:var(--dsw-alias-bg-base);border-radius:999px;padding:5px 11px;font-size:12px;color:var(--dsw-alias-label-primary);white-space:nowrap;cursor:pointer;transition:border-color .13s,background .13s}
.wl-chip:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.wl-phase{display:flex;flex-direction:column;gap:4px;padding:8px 9px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);margin-bottom:6px}
.wl-phase.current{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,transparent);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 7%,transparent)}
.wl-phase.done{opacity:.85}
.wl-phase.done .wl-phase-name{text-decoration:line-through;opacity:.75}
.wl-phase-top{display:flex;align-items:baseline;gap:6px;min-width:0}
.wl-phase-name{font-size:12.5px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}
.wl-phase-group{font-size:9.5px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border-radius:5px;padding:1px 5px;flex-shrink:0}
.wl-phase-when{font-size:10.5px;color:var(--dsw-alias-label-secondary);flex-shrink:0;font-variant-numeric:tabular-nums}
.wl-phase-bar{height:4px;border-radius:2px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.wl-phase-bar>i{display:block;height:100%;border-radius:2px;background:var(--dsw-alias-brand-primary)}
.wl-phase-meta{display:flex;align-items:center;gap:6px;font-size:10.5px;color:var(--dsw-alias-label-secondary)}
.wl-phase-late{color:var(--dsw-alias-state-error-primary);font-weight:700}
.wl-phase-act{margin-left:auto;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-size:11px;padding:0 2px;cursor:pointer;opacity:.7}
.wl-phase-act:hover{opacity:1;color:var(--dsw-alias-brand-primary)}
.wl-phase-act.danger:hover{color:var(--dsw-alias-state-error-primary)}
.wl-phase-outcome{font-size:11.5px;line-height:1.55;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word;padding-top:3px;border-top:1px dashed color-mix(in srgb,var(--dsw-alias-border-l1) 60%,transparent)}
.wl-group-chip{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:999px;padding:5px 11px;font-size:12px;color:var(--dsw-alias-label-primary)}
.wl-group-chip>span{cursor:pointer}
.wl-group-chip b{font-weight:600;opacity:.55;font-size:11px}
.wl-group-chip.on{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base)}
.wl-group-chip.on b{opacity:.8}
.wl-group-chip.all{cursor:pointer}
.wl-group-chip.sidelined{border-style:dashed;border-color:color-mix(in srgb,var(--dsw-alias-label-secondary) 55%,transparent);background:color-mix(in srgb,var(--dsw-alias-label-secondary) 6%,transparent);color:var(--dsw-alias-label-primary)}
.wl-group-chip.sidelined b{opacity:.6}
.wl-group-lazy{font-style:normal;font-size:9px;font-weight:800;letter-spacing:.02em;padding:1px 4px;border-radius:5px;background:color-mix(in srgb,var(--dsw-alias-label-secondary) 20%,transparent);color:var(--dsw-alias-label-primary);opacity:.85;margin-right:4px}
.wl-group-chip.add{border-style:dashed;color:var(--dsw-alias-label-secondary);cursor:pointer}
.wl-group-chip.add:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.wl-group-act{border:0;background:transparent;color:var(--dsw-alias-label-secondary);opacity:.75;font-size:12px;padding:0 2px;line-height:1;cursor:pointer;border-radius:4px}
.wl-group-act:hover{opacity:1;color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent)}
.wl-group-act.danger:hover{color:var(--dsw-alias-state-error-primary)}
.wl-group-chip.on .wl-group-act{color:inherit}
.wl-batch{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:0 24px 10px;padding:8px 10px;border-radius:11px;border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 9%,transparent);flex-shrink:0}
.wl-batch-count{font-size:12px;font-weight:700;color:var(--dsw-alias-brand-primary);margin-right:4px}
.wl-batch-btn{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:8px;padding:5px 10px;font-size:12px;white-space:nowrap}
.wl-batch-btn:hover{border-color:var(--dsw-alias-brand-primary)}
.wl-batch-btn.danger{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 42%,transparent)}
.wl-batch-btn.ghost{border-color:transparent;background:transparent;color:var(--dsw-alias-label-secondary);margin-left:auto}
.wl-batch-field{display:inline-flex;align-items:center;gap:4px;font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.wl-batch-select{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:8px;padding:5px 7px;font-size:12px}
.wl-stat-btn{text-align:left;cursor:pointer}
.wl-stat-btn.on{border-color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent)}
.wl-stat-btn.on b{color:var(--dsw-alias-brand-primary);font-size:14px}
.wl-cal-check{width:13px;height:13px;min-width:13px;border-radius:4px;border:1.5px solid var(--dsw-alias-border-l2);display:inline-flex;align-items:center;justify-content:center;font-size:10px;line-height:1;flex-shrink:0;margin-right:5px;vertical-align:middle;cursor:pointer;color:transparent;background:transparent;transition:background .12s,border-color .12s,color .12s}
.wl-cal-check:hover{border-color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent)}
.wl-cal-check:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.wl-cal-check.on{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff;font-weight:800}
/* The rail title must not clip the checkbox: the label ellipses, not the row. */
.wl-rail-title>span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.wl-rail-open{cursor:pointer}
.wl-rail-open:hover{text-decoration:underline}
.wl-cal-item.picked{outline:1.5px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.wl-cal-item-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}
.wl-summary{display:flex;flex-direction:column;gap:10px;min-height:0}
.wl-sum-cards{display:flex;gap:9px;flex-wrap:wrap}
.wl-sum-card{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:11px;padding:9px 13px;min-width:104px}
.wl-sum-card b{display:block;font-size:17px;font-weight:750;letter-spacing:-.02em}
.wl-sum-card span{font-size:11px;color:var(--dsw-alias-label-secondary)}
.wl-sum-sect{font-size:11px;font-weight:750;letter-spacing:.05em;color:var(--dsw-alias-label-secondary);text-transform:uppercase;margin-top:6px}
.wl-sum-table{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l1);border-radius:11px;overflow:hidden;background:var(--dsw-alias-bg-layer-1)}
.wl-sum-tr{display:grid;grid-template-columns:minmax(140px,1.6fr) minmax(120px,2fr) 70px 60px 60px;gap:10px;align-items:center;padding:7px 11px;border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 55%,transparent);font-size:12px}
.wl-sum-tr:last-child{border-bottom:none}
.wl-sum-th{background:var(--dsw-alias-bg-layer-2);font-size:10.5px;font-weight:750;color:var(--dsw-alias-label-secondary);letter-spacing:.04em}
.wl-sum-name{display:flex;align-items:center;gap:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wl-sum-dot{width:8px;height:8px;border-radius:3px;flex-shrink:0;display:inline-block}
.wl-sum-bar{position:relative;display:flex;align-items:center;gap:7px;min-width:0}
.wl-sum-bar>i{height:9px;border-radius:4px;display:block;flex-shrink:0;max-width:100%}
.wl-sum-bar>em{font-style:normal;font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.wl-sum-muted{font-size:11px;color:var(--dsw-alias-label-secondary)}
.wl-sum-projects{display:flex;flex-direction:column;gap:6px;border:1px solid var(--dsw-alias-border-l1);border-radius:11px;padding:10px 12px;background:var(--dsw-alias-bg-layer-1)}
.wl-sum-proj{display:grid;grid-template-columns:minmax(90px,140px) 1fr auto;gap:10px;align-items:center;font-size:12px}
.wl-sum-proj-name{display:flex;align-items:center;gap:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wl-sum-proj-bar{height:7px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.wl-sum-proj-bar>i{display:block;height:100%;border-radius:4px}
@media(max-width:820px){.wl-sum-tr{grid-template-columns:minmax(110px,1.6fr) minmax(90px,1.4fr) 58px 48px 48px;gap:6px;padding:6px 8px}}
.wl-stage{flex:1;min-height:150px;display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l1);border-radius:13px;background:var(--dsw-alias-bg-layer-1);overflow:hidden;min-height:0}
.wl-stagescroll{flex:1;min-height:0;overflow:auto;padding:12px}
.wl-cal{flex:1;display:flex;flex-direction:column;min-height:0;overflow:hidden}
.wl-cal-head{display:grid;grid-template-columns:repeat(7,1fr);background:var(--dsw-alias-bg-layer-2);border-bottom:1px solid var(--dsw-alias-border-l1);flex-shrink:0}
.wl-cal-dow{padding:7px 9px;font-size:11px;font-weight:700;color:var(--dsw-alias-label-secondary);letter-spacing:.04em}
.wl-cal-week{display:grid;grid-template-columns:repeat(7,1fr);flex:1;min-height:0;border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 60%,transparent)}
.wl-cal-week:last-child{border-bottom:none}
/* Zone tinting: rest days, public holidays and 调休 workdays each read
   differently at a glance, using tints rather than borders so a full month
   does not look like a grid of boxes. */
.wl-cal-fest{font-size:9px;line-height:1.2;color:var(--dsw-alias-state-error-primary);font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wl-cal-fest.makeup{color:var(--dsw-alias-state-warn-primary)}
.wl-cal-cell.weekday{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 3.5%,var(--dsw-alias-bg-layer-1))}
.wl-cal-cell.rest{background:color-mix(in srgb,var(--dsw-alias-label-secondary) 8%,var(--dsw-alias-bg-layer-2))}
.wl-cal-cell.weekend{background:color-mix(in srgb,var(--dsw-alias-label-secondary) 13%,var(--dsw-alias-bg-layer-2))}
.wl-cal-cell.holiday{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 11%,transparent)}
.wl-cal-cell.holiday .wl-cal-daynum{color:var(--dsw-alias-state-error-primary)}
.wl-cal-cell.makeup{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 12%,transparent)}
.wl-cal-cell.makeup .wl-cal-daynum{color:var(--dsw-alias-state-warn-primary)}
.wl-cal-cell.outside{opacity:.42}
.wl-cal-cell.today{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,var(--dsw-alias-bg-layer-1));box-shadow:inset 0 0 0 2px var(--dsw-alias-brand-primary)}
.wl-cal-cell{position:relative;display:flex;flex-direction:column;gap:3px;padding:5px 6px;border-left:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 60%,transparent);min-width:0;min-height:62px;cursor:pointer;overflow:hidden;transition:background .12s}
.wl-cal-cell:first-child{border-left:none}
.wl-cal-cell:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 7%,var(--dsw-alias-bg-layer-2))}
.wl-cal-cell.holiday:hover{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 16%,transparent)}
.wl-cal-cell.makeup:hover{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 18%,transparent)}
.wl-cal-daynum{font-size:11.5px;font-weight:650;color:var(--dsw-alias-label-secondary);line-height:1.2;flex-shrink:0}
.wl-cal-cell.today .wl-cal-daynum{color:var(--dsw-alias-brand-primary);font-weight:800}
.wl-cal-cell.today .wl-cal-daynum{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);border-radius:7px;padding:0 4px;display:inline-block;min-width:18px;text-align:center}
.wl-cal-items{display:flex;flex-direction:column;gap:2px;overflow:hidden;min-height:0}
.wl-cal-item{display:flex;align-items:center;font-size:10.5px;line-height:1.35;padding:2px 5px;border-radius:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent);color:var(--dsw-alias-label-primary);border-left:2.5px solid var(--dsw-alias-brand-primary)}
.wl-cal-item[data-status=doing]{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base)}
.wl-cal-item[data-status=done]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 18%,transparent);color:var(--dsw-alias-state-success-primary);border-left-color:var(--dsw-alias-state-success-primary);text-decoration:line-through;opacity:.8}
.wl-cal-item[data-status=blocked]{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 16%,transparent);color:var(--dsw-alias-state-error-primary);border-left-color:var(--dsw-alias-state-error-primary)}
.wl-cal-more{font-size:10px;color:var(--dsw-alias-label-secondary);padding-left:5px}
.wl-cal-count{font-style:normal;font-size:9.5px;font-weight:750;color:var(--dsw-alias-brand-primary);margin-left:3px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent);border-radius:6px;padding:0 4px;vertical-align:middle}
.wl-cal-load{display:flex;height:5px;border-radius:3px;overflow:hidden;gap:1px;margin:3px 0 1px}
.wl-cal-load>i{display:block;height:100%;border-radius:2px}
.wl-cal-meta{display:flex;align-items:center;gap:4px;flex-wrap:nowrap;overflow:hidden;min-width:0}
.wl-cal-dots{display:inline-flex;gap:2px;flex-shrink:0}
.wl-cal-dot{width:5px;height:5px;border-radius:50%;display:block}
.wl-cal-group{font-size:9.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.wl-cal-logs{font-size:9.5px;color:var(--dsw-alias-label-secondary);padding-left:5px;opacity:.85;white-space:nowrap}
.wl-cal-add{position:absolute;right:5px;top:4px;font-size:12px;color:var(--dsw-alias-label-secondary);opacity:0;transition:opacity .12s}
.wl-cal-cell:hover .wl-cal-add{opacity:.65}
.wl-colors{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.wl-color{width:20px;height:20px;border-radius:6px;border:2px solid transparent;cursor:pointer;padding:0}
.wl-color.on{border-color:var(--dsw-alias-label-primary);box-shadow:0 0 0 2px var(--dsw-alias-bg-base) inset}
.wl-color.auto{width:auto;padding:0 8px;height:22px;font-size:11px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1)}
.wl-check-label{display:flex;align-items:center;gap:7px;font-size:12px;cursor:pointer}
.wl-cal-cell.selected{box-shadow:inset 0 0 0 2px color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,transparent)}
.wl-cal-cell.selected.today{box-shadow:inset 0 0 0 2px var(--dsw-alias-brand-primary)}
.wl-cal-done{font-style:normal;font-size:9.5px;font-weight:800;color:var(--dsw-alias-state-success-primary);margin-left:3px}
.wl-cal-marks{display:flex;flex-wrap:wrap;gap:2px;margin-top:2px}
.wl-cal-mark{font-style:normal;font-size:10px;line-height:1;font-weight:800;opacity:.9}
.wl-cal-mark.done{color:var(--dsw-alias-state-success-primary)}
.wl-cal-mark.note{color:var(--dsw-alias-label-secondary)}
.wl-card-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:8px}
.wl-card-head h3{margin:0}
.wl-card-count{font-size:11px;font-weight:750;color:var(--dsw-alias-brand-primary)}
.wl-mini-done .wl-mini-text{text-decoration:line-through;opacity:.8}
.wl-side-note{display:flex;flex-direction:column;gap:2px;padding:6px 0;border-bottom:1px dashed color-mix(in srgb,var(--dsw-alias-border-l1) 60%,transparent)}
.wl-side-note:last-child{border-bottom:none}
.wl-side-note-text{font-size:12px;line-height:1.55;white-space:pre-wrap;word-break:break-word}
.wl-side-note-meta{display:flex;align-items:center;gap:6px;font-size:10.5px;color:var(--dsw-alias-label-secondary)}
.wl-side-note-del{margin-left:auto;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1;padding:0 2px;cursor:pointer;opacity:.5}
.wl-side-note-del:hover{opacity:1;color:var(--dsw-alias-state-error-primary)}
.wl-quick-days{display:flex;align-items:center;gap:5px;flex-wrap:wrap}
.wl-quick-days input[type=date]{flex:1;min-width:120px}
.wl-chip.on{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);font-weight:650}
.wl-more-toggle{align-self:flex-start;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-size:11.5px;padding:4px 0;cursor:pointer}
.wl-more-toggle:hover{color:var(--dsw-alias-brand-primary)}
.wl-search{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:9px;padding:7px 10px;font-size:12.5px;outline:none;width:150px}
.wl-search:focus{border-color:var(--dsw-alias-brand-primary)}
@media(max-width:760px){.wl-search{width:110px}}
.wl-switch{display:inline-flex;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;overflow:hidden;background:var(--dsw-alias-bg-layer-1)}
.wl-switch-btn{border:0;background:transparent;padding:7px 11px;font-size:12.5px;color:var(--dsw-alias-label-secondary)}
.wl-switch-btn.on{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);font-weight:650}
.wl-scroll{flex:1;min-height:0;overflow:auto;position:relative}
.wl-canvas{position:relative;width:max-content;min-width:100%}
.wl-bg{position:absolute;top:0;bottom:0;left:220px;display:flex;pointer-events:none;z-index:0}
.wl-bg i{flex:0 0 auto;border-left:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 45%,transparent)}
.wl-bg i.weekend{background:color-mix(in srgb,var(--dsw-alias-label-primary) 4%,transparent)}
.wl-bg i.todayCol{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 7%,transparent)}
.wl-headRow{display:flex;position:sticky;top:0;z-index:3}
.wl-corner{width:220px;flex:0 0 auto;display:flex;align-items:flex-end;padding:8px 12px;font-size:11px;color:var(--dsw-alias-label-secondary);font-weight:700;letter-spacing:.04em;border-right:1px solid var(--dsw-alias-border-l1);border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);position:sticky;left:0;z-index:4}
.wl-day{flex:0 0 auto;text-align:center;font-size:10.5px;padding:5px 0 6px;color:var(--dsw-alias-label-secondary);border-left:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 55%,transparent);line-height:1.35;overflow:hidden}
.wl-day b{display:block;font-size:11.5px;font-weight:650;color:var(--dsw-alias-label-primary)}
.wl-day span{display:block;font-size:10px}
.wl-day.weekend{background:color-mix(in srgb,var(--dsw-alias-label-primary) 4%,transparent)}
.wl-day.today b{color:var(--dsw-alias-brand-primary);font-weight:800}
.wl-day.monthStart{border-left:1px solid var(--dsw-alias-border-l2)}
.wl-days{display:flex;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}
.wl-row{display:flex;position:relative;z-index:1}
.wl-railCell{width:220px;flex:0 0 auto;height:34px;display:flex;flex-direction:column;justify-content:center;padding:0 12px;border-right:1px solid var(--dsw-alias-border-l1);border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 55%,transparent);cursor:pointer;overflow:hidden;background:var(--dsw-alias-bg-layer-1);position:sticky;left:0;z-index:2}
.wl-railCell:hover{background:var(--dsw-alias-bg-layer-2)}
.wl-rail-title{display:flex;align-items:center;gap:0;font-size:12.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wl-rail-sub{font-size:10.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px}
.wl-track{position:relative;flex:0 0 auto;height:34px;border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 55%,transparent);cursor:crosshair}
.wl-bar .wl-bar-phases{position:absolute;left:0;right:0;bottom:0;height:4px;display:block;pointer-events:none;overflow:hidden;z-index:2;border-radius:0 0 5px 5px}
.wl-bar .wl-bar-phase{position:absolute;top:0;bottom:0;display:block;pointer-events:auto;cursor:pointer;background:currentColor;opacity:.45;transition:opacity .12s}
.wl-bar .wl-bar-phase:hover{opacity:.62}
.wl-bar .wl-bar-phase.done{opacity:.3}
.wl-bar .wl-bar-phase.current{opacity:.7}
.wl-bar .wl-bar-phase.late{background:var(--wl-phase-late);opacity:.55}
/* Gaps between phases read as separators without adding chrome. */
.wl-bar.has-segments .wl-bar-label{padding-bottom:2px}
.wl-bar{position:absolute;top:5px;bottom:5px;border-radius:6px;display:flex;align-items:center;padding:0 8px;overflow:hidden;cursor:grab;user-select:none;border:1px solid transparent;transition:box-shadow .12s,border-color .12s,filter .12s}
.wl-bar:active{cursor:grabbing}
.wl-bar:hover{border-color:var(--dsw-alias-label-primary)}
.wl-bar .wl-bar-fill{position:absolute;inset:0 auto 0 0;border-radius:5px;opacity:.1;background:var(--dsw-alias-bg-base);pointer-events:none}
.wl-bar .wl-bar-label{position:relative;font-size:11.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wl-bar[data-status=todo]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,transparent);color:var(--dsw-alias-label-primary)}
.wl-bar[data-status=doing]{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base)}
.wl-bar[data-status=blocked]{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 22%,transparent);color:var(--dsw-alias-state-error-primary)}
.wl-bar[data-status=done]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 20%,transparent);color:var(--dsw-alias-state-success-primary);opacity:.85}
.wl-bar.overdue{outline:1.5px dashed var(--dsw-alias-state-error-primary);outline-offset:1px}
.wl-bar.open{clip-path:inset(0 0 0 0 round 7px);border-top-right-radius:0;border-bottom-right-radius:0;-webkit-mask-image:linear-gradient(to right,#000 82%,transparent);mask-image:linear-gradient(to right,#000 82%,transparent)}
.wl-bar.selected{border-color:var(--dsw-alias-label-primary);box-shadow:0 2px 10px rgba(0,0,0,.18)}
.wl-grip{position:absolute;top:0;bottom:0;width:6px;cursor:ew-resize;z-index:2}
.wl-grip.l{left:0}.wl-grip.r{right:0}
.wl-milestone{position:absolute;width:9px;height:9px;transform:rotate(45deg);background:var(--dsw-alias-brand-primary);top:50%;margin-top:-4.5px;z-index:2}
.wl-today{position:absolute;top:0;bottom:0;width:2px;background:var(--dsw-alias-brand-primary);opacity:.5;pointer-events:none;z-index:0}
.wl-emptyRow{padding:34px 20px;text-align:center;color:var(--dsw-alias-label-secondary);line-height:1.7;font-size:12.5px}
.wl-logs{border:1px solid var(--dsw-alias-border-l1);border-radius:13px;background:var(--dsw-alias-bg-layer-1);padding:12px 14px;flex-shrink:0;max-height:212px;display:flex;flex-direction:column;gap:9px}
.wl-logs-head{display:flex;align-items:center;gap:8px;font-size:12.5px;font-weight:700}
.wl-logs-head .wl-daynav{display:flex;align-items:center;gap:4px;margin-left:auto;font-weight:500}
.wl-daynav button{border:1px solid var(--dsw-alias-border-l1);background:transparent;border-radius:7px;padding:2px 7px;font-size:11.5px}
.wl-log-list{overflow:auto;display:flex;flex-direction:column;gap:6px;min-height:0}
.wl-log{display:flex;gap:8px;align-items:baseline;font-size:12.5px;line-height:1.55;padding:5px 0;border-bottom:1px dashed color-mix(in srgb,var(--dsw-alias-border-l1) 70%,transparent)}
.wl-log:last-child{border-bottom:none}
.wl-log-task{font-size:10.5px;color:var(--dsw-alias-brand-primary);font-weight:650;flex-shrink:0;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wl-log-text{flex:1;min-width:0;white-space:pre-wrap;word-break:break-word}
.wl-log-min{font-size:11px;color:var(--dsw-alias-label-secondary);flex-shrink:0}
.wl-log-del{border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-size:14px;line-height:1;padding:0 2px;opacity:0;transition:opacity .12s}
.wl-log:hover .wl-log-del{opacity:1}
.wl-log-del:hover{color:var(--dsw-alias-state-error-primary)}
.wl-compose{display:flex;gap:6px;align-items:flex-end;flex-shrink:0}
.wl-compose textarea{flex:1;min-height:34px;max-height:88px;resize:vertical;padding:7px 10px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;outline:none}
.wl-compose textarea:focus{border-color:var(--dsw-alias-brand-primary)}
.wl-compose input{width:66px;padding:7px 8px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;outline:none;text-align:center}
.wl-heat{display:flex;gap:2px;align-items:flex-end;height:26px}
.wl-heat i{flex:1;min-width:3px;border-radius:2px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 22%,transparent);display:block}
.wl-side{width:260px;flex-shrink:0;display:flex;flex-direction:column;gap:14px;overflow:auto}
.wl-card{border:1px solid var(--dsw-alias-border-l1);border-radius:13px;background:var(--dsw-alias-bg-layer-1);padding:13px 14px}
.wl-card h3{margin:0 0 9px;font-size:12px;letter-spacing:.04em;color:var(--dsw-alias-label-secondary);font-weight:750;text-transform:uppercase}
.wl-mini{display:flex;align-items:center;gap:8px;padding:6px 0;font-size:12.5px;cursor:pointer;border-bottom:1px dashed color-mix(in srgb,var(--dsw-alias-border-l1) 60%,transparent)}
.wl-mini:last-child{border-bottom:none}
.wl-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0}
.wl-dot.todo{background:var(--dsw-alias-brand-primary);opacity:.5}
.wl-dot.doing{background:var(--dsw-alias-brand-primary)}
.wl-dot.blocked{background:var(--dsw-alias-state-error-primary)}
.wl-dot.done{background:var(--dsw-alias-state-success-primary)}
.wl-mini-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wl-mini-when{font-size:10.5px;color:var(--dsw-alias-label-secondary);flex-shrink:0}
.wl-muted{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6}
.wl-drawer{position:absolute;top:0;right:0;bottom:0;width:min(360px,86vw);background:var(--dsw-alias-bg-base);border-left:1px solid var(--dsw-alias-border-l1);box-shadow:-14px 0 34px rgba(0,0,0,.14);display:flex;flex-direction:column;z-index:20;animation:wldrawer .16s ease-out}
@keyframes wldrawer{from{transform:translateX(14px);opacity:.6}to{transform:none;opacity:1}}
@media (prefers-reduced-motion:reduce){.wl-drawer{animation:none}}
.wl-drawer-head{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);flex-shrink:0;background:var(--dsw-alias-bg-base);position:sticky;top:0;z-index:1}
.wl-drawer-back{font-size:15px;font-weight:700;flex-shrink:0}
.wl-drawer-back:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.wl-drawer-head h2{margin:0;font-size:14px;font-weight:750;flex:1}
.wl-drawer-body{flex:1;overflow:auto;padding:14px 16px;display:flex;flex-direction:column;gap:10px}
.wl-field{display:flex;flex-direction:column;gap:4px}
.wl-field label{font-size:11px;color:var(--dsw-alias-label-secondary);font-weight:600}
/* ---- form controls: unmistakably editable --------------------------------
   Every input gets a visible border, a raised surface and a focus ring, so a
   field never reads as plain text. Buttons get their own treatment so a
   clickable control and a text box cannot be confused. */
.wl-field input,.wl-field select,.wl-field textarea{width:100%;padding:8px 10px;border-radius:9px;border:1.5px solid color-mix(in srgb,var(--dsw-alias-label-primary) 26%,transparent);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;outline:none;transition:border-color .13s,box-shadow .13s,background .13s}
.wl-field input:hover,.wl-field select:hover,.wl-field textarea:hover{border-color:color-mix(in srgb,var(--dsw-alias-label-primary) 42%,transparent)}
.wl-field input:focus,.wl-field select:focus,.wl-field textarea:focus{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary) 18%,transparent)}
.wl-field input::placeholder,.wl-field textarea::placeholder{color:color-mix(in srgb,var(--dsw-alias-label-secondary) 72%,transparent)}
.wl-field textarea{resize:vertical;min-height:62px}
/* Date/time pickers need their native indicator to stay reachable. */
.wl-field input[type=date],.wl-field input[type=time],.wl-field input[type=datetime-local]{cursor:pointer}
.wl-field input[type=date]::-webkit-calendar-picker-indicator{cursor:pointer;opacity:.6}
.wl-field input[type=date]:hover::-webkit-calendar-picker-indicator{opacity:1}
/* A checkbox is a control, not decoration. */
.wl-field input[type=checkbox],.wl-check-label input[type=checkbox]{width:15px;height:15px;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}
/* Range sliders get a track that reads as trackable. */
.wl-field input[type=range]{accent-color:var(--dsw-alias-brand-primary);cursor:pointer;padding:0;border:none;background:transparent;box-shadow:none;min-height:22px}
.wl-field input[type=range]::-webkit-slider-thumb{cursor:grab}
/* Selects look like menus, not labels. */
.wl-field select{appearance:none;-webkit-appearance:none;background-image:linear-gradient(45deg,transparent 50%,color-mix(in srgb,var(--dsw-alias-label-secondary) 90%,transparent) 50%),linear-gradient(135deg,color-mix(in srgb,var(--dsw-alias-label-secondary) 90%,transparent) 50%,transparent 50%);background-position:calc(100% - 15px) 52%,calc(100% - 10px) 52%;background-size:5px 5px,5px 5px;background-repeat:no-repeat;padding-right:26px}
.wl-row2{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.wl-drawer-foot{display:flex;gap:8px;padding:12px 16px;border-top:1px solid var(--dsw-alias-border-l1)}
.wl-drawer-foot .wl-btn{flex:1}
.wl-danger{color:var(--dsw-alias-state-error-primary)!important;border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 42%,transparent)!important}
.wl-error{margin:0 24px;padding:8px 12px;border-radius:9px;background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent);color:var(--dsw-alias-state-error-primary);font-size:12.5px}
.wl-progress{height:4px;border-radius:2px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.wl-progress i{display:block;height:100%;background:var(--dsw-alias-brand-primary)}
/* floating dock */
.wl-float{-webkit-app-region:no-drag;app-region:no-drag;position:fixed;z-index:60;width:308px;border-radius:15px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 92%,transparent);backdrop-filter:blur(14px);box-shadow:0 18px 44px rgba(0,0,0,.22);display:flex;flex-direction:column;overflow:hidden;font-size:12.5px}
.wl-float-head{position:relative;display:flex;align-items:center;gap:8px;padding:9px 11px;cursor:grab;touch-action:none;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent);border-bottom:1px solid var(--dsw-alias-border-l1);user-select:none}
.wl-float-head:active{cursor:grabbing}.wl-float-head *{-webkit-user-drag:none}
.wl-float-title{font-weight:700;font-size:12.5px;flex:1;display:flex;align-items:center;gap:6px;overflow:hidden;white-space:nowrap}
.wl-float-badge{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);border-radius:999px;font-size:10px;padding:1px 7px;font-weight:750}
.wl-float-btn{border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-size:14px;line-height:1;padding:2px 4px;border-radius:6px}
.wl-float-btn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.wl-float-body{display:flex;flex-direction:column;gap:8px;padding:10px 11px 11px;max-height:min(56vh,440px);overflow:auto}
.wl-float-sect{font-size:10px;letter-spacing:.07em;text-transform:uppercase;color:var(--dsw-alias-label-secondary);font-weight:750;margin-top:2px}
.wl-float-task{display:flex;align-items:center;gap:7px;padding:5px 6px;border-radius:8px;cursor:pointer}
.wl-float-task:hover{background:var(--dsw-alias-bg-layer-2)}
.wl-float-task .wl-mini-text{font-size:12px}
.wl-float-check{width:14px;height:14px;border-radius:4px;border:1.5px solid var(--dsw-alias-border-l2);flex-shrink:0;display:grid;place-items:center;font-size:10px;color:transparent;background:transparent}
.wl-float-check:hover{border-color:var(--dsw-alias-brand-primary)}
.wl-float-check.on{background:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-bg-base)}
.wl-float-meta{display:flex;align-items:center;gap:5px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-secondary)}
.wl-float-sep{opacity:.45}
.wl-float-hot{color:var(--dsw-alias-state-error-primary);font-weight:700}
.wl-float-sect.hot{color:var(--dsw-alias-state-error-primary)}
.wl-float-task.hot .wl-mini-text{color:var(--dsw-alias-state-error-primary)}
.wl-float-task.doing{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 7%,transparent)}
.wl-float-late{font-size:10.5px;color:var(--dsw-alias-state-error-primary);flex-shrink:0;font-weight:600}
.wl-float-due{font-size:10px;color:var(--dsw-alias-state-warn-primary);flex-shrink:0;font-weight:700}
.wl-float-tasks{display:flex;flex-direction:column;gap:1px;max-height:min(34vh,260px);overflow:auto;padding-right:2px}
.wl-float-tasks::-webkit-scrollbar{width:6px}
.wl-float-tasks::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l2);border-radius:3px}
.wl-float-filter{width:100%;padding:5px 8px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:11.5px;outline:none}
.wl-float-filter:focus{border-color:var(--dsw-alias-brand-primary)}
.wl-float-more{border:1px dashed var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:8px;padding:4px 8px;font-size:11px;align-self:flex-start}
.wl-float-more:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.wl-float-log{display:flex;gap:7px;align-items:baseline;font-size:11.5px;line-height:1.5;padding:3px 6px;border-radius:7px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 3.5%,transparent)}
.wl-float-log-text{flex:1;min-width:0;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;word-break:break-word}
.wl-float-compose{display:flex;flex-direction:column;gap:6px}
.wl-check-row{cursor:pointer}
.wl-check-row.checked{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent)}
.wl-check-row.checked .wl-mini-text{color:var(--dsw-alias-label-secondary);text-decoration:line-through}
.wl-float-news{display:flex;gap:5px;align-items:center}
.wl-float-newtask{flex:1;min-width:0;padding:6px 8px;border-radius:8px;border:1px dashed var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:11.5px;outline:none}
.wl-float-newtask:focus{border-style:solid;border-color:var(--dsw-alias-brand-primary)}
.wl-float-news .wl-btn{padding:5px 8px;font-size:11.5px;flex-shrink:0}
.wl-float-input{width:100%;padding:7px 9px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;outline:none;resize:none}
.wl-float-input:focus{border-color:var(--dsw-alias-brand-primary)}
.wl-float-foot{display:flex;gap:6px;align-items:center}
.wl-float-foot .wl-btn{padding:5px 9px;font-size:11.5px}
.wl-icon{-webkit-app-region:no-drag;app-region:no-drag;position:fixed;z-index:60;width:46px;height:46px;border-radius:50%;display:grid;place-items:center;cursor:grab;user-select:none;touch-action:none;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 95%,transparent);backdrop-filter:blur(12px);border:1px solid var(--dsw-alias-border-l2);box-shadow:0 8px 22px rgba(0,0,0,.24);transition:transform .12s,border-color .12s}
.wl-icon:hover{transform:scale(1.06);border-color:var(--dsw-alias-brand-primary)}
.wl-icon:active{cursor:grabbing;transform:scale(.98)}
.wl-icon-mark{font-size:20px;line-height:1;color:var(--dsw-alias-brand-primary)}
.wl-icon.urgent{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 65%,transparent);box-shadow:0 8px 22px color-mix(in srgb,var(--dsw-alias-state-error-primary) 32%,transparent)}
.wl-icon.urgent .wl-icon-mark{color:var(--dsw-alias-state-error-primary)}
.wl-icon-badge{position:absolute;top:-3px;right:-3px;min-width:17px;height:17px;padding:0 4px;border-radius:9px;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);font-size:10px;font-weight:750;display:grid;place-items:center;line-height:1}
.wl-icon.urgent .wl-icon-badge{background:var(--dsw-alias-state-error-primary)}
.wl-float-close:hover{color:var(--dsw-alias-state-error-primary)!important;background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 14%,transparent)!important}
.wl-pill{-webkit-app-region:no-drag;app-region:no-drag;position:fixed;z-index:60;display:flex;align-items:center;gap:7px;padding:7px 12px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 94%,transparent);backdrop-filter:blur(12px);box-shadow:0 10px 26px rgba(0,0,0,.2);font-size:12px;font-weight:650;cursor:pointer;user-select:none}
.wl-toast{-webkit-app-region:no-drag;app-region:no-drag;position:fixed;z-index:70;right:22px;bottom:22px;width:296px;border-radius:13px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 34%,transparent);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 96%,transparent);backdrop-filter:blur(12px);box-shadow:0 16px 38px rgba(0,0,0,.24);padding:11px 12px;display:flex;flex-direction:column;gap:5px;animation:wlin .18s ease-out}
@keyframes wlin{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
.wl-toast b{font-size:12.5px}
.wl-toast span{font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.5}
.wl-toast-actions{display:flex;gap:6px;margin-top:4px}
.wl-hint{font-size:10.5px;color:var(--dsw-alias-label-secondary);line-height:1.5}
@media(max-width:980px){.wl-side{display:none}.wl-body{padding:10px 14px 16px}.wl-head{padding:12px 14px 10px}.wl-stats{padding:10px 14px 0}}
@media(max-width:620px){.wl-drawer{width:100%}.wl-float{width:calc(100vw - 28px)}}
`;

    // Injected by every face: the dock can mount without the board ever
    // having rendered, so neither component may own the stylesheet alone.
    // Inject the stylesheet into the document once, keyed by a data attribute
    // so any number of mounted components share a single copy.
    const STYLE_ID = 'worklog-calendar/styles';
    function ensureStyles() {
      if (typeof document === 'undefined' || !document.head) return;
      if (document.head.querySelector(`style[data-worklog="${STYLE_ID}"]`)) return;
      const node = document.createElement('style');
      node.setAttribute('data-worklog', STYLE_ID);
      node.textContent = css;
      document.head.appendChild(node);
    }
    // Mounted by every face; the effect runs after mount and is idempotent, so
    // multiple faces still produce exactly one <style> element.
    function StyleOnce() {
      useEffect(() => { ensureStyles(); }, []);
      return null;
    }

    /* ------------------------------------------------------------------ *
     * Shared data store
     * The board panel and the floating dock read one snapshot, so a change
     * made in either place shows up in the other immediately.
     * ------------------------------------------------------------------ */

    let snapshot = { data: null, loading: false, error: '', busy: false, day: dayOf() };
    const listeners = new Set();

    function setSnapshot(patch) {
      snapshot = { ...snapshot, ...patch };
      for (const listener of listeners) listener();
    }
    function subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
    // Recheck the calendar day, and reload when it changed. Called by a timer
    // and on wake, because a laptop that slept through midnight never fired.
    function syncDay() {
      const current = dayOf();
      if (current === snapshot.day) return;
      snapshot = { ...snapshot, day: current };
      for (const listener of listeners) listener();
      reload(current.slice(0, 7)).catch(() => undefined);
    }

    function getSnapshot() {
      return snapshot;
    }

    async function request(payload, method) {
      const response = method === 'POST'
        ? await fetch('/api/worklog-calendar', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload || {}),
          })
        : await fetch('/api/worklog-calendar?' + new URLSearchParams(payload || {}));
      const text = await response.text();
      let result;
      try {
        result = text ? JSON.parse(text) : {};
      } catch {
        throw new Error(text.slice(0, 120) || `请求失败（HTTP ${response.status}）`);
      }
      if (!response.ok || result.error) throw new Error(result.error || `请求失败（HTTP ${response.status}）`);
      return result;
    }

    async function reload(month) {
      setSnapshot({ loading: true });
      try {
        // Always send the client's current day: the host computes "today" from
        // its own clock, and a tab left open across midnight would otherwise
        // keep receiving yesterday's check-ins. `month` asks the host to classify
        // that month's days for the calendar.
        const payload = { action: 'snapshot', day: snapshot.day };
        if (month) payload.month = month;
        const data = await request(payload);
        setSnapshot({ data, loading: false, error: '' });
      } catch (error) {
        setSnapshot({ loading: false, error: error.message });
      }
    }

    async function mutate(payload) {
      setSnapshot({ busy: true });
      try {
        const data = await request(payload, 'POST');
        setSnapshot({ data, busy: false, error: '' });
        return data;
      } catch (error) {
        setSnapshot({ busy: false, error: error.message });
        throw error;
      }
    }

    // Test seam: the store loads once per page; a test that seeds data later
    // must be able to re-read it. Not exported to the plugin surface.
    const __store = {
      reload,
      getSnapshot,
      syncDay,
      /**
       * Test seam: pretend the clock rolled over to `nextDay`, so a rollover
       * can be asserted without waiting for midnight.
       */
      /** Run a mutation and fold the returned snapshot in, like mutate(). */
      mutate,
      forceDay(nextDay) {
        snapshot = { ...snapshot, day: nextDay };
        for (const listener of listeners) listener();
        return reload(String(nextDay).slice(0, 7));
      },
    };
    if (typeof globalThis !== 'undefined') globalThis.__worklogStore = __store;

    /** Arm the midnight rollover once per page. */
    let dayWatcher = false;
    function watchDay() {
      if (dayWatcher) return;
      dayWatcher = true;
      const timer = setInterval(syncDay, 30000);
      // Browser timers have no unref; Node's do, and this keeps tests able to
      // exit while changing nothing at runtime.
      if (timer && typeof timer.unref === 'function') timer.unref();
      if (typeof document !== 'undefined' && document.addEventListener) {
        // A backgrounded tab or a sleeping machine may skip the timer; these
        // events catch up as soon as the page is visible again.
        document.addEventListener('visibilitychange', () => {
          if (!document.hidden) syncDay();
        });
      }
      if (typeof window !== 'undefined' && window.addEventListener) {
        window.addEventListener('focus', syncDay);
      }
    }

    let started = false;
    function useWorklog() {
      const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
      useEffect(() => {
        if (started) return;
        started = true;
        watchDay();
        syncDay();
        reload();
      }, []);
      return state;
    }

    /* ------------------------------------------------------------------ *
     * Reminders
     * Firing is recorded in localStorage per task+instant so a reload does
     * not re-announce the same thing, and a task edited later re-arms.
     * ------------------------------------------------------------------ */

    const REMIND_KEY = 'worklog.reminded.v1';
    const DIGEST_KEY = 'worklog.digest.v1';

    function readJson(key, fallback) {
      try {
        return JSON.parse(window.localStorage.getItem(key) || '') || fallback;
      } catch {
        return fallback;
      }
    }
    function writeJson(key, value) {
      try {
        window.localStorage.setItem(key, JSON.stringify(value));
      } catch {
        /* storage may be full or blocked; reminders still work in-session */
      }
    }

    function notify(title, body) {
      try {
        if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
          new Notification(title, { body, tag: 'worklog-calendar', silent: false });
        }
      } catch {
        /* Notification is best-effort */
      }
    }

    /** Return due tasks without side effects; the caller decides to announce. */
    function collectDue(tasks, settings, now) {
      const fired = readJson(REMIND_KEY, {});
      const due = [];
      for (const task of tasks) {
        if (task.status === 'done' || !task.remindAt || !INSTANT_RE.test(task.remindAt)) continue;
        const at = new Date(task.remindAt).getTime();
        if (!Number.isFinite(at)) continue;
        const target = at - Math.max(0, Number(task.remindLead ?? settings.defaultLead ?? 0)) * 60000;
        const stamp = task.remindAt;
        if (now < target) continue;
        // Do not resurrect reminders from days ago on a cold start.
        if (now - target > 6 * 3600000) continue;
        if (fired[task.id] === stamp) continue;
        due.push(task);
      }
      return { due, fired };
    }

    const FLOAT_KEY = 'worklog.float.v1';
    const ICON_KEY = 'worklog.icon.v1';
    const COLLAPSE_KEY = 'worklog.collapsed.v1';

    /* ------------------------------------------------------------------ *
     * Board (main panel)
     * ------------------------------------------------------------------ */

    function StatCard({ value, label, warn }) {
      return h('div', { className: 'wl-stat' + (warn ? ' warn' : '') }, h('b', null, value), h('span', null, label));
    }

    function TaskDrawer({ task, tasks, projects, groups, phases, onClose }) {
      const isNew = !task.id;
      const [draft, setDraft] = useState(() => ({
        title: task.title || '',
        project: task.project || '',
        group: task.group || '',
        phase: task.phase || '',
        start: task.start,
        // A new task has no deadline until one is decided.
        end: task.end || '',
        openEnded: !task.end,
        status: task.status,
        priority: task.priority,
        progress: task.progress ?? 0,
        detail: task.detail || '',
        remindAt: task.remindAt || '',
        remindLead: task.remindLead ?? 10,
        milestone: Boolean(task.milestone),
        color: task.color || '',
      }));
      const [error, setError] = useState('');
      // Advanced fields stay collapsed so creating a task is name + when.
      const [advanced, setAdvanced] = useState(!isNew);
      const today = dayOf();
      // Esc leaves the drawer; a textarea keeps its own Esc for undo intent.
      useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onClose();
          }
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
      }, [onClose]);
      const patch = (key) => (event) => {
        const value = event.target.type === 'checkbox' ? event.target.checked : event.target.value;
        setDraft((current) => ({ ...current, [key]: value }));
      };
      // Enter anywhere but the notes box commits the task.
      const setGroup = (value) => setDraft((current) => ({
        ...current,
        group: value,
        // A phase belongs to one group; switching groups clears it.
        phase: current.group === value ? current.phase : '',
      }));
      const onKeyDown = (event) => {
        if (event.key === 'Enter' && !event.shiftKey && event.target.tagName !== 'TEXTAREA') {
          event.preventDefault();
          save();
        }
      };
      const save = async () => {
        if (!draft.title.trim()) {
          setError('请填写任务名称');
          return;
        }
        const payload = {
          action: isNew ? 'task.create' : 'task.update',
          id: isNew ? undefined : task.id,
          ...draft,
          progress: Number(draft.progress) || 0,
          remindAt: draft.remindAt || null,
          remindLead: Number(draft.remindLead) || 0,
          color: draft.color || null,
          group: draft.group || '',
          phase: draft.phase || '',
          // '' / null means no deadline; only a real date is clamped forward.
          end: draft.openEnded || !draft.end
            ? null
            : (diffDays(draft.start, draft.end) < 0 ? draft.start : draft.end),
        };
        try {
          await mutate(payload);
          onClose();
        } catch (cause) {
          setError(cause.message);
        }
      };
      const [confirmDelete, setConfirmDelete] = useState(false);
      // Phases are managed right here in the task drawer: this is where the
      // user opened the project they are working on.
      const [phaseEditing, setPhaseEditing] = useState(null);
      const [phaseError, setPhaseError] = useState('');
      const savePhase = async () => {
        if (!phaseEditing) return;
        const name = String(phaseEditing.name || '').trim();
        if (!name) { setPhaseError('请填写阶段名称'); return; }
        setPhaseError('');
        try {
          await mutate(phaseEditing.id
            ? {
                action: 'phase', phaseAction: 'update', id: phaseEditing.id,
                name, start: phaseEditing.start, end: phaseEditing.end,
                outcome: phaseEditing.outcome, status: phaseEditing.status,
              }
            : {
                action: 'phase', phaseAction: 'create', taskId: task.id,
                name, start: phaseEditing.start, end: phaseEditing.end,
                outcome: phaseEditing.outcome, status: phaseEditing.status,
              });
          setPhaseEditing(null);
        } catch (cause) {
          setPhaseError(cause.message);
        }
      };
      const deletePhase = async (id) => {
        setPhaseError('');
        try {
          await mutate({ action: 'phase', phaseAction: 'delete', id });
        } catch (cause) {
          setPhaseError(cause.message);
        }
      };
      const remove = async () => {
        if (!confirmDelete) {
          setConfirmDelete(true);
          return;
        }
        try {
          await mutate({ action: 'task.delete', id: task.id });
          onClose();
        } catch (cause) {
          setError(cause.message);
        }
      };
      return h('aside', { className: 'wl-drawer', onKeyDown },
        h('div', { className: 'wl-drawer-head' },
          // An explicit back arrow: the drawer covers the board, so leaving it
          // must not depend on knowing the keyboard shortcut.
          h('button', {
            className: 'wl-btn icon wl-drawer-back',
            onClick: onClose,
            title: '返回看板（Esc）',
            'aria-label': '返回看板',
          }, '←'),
          h('h2', null, isNew ? '新建任务' : '编辑任务'),
          h('button', { className: 'wl-btn icon', onClick: onClose, 'aria-label': '关闭' }, '×')),
        h('div', { className: 'wl-drawer-body' },
          error ? h('div', { className: 'wl-error', style: { margin: 0 } }, error) : null,
          h('div', { className: 'wl-field' },
            h('label', null, '任务名称'),
            h('input', { value: draft.title, onChange: patch('title'), placeholder: '例如：完成日历浮窗联调', autoFocus: true })),
          h('div', { className: 'wl-field' },
            h('label', null, '什么时候开始'),
            h('div', { className: 'wl-quick-days' },
              h('button', {
                className: 'wl-chip' + (draft.start === today && !draft.openEnded ? ' on' : ''),
                onClick: () => setDraft((current) => ({ ...current, start: today })),
              }, '今天'),
              h('button', {
                className: 'wl-chip' + (draft.start === addDays(today, 1) ? ' on' : ''),
                onClick: () => setDraft((current) => ({ ...current, start: addDays(today, 1) })),
              }, '明天'),
              h('input', { type: 'date', value: draft.start, onChange: patch('start'), 'aria-label': '开始日期' }))),
          h('div', { className: 'wl-field' },
            h('label', null, '截止日期'),
            h('div', { className: 'wl-quick-days' },
              h('button', {
                className: 'wl-chip' + (draft.openEnded ? ' on' : ''),
                onClick: () => setDraft((current) => ({ ...current, openEnded: true, end: '' })),
                title: '一直做到完成为止，不设截止',
              }, '无期限'),
              h('button', {
                className: 'wl-chip' + (!draft.openEnded && draft.end === today ? ' on' : ''),
                onClick: () => setDraft((current) => ({ ...current, openEnded: false, end: today })),
              }, '今天'),
              h('button', {
                className: 'wl-chip' + (!draft.openEnded && draft.end === addDays(today, 7) ? ' on' : ''),
                onClick: () => setDraft((current) => ({ ...current, openEnded: false, end: addDays(today, 7) })),
              }, '一周后'),
              h('input', {
                type: 'date',
                value: draft.end,
                min: draft.start,
                'aria-label': '截止日期',
                disabled: draft.openEnded,
                onChange: (event) => setDraft((current) => ({ ...current, openEnded: false, end: event.target.value })),
              }))),
          h('div', { className: 'wl-field' },
            h('label', null, '所属项目 / 工作流'),
            h('input', { value: draft.project, onChange: patch('project'), list: 'wl-projects', placeholder: '可留空' }),
            h('datalist', { id: 'wl-projects' }, projects.map((name) => h('option', { key: name, value: name })))),
          h('div', { className: 'wl-field' },
            h('label', null, '分组'),
            groups.length
              ? h('div', { className: 'wl-quick-days' },
                  h('button', {
                    className: 'wl-chip' + (draft.group ? '' : ' on'),
                    onClick: () => setDraft((current) => ({ ...current, group: '' })),
                  }, '不分组'),
                  groups.map((group) => h('button', {
                    key: group.name,
                    className: 'wl-chip' + (draft.group === group.name ? ' on' : ''),
                    onClick: () => setGroup(draft.group === group.name ? '' : group.name),
                  }, group.name)))
              : null,
            h('input', {
              value: draft.group,
              onChange: (event) => setGroup(event.target.value),
              list: 'wl-groups',
              placeholder: groups.length ? '或输入新分组名' : '分组名，例如「本周必做」',
            }),
            h('datalist', { id: 'wl-groups' }, groups.map((group) => h('option', { key: group.name, value: group.name })))),
          (() => {
            // Phases of THIS task. A phase records what a stretch of the task
            // produced, so it lives in the task's own drawer — that is where
            // the user opened the thing they are working on.
            const taskPhases = (phases || [])
              .filter((phase) => phase.taskId === task.id)
              .sort((a, b) => a.start.localeCompare(b.start));
            // A brand-new task has nothing to phase yet.
            if (isNew) {
              return h('div', { className: 'wl-phase-block' },
                h('label', null, '项目阶段'),
                h('div', { className: 'wl-hint' }, '先保存任务，之后可以在这里划分它的阶段。'));
            }
            return h('div', { className: 'wl-phase-block' },
              h('label', null, `项目阶段（${taskPhases.length}）`),
              taskPhases.length
                ? taskPhases.map((phase) => h('div', {
                    key: phase.id,
                    className: 'wl-phase'
                      + (phase.status === 'done' ? ' done' : '')
                      + (phase.current ? ' current' : ''),
                  },
                    h('div', { className: 'wl-phase-top' },
                      h('span', { className: 'wl-phase-name' }, phase.name),
                      h('span', { className: 'wl-phase-when' }, `${phase.start.slice(5)}–${phase.end.slice(5)}`),
                      h('button', {
                        className: 'wl-phase-act',
                        title: '编辑阶段',
                        onClick: () => setPhaseEditing({ ...phase }),
                      }, '✎'),
                      h('button', {
                        className: 'wl-phase-act danger',
                        title: '删除阶段',
                        onClick: () => deletePhase(phase.id),
                      }, '×')),
                    h('div', { className: 'wl-phase-bar' }, h('i', { style: { width: `${phase.progress || 0}%` } })),
                    h('div', { className: 'wl-phase-meta' },
                      phase.status === 'done' ? h('span', { className: 'wl-phase-badge' }, '已完成') : null,
                      phase.current ? h('span', { className: 'wl-phase-badge live' }, '当前') : null,
                      phase.overdue ? h('span', { className: 'wl-phase-late' }, '超期') : null,
                      h('span', null, `${phase.progress || 0}%`)),
                    phase.outcome
                      ? h('div', { className: 'wl-phase-outcome' }, phase.outcome)
                      : h('div', { className: 'wl-phase-outcome empty' }, '还没有记录交付了什么')))
                : h('div', { className: 'wl-hint' }, '还没有阶段。阶段用来记录「某一时间段交付了什么」。'),
              phaseError ? h('div', { className: 'wl-error', style: { margin: 0 } }, phaseError) : null,
              phaseEditing
                ? h('div', { className: 'wl-phase-edit' },
                    h('div', { className: 'wl-field' },
                      h('label', null, '阶段名称'),
                      h('input', {
                        value: phaseEditing.name,
                        autoFocus: true,
                        placeholder: '例如：需求调研',
                        onChange: (event) => setPhaseEditing((cur) => ({ ...cur, name: event.target.value })),
                        onKeyDown: (event) => {
                          if (event.key === 'Enter') { event.preventDefault(); savePhase(); }
                          if (event.key === 'Escape') setPhaseEditing(null);
                        },
                      })),
                    h('div', { className: 'wl-row2' },
                      h('div', { className: 'wl-field' },
                        h('label', null, '开始'),
                        h('input', {
                          type: 'date', value: phaseEditing.start,
                          onChange: (event) => setPhaseEditing((cur) => ({ ...cur, start: event.target.value })),
                        })),
                      h('div', { className: 'wl-field' },
                        h('label', null, '结束（含）'),
                        h('input', {
                          type: 'date', value: phaseEditing.end, min: phaseEditing.start,
                          onChange: (event) => setPhaseEditing((cur) => ({ ...cur, end: event.target.value })),
                        }))),
                    h('div', { className: 'wl-field' },
                      h('label', null, '状态'),
                      h('select', {
                        value: phaseEditing.status,
                        onChange: (event) => setPhaseEditing((cur) => ({ ...cur, status: event.target.value })),
                      },
                        h('option', { value: 'planned' }, '计划中'),
                        h('option', { value: 'active' }, '进行中'),
                        h('option', { value: 'done' }, '已完成'))),
                    h('div', { className: 'wl-field' },
                      h('label', null, '这个阶段交付了什么'),
                      h('textarea', {
                        rows: 2,
                        value: phaseEditing.outcome,
                        placeholder: '例如：梳理出 12 个课程模块',
                        onChange: (event) => setPhaseEditing((cur) => ({ ...cur, outcome: event.target.value })),
                      })),
                    h('div', { className: 'wl-phase-actions' },
                      h('button', { className: 'wl-btn primary', onClick: savePhase },
                        phaseEditing.id ? '保存阶段' : '创建阶段'),
                      h('button', { className: 'wl-btn', onClick: () => setPhaseEditing(null) }, '取消')))
                : h('button', {
                    className: 'wl-phase-add',
                    onClick: () => setPhaseEditing({
                      id: null,
                      name: '',
                      start: task.start || dayOf(),
                      end: task.end || addDays(task.start || dayOf(), 14),
                      outcome: '',
                      status: 'planned',
                    }),
                  }, '+ 新建阶段'));
          })(),
          h('div', { className: 'wl-field' },
            h('label', null, `颜色${draft.color ? '' : '（默认跟随项目）'}`),
            h('div', { className: 'wl-colors' },
              h('button', {
                className: 'wl-color auto' + (draft.color ? '' : ' on'),
                title: '跟随项目颜色',
                onClick: () => setDraft((current) => ({ ...current, color: '' })),
              }, '自动'),
              PALETTE.map((color) => h('button', {
                key: color,
                className: 'wl-color' + (draft.color === color ? ' on' : ''),
                style: { background: color },
                title: color,
                'aria-label': color,
                onClick: () => setDraft((current) => ({ ...current, color })),
              })))),
          h('button', {
            className: 'wl-more-toggle',
            onClick: () => setAdvanced((current) => !current),
            'aria-expanded': advanced,
          }, advanced ? '收起更多设置 ▴' : '更多设置（状态 / 进度 / 提醒 / 备注）▾'),
          advanced
            ? h(React.Fragment, null,
                h('div', { className: 'wl-row2' },
                  h('div', { className: 'wl-field' },
                    h('label', null, '状态'),
                    h('select', { value: draft.status, onChange: patch('status') },
                      Object.entries(STATUS).map(([key, meta]) => h('option', { key, value: key }, meta.label)))),
                  h('div', { className: 'wl-field' },
                    h('label', null, '优先级'),
                    h('select', { value: draft.priority, onChange: patch('priority') },
                      Object.entries(PRIORITY).map(([key, label]) => h('option', { key, value: key }, label))))),
                h('div', { className: 'wl-field' },
                  h('label', null, `进度 ${draft.progress}%`),
                  h('input', { type: 'range', min: 0, max: 100, step: 5, value: draft.progress, onChange: patch('progress') })),
                h('div', { className: 'wl-row2' },
                  h('div', { className: 'wl-field' },
                    h('label', null, '提醒时间'),
                    h('input', { type: 'datetime-local', value: draft.remindAt, onChange: patch('remindAt') })),
                  h('div', { className: 'wl-field' },
                    h('label', null, '提前（分钟）'),
                    h('input', { type: 'number', min: 0, max: 1440, value: draft.remindLead, onChange: patch('remindLead') }))),
                h('label', { className: 'wl-muted', style: { display: 'flex', gap: 7, alignItems: 'center' } },
                  h('input', { type: 'checkbox', checked: draft.milestone, onChange: patch('milestone') }),
                  '标记为里程碑（甘特图上显示为菱形节点）'),
                h('div', { className: 'wl-field' },
                  h('label', null, '备注'),
                  h('textarea', { value: draft.detail, onChange: patch('detail'), rows: 4, placeholder: '验收标准、依赖、会议结论…' })))
            : null),
        h('div', { className: 'wl-drawer-foot' },
          isNew ? null : h('button', {
            className: 'wl-btn wl-danger',
            onClick: remove,
            title: confirmDelete ? '再点一次确认删除' : '删除任务',
          }, confirmDelete ? '确认删除？' : '删除'),
          h('button', { className: 'wl-btn primary', onClick: save }, isNew ? '创建任务' : '保存')));
    }
    function Board({ ctx }) {
      const { data, loading, error, busy, day: storeDay } = useWorklog();
      const [anchor, setAnchor] = useState(() => {
        const current = monthOf(dayOf());
        const remembered = String(readJson('worklog.month.v1', ''));
        if (!/^\d{4}-\d{2}$/.test(remembered)) return current;
        // Only honour a remembered month within a year of today: an old or
        // corrupted value would otherwise open the board on an empty grid.
        const [ry, rm] = remembered.split('-').map(Number);
        const [cy, cm] = current.split('-').map(Number);
        const distance = Math.abs((ry - cy) * 12 + (rm - cm));
        return distance <= 12 ? remembered : current;
      });
      const [selected, setSelected] = useState(null);
      const [editing, setEditing] = useState(null);
      const [logDay, setLogDay] = useState(() => dayOf());
      const [logText, setLogText] = useState('');
      const [logMinutes, setLogMinutes] = useState('');
      const [logTask, setLogTask] = useState('');
      const [drag, setDrag] = useState(null);
      // 'calendar' is the default: a month grid reads faster than a Gantt
      // board for "what am I doing that day".
      const [view, setView] = useState(() => readJson('worklog.view.v1', 'calendar'));
      // Batch selection: ids checked by the user, cleared after every action.
      const [picked, setPicked] = useState(() => new Set());
      // The day whose completion log the side panel is showing.
      const [selectedDay, setSelectedDay] = useState(() => storeDay);
      // Follow the day across midnight instead of pinning the page's first day.
      useEffect(() => {
        setSelectedDay((current) => (current === storeDay ? current : storeDay));
        setLogDay((current) => (current === storeDay ? current : storeDay));
      }, [storeDay]);
      // A quick filter is worth more than another menu: most sessions are
      // "where is that task" or "show me only what is open".
      const [query, setQuery] = useState('');
      const [hideDone, setHideDone] = useState(false);
      // '' means "all groups"; a name narrows the board to one chunk of work.
      const [groupFilter, setGroupFilter] = useState('');
      const matchesFilter = useCallback((task) => {
        if (hideDone && task.status === 'done') return false;
        if (groupFilter && (task.group || '') !== groupFilter) return false;
        const needle = query.trim().toLowerCase();
        if (!needle) return true;
        return `${task.title} ${task.project} ${task.detail}`.toLowerCase().includes(needle);
      }, [query, hideDone, groupFilter]);
      const today = storeDay;

      useEffect(() => { writeJson('worklog.view.v1', view); }, [view]);
      useEffect(() => { writeJson('worklog.month.v1', anchor); }, [anchor]);

      // Paging to another month needs that month's day classification, which
      // only the host knows (holidays arrive from the government notice).
      useEffect(() => {
        if (data?.calendar?.month === anchor) return;
        reload(anchor).catch(() => undefined);
      }, [anchor, data?.calendar?.month]);

      const tasks = data?.tasks || [];
      const records = data?.records || [];
      const settings = data?.settings || { dayWidth: 26, sortBy: 'start' };
      const dayWidth = settings.dayWidth || 26;

      const range = useMemo(() => {
        const [y, m] = anchor.split('-').map(Number);
        const first = `${y}-${pad2(m)}-01`;
        const lastNum = new Date(Date.UTC(y, m, 0)).getUTCDate();
        return { start: first, days: lastNum };
      }, [anchor, tasks, matchesFilter]);

      const days = useMemo(
        () => Array.from({ length: range.days }, (_, i) => addDays(range.start, i)),
        [range],
      );

      const sorted = useMemo(() => {
        const rows = tasks.filter((task) => matchesFilter(task));
        const order = { high: 0, normal: 1, low: 2 };
        if (settings.sortBy === 'priority') rows.sort((a, b) => (order[a.priority] - order[b.priority]) || a.start.localeCompare(b.start));
        else if (settings.sortBy === 'project') rows.sort((a, b) => (a.project || '~').localeCompare(b.project || '~') || a.start.localeCompare(b.start));
        else if (settings.sortBy === 'status') rows.sort((a, b) => a.status.localeCompare(b.status) || a.start.localeCompare(b.start));
        else rows.sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title));
        return rows;
      }, [tasks, settings.sortBy, query, hideDone, groupFilter, today]);

      const counts = useMemo(() => {
        const active = tasks.filter((task) => task.status !== 'done');
        return {
          active: active.length,
          today: active.filter((task) => covers(task, today)).length,
          // Only a real past deadline is overdue; open-ended work never is.
          overdue: active.filter((task) => Boolean(task.end) && diffDays(task.end, today) > 0).length,
          done: tasks.filter((task) => task.status === 'done').length,
        };
      }, [tasks, today, data?.focusTaskIds]);

      const logTotal = useMemo(
        () => records.filter((record) => record.date === logDay).reduce((sum, record) => sum + (record.minutes || 0), 0),
        [records, logDay],
      );
      const dayRecords = useMemo(
        () => records.filter((record) => record.date === logDay).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
        [records, logDay],
      );
      // Today's check-ins, shared by the summary cards and the day log.
      const checkedToday = useMemo(() => new Set(data?.checkin?.marked || []), [data?.checkin]);
      const doneToday = useMemo(
        () => tasks.filter((task) => checkedToday.has(task.id)),
        [tasks, checkedToday],
      );
      const toggleCheckin = (task, date) => {
        mutate({ action: 'checkin.toggle', taskId: task.id, date: date || today }).catch(() => undefined);
      };

      // One colour per workstream, assigned in a stable order (projects and
      // groups sorted) so the three views agree and colours never shuffle
      // between renders.
      const colorBook = useMemo(() => {
        const book = makeColorBook();
        const labels = [
          ...(data?.groups || []).map((group) => group.name),
          ...(data?.projects || []).map((project) => project.name),
        ];
        for (const task of tasks) labels.push(labelOf(task));
        for (const label of [...new Set(labels)].sort()) book(label);
        return book;
      }, [data?.groups, data?.projects, tasks]);
      const taskColor = useCallback((task) => task.color || colorBook(labelOf(task)), [colorBook]);
      const labelColor = useCallback((label) => colorBook(label || '未分组'), [colorBook]);

      // Everyday tasks only, for the board's focus cards and the dock.
      const everydayIds = useMemo(() => new Set(data?.focusTaskIds || []), [data?.focusTaskIds]);
      const hasFocusData = Array.isArray(data?.focusTaskIds);
      const isEveryday = useCallback(
        (task) => !hasFocusData || everydayIds.has(task.id),
        [everydayIds, hasFocusData],
      );

      const heat = data?.stats?.last30 || [];
      const heatMax = Math.max(1, ...heat.map((item) => item.minutes || 0));
      const taskName = (id) => tasks.find((task) => task.id === id)?.title || '';

      const beginDrag = (event, task, mode) => {
        event.preventDefault();
        event.stopPropagation();
        const originX = event.clientX;
        const move = (moveEvent) => {
          const delta = Math.round((moveEvent.clientX - originX) / dayWidth);
          setDrag({ id: task.id, mode, delta });
        };
        const up = (upEvent) => {
          document.removeEventListener('pointermove', move);
          document.removeEventListener('pointerup', up);
          const delta = Math.round((upEvent.clientX - originX) / dayWidth);
          setDrag(null);
          if (!delta) {
            // A press without movement is a click. preventDefault() on
            // pointerdown suppresses the native click, so the "open this task"
            // gesture has to be completed here — otherwise clicking another bar
            // while a drawer is open does nothing.
            if (mode === 'move') {
              setSelected(task.id);
              setEditing(task);
            }
            return;
          }
          const edge = mode === 'move' ? undefined : mode;
          mutate({ action: 'task.move', id: task.id, delta, edge }).catch(() => undefined);
        };
        document.addEventListener('pointermove', move);
        document.addEventListener('pointerup', up);
      };

      const barGeometry = (task) => {
        const startIdx = diffDays(range.start, task.start);
        // Open-ended work trails off past the last visible column instead of
        // pretending to end on some arbitrary day.
        const effectiveEnd = task.end || addDays(range.start, range.days - 1 + 3);
        const span = diffDays(task.start, effectiveEnd) + 1;
        let left = startIdx * dayWidth;
        let width = span * dayWidth;
        if (drag && drag.id === task.id) {
          if (drag.mode === 'move') left += drag.delta * dayWidth;
          else if (drag.mode === 'start') { left += drag.delta * dayWidth; width -= drag.delta * dayWidth; }
          else width += drag.delta * dayWidth;
        }
        if (width < dayWidth * 0.6) width = dayWidth * 0.6;
        return { left, width, visible: left + width > 0 && left < range.days * dayWidth };
      };

      const addRecord = async () => {
        if (!logText.trim()) return;
        try {
          await mutate({
            action: 'record.create',
            content: logText,
            minutes: Number(logMinutes) || 0,
            date: logDay,
            taskId: logTask || null,
          });
          setLogText('');
          setLogMinutes('');
        } catch {
          /* the store surfaces the error banner */
        }
      };

      /* --------------------------- batch actions --------------------------- */
      const pickedIds = useMemo(() => [...picked], [picked]);
      const togglePick = useCallback((id) => {
        setPicked((current) => {
          const next = new Set(current);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
      }, []);
      const clearPick = useCallback(() => { setPicked(new Set()); setBulkConfirm(false); }, []);
      // Group CRUD from the board; delete only detaches tasks.
      const runGroup = async (payload) => {
        try {
          await mutate({ action: 'group', ...payload });
        } catch {
          /* banner */
        }
      };
      // Inline group editor: { mode, name, value } | null.
      const [groupBusy, setGroupBusy] = useState(null);
      const [bulkConfirm, setBulkConfirm] = useState(false);
      const submitGroupEdit = () => {
        if (!groupBusy) return;
        const value = String(groupBusy.value || '').trim();
        if (!value) return;
        if (groupBusy.mode === 'create') {
          runGroup({ groupAction: 'create', name: value, focus: groupBusy.focus !== false });
        }
        else if (groupBusy.mode === 'rename' && value !== groupBusy.name) {
          runGroup({ groupAction: 'rename', from: groupBusy.name, name: value });
          if (groupFilter === groupBusy.name) setGroupFilter(value);
        }
        setGroupBusy(null);
      };
      const runBulk = async (op, extra) => {
        if (!pickedIds.length) return;
        try {
          await mutate({ action: 'task.bulk', ids: pickedIds, op, ...(extra || {}) });
          clearPick();
        } catch {
          /* the store surfaces the error banner */
        }
      };
      // Everything overlapping the visible month: select-all should mean
      // "everything I can currently see", including open-ended work.
      const monthTaskIds = useMemo(() => {
        const firstNum = dayNum(range.start);
        const lastNum = dayNum(addDays(range.start, range.days - 1));
        return tasks.filter((task) => matchesFilter(task))
          .filter((task) => {
            const startNum = dayNum(task.start);
            const endNum = task.end ? dayNum(task.end) : Number.MAX_SAFE_INTEGER;
            return startNum <= lastNum && endNum >= firstNum;
          })
          .map((task) => task.id);
      }, [tasks, range, matchesFilter]);
      const allPicked = monthTaskIds.length > 0 && monthTaskIds.every((id) => picked.has(id));

      const openNewTask = (day, group) => {
        setSelected(null);
        setEditing({
          id: null,
          title: '',
          project: '',
          group: group || '',
          start: day || today,
          // No deadline until the user picks one; the drawer calls this "无期限".
          end: null,
          status: 'todo',
          priority: 'normal',
          progress: 0,
          detail: '',
          remindAt: '',
          remindLead: settings.defaultLead ?? 10,
          milestone: false,
        });
      };

      const gridStyle = dayWidth
        ? { gridTemplateColumns: `220px ${range.days * dayWidth}px` }
        : undefined;

      const headerCells = days.map((day) => {
        const isMonthStart = day.endsWith('-01');
        const classes = ['wl-day'];
        if (isWeekend(day)) classes.push('weekend');
        if (day === today) classes.push('today');
        if (isMonthStart) classes.push('monthStart');
        return h('div', {
          key: day,
          className: classes.join(' '),
          style: { width: dayWidth },
          title: day,
        },
          h('b', null, isMonthStart ? `${Number(day.slice(5, 7))}月` : Number(day.slice(8, 10))),
          h('span', null, weekday(day)));
      });

      const rows = sorted.map((task) => {
        const geo = barGeometry(task);
        const isOverdue = task.status !== 'done' && Boolean(task.end) && diffDays(task.end, today) > 0;
        const classes = ['wl-bar'];
        if (isOverdue) classes.push('overdue');
        if (selected === task.id) classes.push('selected');
        const trackWidth = range.days * dayWidth;
        // Phases of this project, drawn as segments INSIDE the task's own bar.
        // The chart stays one row per task; the segments are an at-a-glance
        // sketch, and the real detail lives in the task drawer.
        const taskPhases = (data?.phases || [])
          .filter((phase) => phase.taskId === task.id)
          .sort((a, b) => a.start.localeCompare(b.start));

        return h('div', { key: task.id, className: 'wl-row' },
          h('div', {
            className: 'wl-railCell',
            // No role=button here: it would wrap the checkbox control.
            onClick: (event) => {
              // Only bare rail space opens the editor; the checkbox handles its own.
              if (event.target !== event.currentTarget) return;
              setSelected(task.id);
              setEditing(task);
            },
          },
            h('div', { className: 'wl-rail-title' },
              h('span', {
                className: 'wl-cal-check' + (picked.has(task.id) ? ' on' : ''),
                role: 'checkbox',
                'aria-checked': picked.has(task.id),
                tabIndex: 0,
                title: '选中以便批量处理',
                onClick: (event) => { event.stopPropagation(); togglePick(task.id); },
                onKeyDown: (event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.stopPropagation();
                    event.preventDefault();
                    togglePick(task.id);
                  }
                },
              }, picked.has(task.id) ? '✓' : ''),
              h('span', {
                className: 'wl-rail-open',
                role: 'button',
                tabIndex: 0,
                title: '打开任务详情',
                onClick: () => { setSelected(task.id); setEditing(task); },
                onKeyDown: (event) => {
                  if (event.key === 'Enter') { setSelected(task.id); setEditing(task); }
                },
              }, task.title)),
            h('div', { className: 'wl-rail-sub' },
              // A task filed under a group but no project must not read 未分组.
              `${task.project || task.group || '未分组'} · ${STATUS[statusAt(task, today)]?.label || ''}`
              + (autoStarted(task, today) ? '（已到期自动开始）' : '')
              // How many stages this project has, so the segments have a legend.
              + (taskPhases.length ? ` · ${taskPhases.length} 阶段` : ''))),
          h('div', {
            className: 'wl-track',
            style: { width: trackWidth },
            onClick: (event) => {
              // Only bare track space creates a task, and only when no drawer is
              // open — otherwise a stray click would discard the task being
              // edited and swap in a blank form.
              if (event.target !== event.currentTarget) return;
              if (editing) return;
              const rect = event.currentTarget.getBoundingClientRect();
              const index = Math.floor((event.clientX - rect.left) / dayWidth);
              openNewTask(addDays(range.start, Math.max(0, Math.min(range.days - 1, index))));
            },
            title: editing ? '正在编辑任务，先保存或关闭' : '点击空白处新建任务',
          },
            geo.visible
              ? h('div', {
                  className: classes.join(' ')
                    + (task.end ? '' : ' open')
                    + (taskPhases.length ? ' has-segments' : ''),
                  'data-status': statusAt(task, today),
                  style: {
                    left: geo.left,
                    width: geo.width,
                    // Depth = completion. 0% reads as a pale wash of the
                    // project colour, 100% as the solid colour.
                    background: `color-mix(in srgb, ${taskColor(task)} ${barFill(task)}%, transparent)`,
                    borderColor: colorMixin(taskColor(task), 100),
                    color: barFill(task) >= 60 ? '#fff' : 'var(--dsw-alias-label-primary)',
                  },
                  onPointerDown: (event) => beginDrag(event, task, 'move'),
                  onClick: (event) => { event.stopPropagation(); setSelected(task.id); setEditing(task); },
                },
                  h('i', { className: 'wl-bar-fill', style: { width: `${task.progress || 0}%` } }),
                  h('span', { className: 'wl-bar-label' }, task.title),
                  // Phase segments sit inside the bar, pinned to its bottom
                  // edge. Offsets are measured in day-widths from the bar's own
                  // start, then expressed against the bar's pixel width — the
                  // same span the bar itself was drawn with.
                  taskPhases.length
                    ? h('span', { className: 'wl-bar-phases' },
                        taskPhases.map((phase) => {
                          const offsetPx = diffDays(task.start, phase.start) * dayWidth
                          const spanPx = (diffDays(phase.start, phase.end) + 1) * dayWidth
                          // Clamp into the bar: a phase may begin before the
                          // project or end after it, but its segment must stay
                          // within the bar it belongs to.
                          const rawLeft = Math.max(0, Math.min(geo.width, offsetPx))
                          const rawRight = Math.max(0, Math.min(geo.width, offsetPx + spanPx))
                          const clampedLeft = rawLeft
                          const clampedWidth = Math.max(0, rawRight - rawLeft)
                          if (clampedWidth <= 0) return null
                          return h('i', {
                            key: phase.id,
                            className: 'wl-bar-phase'
                              + (phase.status === 'done' ? ' done' : '')
                              + (phase.current ? ' current' : '')
                              + (phase.overdue ? ' late' : ''),
                            style: { left: clampedLeft, width: clampedWidth },
                            title: `${phase.name} · ${phase.start} 至 ${phase.end}${phase.outcome ? ' · ' + phase.outcome : ''}`,
                          })
                        }))
                    : null,
                  h('i', { className: 'wl-grip l', title: '拖动调整开始', onPointerDown: (event) => beginDrag(event, task, 'start') }),
                  h('i', { className: 'wl-grip r', title: '拖动调整结束', onPointerDown: (event) => beginDrag(event, task, 'end') }))
              : task.milestone
                ? h('div', { className: 'wl-milestone', style: { left: geo.left } })
                : null));
      });

      const todayLeft = diffDays(range.start, today) * dayWidth;
      const trackWidth = range.days * dayWidth;
      const todayVisible = todayLeft >= 0 && todayLeft <= trackWidth;

      /* ----------------------------- group bar ----------------------------- */
      // One row of group chips: click a chip to focus that group, ✎ to rename,
      // × to delete. Creating and renaming use an inline field because
      // window.prompt() is disabled in Electron and would silently do nothing.
      const groupBar = h('div', { className: 'wl-groups' },
        h('button', {
          className: 'wl-group-chip all' + (groupFilter === '' ? ' on' : ''),
          onClick: () => setGroupFilter(''),
        }, '全部', h('b', null, tasks.length)),
        (data?.groups || []).map((group) => h('div', {
          key: group.name,
          // A long-term follow-up is visually set apart: dashed edge, muted, and
          // a mark saying it is hidden from the everyday surfaces.
          className: 'wl-group-chip'
            + (groupFilter === group.name ? ' on' : '')
            + (group.focus === false ? ' sidelined' : ''),
          title: group.focus === false
            ? `${group.name}：长期跟进，不在浮窗和日历里显示`
            : group.name,
        },
          h('span', {
            role: 'button',
            tabIndex: 0,
            title: `打开「${group.name}」项目面板，管理它的阶段`,
            onClick: () => setGroupFilter(groupFilter === group.name ? '' : group.name),
            onKeyDown: (event) => {
              if (event.key === 'Enter') setGroupFilter(groupFilter === group.name ? '' : group.name);
            },
          },
            group.focus === false ? h('em', { className: 'wl-group-lazy' }, '长线') : null,
            group.name,
            h('b', null, group.tasks)),
          h('button', {
            className: 'wl-group-act',
            title: group.focus === false ? '设为日常重点' : '设为长期跟进（不显示在浮窗和日历）',
            onClick: (event) => {
              event.stopPropagation();
              runGroup({ groupAction: 'focus', name: group.name, focus: !(group.focus !== false) });
            },
          }, group.focus === false ? '◎' : '◌'),
          h('button', {
            className: 'wl-group-act',
            title: '重命名分组',
            onClick: (event) => {
              event.stopPropagation();
              setGroupBusy({ mode: 'rename', name: group.name, value: group.name });
            },
          }, '✎'),
          h('button', {
            className: 'wl-group-act danger',
            title: '删除分组（任务保留）',
            onClick: (event) => {
              event.stopPropagation();
              setGroupBusy({ mode: 'delete', name: group.name, value: '' });
            },
          }, '×'))),

        groupBusy
          ? h('div', { className: 'wl-group-edit' },
              groupBusy.mode === 'delete'
                ? h(React.Fragment, null,
                    h('span', { className: 'wl-group-edit-text' },
                      `删除「${groupBusy.name}」？组内任务会保留，只是不再分组。`),
                    h('button', {
                      className: 'wl-batch-btn danger',
                      onClick: () => {
                        if (groupFilter === groupBusy.name) setGroupFilter('');
                        runGroup({ groupAction: 'delete', name: groupBusy.name });
                        setGroupBusy(null);
                      },
                    }, '确认删除'),
                    h('button', { className: 'wl-batch-btn ghost', onClick: () => setGroupBusy(null) }, '取消'))
                : h(React.Fragment, null,
                    h('span', { className: 'wl-group-edit-text' },
                      groupBusy.mode === 'rename' ? '重命名为：' : '新分组：'),
                    h('input', {
                      className: 'wl-group-input',
                      value: groupBusy.value,
                      autoFocus: true,
                      placeholder: '分组名称',
                      onChange: (event) => setGroupBusy((current) => ({ ...current, value: event.target.value })),
                      onKeyDown: (event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          submitGroupEdit();
                        }
                        if (event.key === 'Escape') setGroupBusy(null);
                      },
                    }),
                    groupBusy.mode === 'create'
                      ? h('label', { className: 'wl-check-label', style: { fontSize: 11.5 } },
                          h('input', {
                            type: 'checkbox',
                            checked: groupBusy.focus === false,
                            onChange: (event) => setGroupBusy((current) => ({ ...current, focus: !event.target.checked })),
                          }),
                          '长期跟进')
                      : null,
                    h('button', {
                      className: 'wl-batch-btn',
                      onClick: submitGroupEdit,
                      disabled: !groupBusy.value.trim(),
                    }, groupBusy.mode === 'rename' ? '保存' : '创建'),
                    h('button', { className: 'wl-batch-btn ghost', onClick: () => setGroupBusy(null) }, '取消')))
          : h('button', {
              className: 'wl-group-chip add',
              title: '新建分组',
              onClick: () => setGroupBusy({ mode: 'create', name: '', value: '', focus: true }),
            }, '+ 分组'),

        groupFilter
          ? h('button', {
              className: 'wl-group-chip add',
              title: '把这个分组里的任务整组移到别处',
              onClick: () => setGroupBusy({ mode: 'move', name: groupFilter, value: '' }),
            }, `整组移动（${tasks.filter((task) => task.group === groupFilter).length}）`)
          : null,

        groupBusy && groupBusy.mode === 'move'
          ? h('div', { className: 'wl-group-edit' },
              h('span', { className: 'wl-group-edit-text' }, `把「${groupBusy.name}」整组移到：`),
              h('input', {
                className: 'wl-group-input',
                value: groupBusy.value,
                autoFocus: true,
                placeholder: '留空 = 取消分组',
                onChange: (event) => setGroupBusy((current) => ({ ...current, value: event.target.value })),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    const ids = tasks.filter((task) => task.group === groupBusy.name).map((task) => task.id);
                    if (ids.length) {
                      mutate({ action: 'task.bulk', ids, op: 'set', group: groupBusy.value.trim() }).catch(() => undefined);
                    }
                    setGroupBusy(null);
                  }
                  if (event.key === 'Escape') setGroupBusy(null);
                },
              }),
              h('button', {
                className: 'wl-batch-btn',
                onClick: () => {
                  const ids = tasks.filter((task) => task.group === groupBusy.name).map((task) => task.id);
                  if (ids.length) {
                    mutate({ action: 'task.bulk', ids, op: 'set', group: groupBusy.value.trim() }).catch(() => undefined);
                  }
                  setGroupBusy(null);
                },
              }, '移动'),
              h('button', { className: 'wl-batch-btn ghost', onClick: () => setGroupBusy(null) }, '取消'))
          : null);

      /* --------------------------- batch bar ------------------------------- */
      const batchBar = pickedIds.length
        ? h('div', { className: 'wl-batch', role: 'toolbar', 'aria-label': '批量操作' },
            h('span', { className: 'wl-batch-count' }, `已选 ${pickedIds.length} 项`),
            // Direct status/priority pickers: a batch state change should not
            // require hunting for a button named after one particular value.
            h('label', { className: 'wl-batch-field' },
              h('span', null, '状态'),
              h('select', {
                className: 'wl-batch-select',
                value: '',
                onChange: (event) => {
                  if (!event.target.value) return;
                  runBulk('set', { status: event.target.value });
                },
              },
                h('option', { value: '' }, '批量设为…'),
                Object.entries(STATUS).map(([key, meta]) => h('option', { key, value: key }, meta.label)))),
            h('label', { className: 'wl-batch-field' },
              h('span', null, '优先级'),
              h('select', {
                className: 'wl-batch-select',
                value: '',
                onChange: (event) => {
                  if (!event.target.value) return;
                  runBulk('set', { priority: event.target.value });
                },
              },
                h('option', { value: '' }, '批量设为…'),
                Object.entries(PRIORITY).map(([key, label]) => h('option', { key, value: key }, label)))),
            h('button', { className: 'wl-batch-btn', onClick: () => runBulk('complete') }, '标记完成'),
            h('button', { className: 'wl-batch-btn', onClick: () => runBulk('reopen') }, '重新打开'),
            h('button', { className: 'wl-batch-btn', onClick: () => runBulk('move', { delta: 1 }) }, '顺延 1 天'),
            h('button', { className: 'wl-batch-btn', onClick: () => runBulk('move', { delta: -1 }) }, '提前 1 天'),
            h('button', {
              className: 'wl-batch-btn',
              onClick: () => runBulk('set', { priority: 'high' }),
            }, '设为高优'),
            h('label', { className: 'wl-batch-field' },
              h('span', null, '分组'),
              h('select', {
                className: 'wl-batch-select',
                value: '',
                onChange: (event) => {
                  if (event.target.value === '') return;
                  runBulk('set', { group: event.target.value });
                },
              },
                h('option', { value: '' }, '批量归组…'),
                h('option', { value: '' , disabled: true }, '—'),
                (data?.groups || []).map((group) => h('option', { key: group.name, value: group.name }, group.name)))),
            h('label', { className: 'wl-batch-field' },
              h('span', null, '项目'),
              h('input', {
                className: 'wl-batch-select',
                placeholder: '归入项目…',
                defaultValue: '',
                onKeyDown: (event) => {
                  if (event.key !== 'Enter') return;
                  event.preventDefault();
                  runBulk('set', { project: event.currentTarget.value.trim() });
                  event.currentTarget.value = '';
                },
              })),
            h('button', {
              className: 'wl-batch-btn danger',
              onClick: () => {
                // Two-step, like the drawer: native dialogs are unavailable in
                // the desktop shell.
                if (!bulkConfirm) {
                  setBulkConfirm(true);
                  return;
                }
                setBulkConfirm(false);
                runBulk('delete');
              },
              title: bulkConfirm ? '再点一次确认删除' : '删除选中的任务',
            }, bulkConfirm ? `确认删除 ${pickedIds.length} 项？` : '删除'),
            h('button', { className: 'wl-batch-btn ghost', onClick: clearPick }, '取消选择'))
        : null;

      const drawer = editing
        ? h(TaskDrawer, {
            // Key on the target id: switching tasks must start a clean draft, not
            // inherit the previous task's unsaved field values.
            key: editing.id || 'new',
            task: editing,
            projects: (data?.projects || []).map((item) => item.name),
            groups: data?.groups || [],
            phases: data?.phases || [],
            onClose: () => setEditing(null),
          })
        : null;

      const logPanel = h('div', { className: 'wl-logs' },
        h('div', { className: 'wl-logs-head' },
          '工作记录',
          h('span', { className: 'wl-muted', style: { fontWeight: 400 } }, `${dayRecords.length} 条 · ${formatMinutes(logTotal)}`),
          h('div', { className: 'wl-daynav' },
            h('button', { onClick: () => setLogDay(addDays(logDay, -1)), title: '前一天' }, '‹'),
            h('span', { style: { minWidth: 82, textAlign: 'center', fontSize: 11.5 } }, logDay === today ? '今天' : logDay),
            h('button', { onClick: () => setLogDay(addDays(logDay, 1)), title: '后一天' }, '›'),
            logDay !== today ? h('button', { onClick: () => setLogDay(today) }, '回到今天') : null)),
        h('div', { className: 'wl-log-list' },
          dayRecords.length
            ? dayRecords.map((record) => h('div', { key: record.id, className: 'wl-log' },
                h('span', { className: 'wl-log-task' }, record.taskId ? taskName(record.taskId) : '随手记'),
                h('span', { className: 'wl-log-text' }, record.content),
                record.minutes ? h('span', { className: 'wl-log-min' }, formatMinutes(record.minutes)) : null,
                h('button', {
                  className: 'wl-log-del',
                  title: '删除这条记录',
                  onClick: () => mutate({ action: 'record.delete', id: record.id }).catch(() => undefined),
                }, '×')))
            : h('div', { className: 'wl-muted' }, '这天还没有记录。写下完成的事、卡点和明天的第一步。')),
        h('div', { className: 'wl-compose' },
          h('textarea', {
            value: logText,
            placeholder: `记录 ${logDay === today ? '今天' : logDay} 的工作（Ctrl+Enter 提交）`,
            onChange: (event) => setLogText(event.target.value),
            onKeyDown: (event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                event.preventDefault();
                addRecord();
              }
            },
          }),
          h('input', {
            type: 'number', min: 0, max: 1440, value: logMinutes, placeholder: '分钟',
            onChange: (event) => setLogMinutes(event.target.value),
          }),
          h('button', { className: 'wl-btn primary', onClick: addRecord, disabled: busy || !logText.trim() }, '记下')));

      /* ------------------------- side panel ------------------------- */
      // The side panel is where the real detail lives: which tasks were
      // completed on the selected day, and every note written about it. The
      // calendar itself only carries the glyphs.
      const selectedChecks = (data?.checkins || []).filter((row) => row.date === selectedDay);
      const selectedRecords = records
        .filter((record) => record.date === selectedDay)
        .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
      const selectedTasks = selectedChecks
        .map((checkin) => tasks.find((task) => task.id === checkin.taskId))
        .filter(Boolean);
      const selectedName = (task) => task.title || '未命名任务';
      const selectedLabel = selectedDay === today ? '今天' : selectedDay;

      /* --------------------- phase summary (read-only) --------------------- */
      // Phase editing lives in the project panel, opened from a group chip.
      // The side column just shows which project is being tracked and how far
      // its current phase has got, so the board stays a board.
      const focusedPhases = groupFilter
        ? (data?.phases || []).filter((phase) => phase.group === groupFilter)
        : []
      const currentPhase = focusedPhases.find((phase) => phase.current)
      const phaseSummary = groupFilter
        ? h('div', { className: 'wl-card' },
            h('div', { className: 'wl-card-head' },
              h('h3', null, `${groupFilter} · 阶段`),
              h('button', {
                className: 'wl-batch-btn',
                onClick: () => setGroupFilter(groupFilter),
                title: '打开项目面板，管理阶段',
              }, '管理')),
            currentPhase
              ? h('div', { className: 'wl-muted' },
                  `当前阶段：${currentPhase.name}（${currentPhase.progress}%）`)
              : h('div', { className: 'wl-muted' },
                  focusedPhases.length
                    ? `共 ${focusedPhases.length} 个阶段，当前不在任何阶段内。`
                    : '还没有阶段。打开项目面板即可划分。'))
        : null

      const sidePanel = h('aside', { className: 'wl-side' },
        // 0) A one-line phase summary; editing happens in the project panel.
        phaseSummary,
        // 1) Completed tasks for the selected day — the primary content.
        h('div', { className: 'wl-card' },
          h('div', { className: 'wl-card-head' },
            h('h3', null, `${selectedLabel}完成`),
            h('span', { className: 'wl-card-count' }, String(selectedTasks.length))),
          selectedTasks.length
            ? selectedTasks.map((task) => h('div', {
                key: task.id,
                className: 'wl-mini wl-mini-done',
                title: `${selectedName(task)} · 点击查看`,
                role: 'button',
                tabIndex: 0,
                onClick: () => { setSelected(task.id); setEditing(task); },
                onKeyDown: (event) => { if (event.key === 'Enter') { setSelected(task.id); setEditing(task); } },
              },
                h('i', { className: 'wl-sum-dot', style: { background: taskColor(task) } }),
                h('span', { className: 'wl-mini-text' }, selectedName(task)),
                task.group || task.project
                  ? h('span', { className: 'wl-mini-when' }, task.group || task.project)
                  : null))
            : h('div', { className: 'wl-muted' },
                selectedDay === today ? '今天还没有勾选完成的任务。' : '这天没有勾选完成的任务。')),

        // 2) Notes written about the selected day (the ✎ glyph in the cell).
        h('div', { className: 'wl-card' },
          h('div', { className: 'wl-card-head' },
            h('h3', null, `${selectedLabel}备注`),
            h('span', { className: 'wl-card-count' }, String(selectedRecords.length))),
          selectedRecords.length
            ? selectedRecords.map((record) => h('div', { key: record.id, className: 'wl-side-note' },
                h('span', { className: 'wl-side-note-text' }, record.content),
                h('div', { className: 'wl-side-note-meta' },
                  record.minutes ? h('span', null, formatMinutes(record.minutes)) : null,
                  h('button', {
                    className: 'wl-side-note-del',
                    title: '删除这条备注',
                    onClick: () => mutate({ action: 'record.delete', id: record.id }).catch(() => undefined),
                  }, '×'))))
            : h('div', { className: 'wl-muted' }, '还没有备注。浮窗里随手记的内容会出现在这里。')),

        // 3) Open work, so the panel still answers "what is on my plate".
        h('div', { className: 'wl-card' },
          h('h3', null, '进行中的任务'),
          (data?.digest?.today || []).filter(isEveryday).length
            ? data.digest.today.filter(isEveryday).slice(0, 6).map((task) => h('div', {
                key: task.id,
                className: 'wl-mini',
                title: task.title,
                role: 'button',
                tabIndex: 0,
                onClick: () => { setSelected(task.id); setEditing(task); },
                onKeyDown: (event) => { if (event.key === 'Enter') { setSelected(task.id); setEditing(task); } },
              },
                h('i', { className: 'wl-sum-dot', style: { background: taskColor(task) } }),
                h('span', { className: 'wl-mini-text' }, task.title),
                h('span', { className: 'wl-mini-when' }, `${task.progress || 0}%`)))
            : h('div', { className: 'wl-muted' }, '今天没有排期任务。')),

        (data?.digest?.overdue || []).filter(isEveryday).length
          ? h('div', { className: 'wl-card' },
              h('h3', null, '逾期'),
              data.digest.overdue.filter(isEveryday).slice(0, 4).map((task) => h('div', {
                key: task.id,
                className: 'wl-mini',
                title: task.title,
                role: 'button',
                tabIndex: 0,
                onClick: () => { setSelected(task.id); setEditing(task); },
                onKeyDown: (event) => { if (event.key === 'Enter') { setSelected(task.id); setEditing(task); } },
              },
                h('span', { className: 'wl-dot blocked' }),
                h('span', { className: 'wl-mini-text' }, task.title),
                h('span', { className: 'wl-mini-when' }, `${diffDays(task.end, today)} 天`))))
          : null,

        // 4) Recording intensity, kept because it is the only long-range view.
        h('div', { className: 'wl-card' },
          h('h3', null, '近 30 天记录强度'),
          h('div', { className: 'wl-heat' },
            heat.map((item) => h('i', {
              key: item.date,
              title: `${item.date} · ${formatMinutes(item.minutes)}`,
              style: {
                height: `${Math.max(8, Math.round((item.minutes / heatMax) * 100))}%`,
                background: item.minutes
                  ? `color-mix(in srgb, var(--dsw-alias-brand-primary) ${Math.min(100, 25 + (item.minutes / heatMax) * 75)}%, transparent)`
                  : undefined,
              },
            }))),
          h('div', { className: 'wl-hint', style: { marginTop: 7 } }, `累计 ${formatMinutes(data?.stats?.totalMinutes || 0)}`)),
        h('div', { className: 'wl-card' },
          h('h3', null, '提醒与规则'),
          h('div', { className: 'wl-field' },
            h('label', null, '每日汇总提醒'),
            h('input', {
              type: 'time',
              value: settings.digestAt || '09:30',
              onChange: (event) => mutate({ action: 'settings.update', settings: { digestAt: event.target.value } }).catch(() => undefined),
            })),
          h('label', { className: 'wl-check-label' },
            h('input', {
              type: 'checkbox',
              checked: settings.workdaysOnly !== false,
              onChange: (event) => mutate({ action: 'settings.update', settings: { workdaysOnly: event.target.checked } }).catch(() => undefined),
            }),
            '新任务只排在工作日'),
          h('div', { className: 'wl-hint' }, '自动跳过周末与法定节假日，调休上班日照常排期。'),
          h('div', { className: 'wl-field' },
            h('label', null, '甘特图每天宽度'),
            h('input', {
              type: 'range', min: 16, max: 56, step: 2,
              value: dayWidth,
              onChange: (event) => mutate({ action: 'settings.update', settings: { dayWidth: Number(event.target.value) } }).catch(() => undefined),
            })),
          h('button', {
            className: 'wl-btn',
            style: { marginTop: 6, width: '100%' },
            onClick: () => mutate({ action: 'holidays.refresh' }).catch(() => undefined),
          }, '刷新节假日数据')));

      const canvas = h('div', { className: 'wl-canvas' },
        h('div', { className: 'wl-bg', style: { width: trackWidth } },
          days.map((day) => h('i', {
            key: day,
            className: (isWeekend(day) ? 'weekend' : '') + (day === today ? ' todayCol' : ''),
            style: { width: dayWidth },
          }))),
        todayVisible ? h('div', { className: 'wl-today', style: { left: 220 + todayLeft } }) : null,
        h('div', { className: 'wl-headRow' },
          h('div', { className: 'wl-corner' }, '任务 / 项目'),
          h('div', { className: 'wl-days', style: { width: trackWidth } }, headerCells)),
        rows.length
          ? rows
          : h('div', { className: 'wl-emptyRow', style: { width: 220 + trackWidth } },
              data ? '这个月还没有任务。点任意空白日期格，或右上角「+ 新任务」开始规划。' : '正在读取工作记录…'));

      /* ------------------------------ summary ------------------------------ */
      // A third view: how the work actually went, not what is planned. Bars are
      // working time (blocked time excluded), plus completion and check-in
      // counts so the same table answers "how long" and "how consistently".
      const summaryRows = data?.durations || [];
      const rollupRows = data?.rollup || [];
      const maxWork = Math.max(1, ...summaryRows.map((row) => row.workingMinutes));
      const totalWork = summaryRows.reduce((sum, row) => sum + row.workingMinutes, 0);
      const totalBlocked = summaryRows.reduce((sum, row) => sum + row.blockedMinutes, 0);
      const finishedCount = summaryRows.filter((row) => row.finishedAt).length;

      const summary = h('div', { className: 'wl-summary' },
        h('div', { className: 'wl-sum-cards' },
          h('div', { className: 'wl-sum-card' },
            h('b', null, formatMinutes(totalWork)),
            h('span', null, '累计工时')),
          h('div', { className: 'wl-sum-card' },
            h('b', null, formatMinutes(totalBlocked)),
            h('span', null, '受阻暂停')),
          h('div', { className: 'wl-sum-card' },
            h('b', null, String(finishedCount)),
            h('span', null, '已完成任务')),
          h('div', { className: 'wl-sum-card' },
            h('b', null, String(doneToday.length)),
            h('span', null, '今日打卡'))),

        h('div', { className: 'wl-sum-sect' }, '按任务'),
        summaryRows.length
          ? h('div', { className: 'wl-sum-table' },
              h('div', { className: 'wl-sum-tr wl-sum-th' },
                h('span', null, '任务'),
                h('span', null, '工时'),
                h('span', null, '受阻'),
                h('span', null, '跨度'),
                h('span', null, '打卡')),
              summaryRows.map((row) => h('div', { key: row.taskId, className: 'wl-sum-tr' },
                h('span', { className: 'wl-sum-name', title: row.title },
                  h('i', { className: 'wl-sum-dot', style: { background: row.color || taskColor(row) } }),
                  row.title),
                h('span', { className: 'wl-sum-bar' },
                  h('i', {
                    style: {
                      width: `${Math.max(2, Math.round((row.workingMinutes / maxWork) * 100))}%`,
                      background: row.color || taskColor(row),
                    },
                  }),
                  h('em', null, formatMinutes(row.workingMinutes))),
                h('span', { className: 'wl-sum-muted' }, row.blockedMinutes ? formatMinutes(row.blockedMinutes) : '—'),
                h('span', { className: 'wl-sum-muted' }, row.leadDays ? `${row.leadDays} 天` : '—'),
                h('span', { className: 'wl-sum-muted' }, row.checkinDays ? `${row.checkinDays} 次` : '—'))))
          : h('div', { className: 'wl-muted', style: { padding: '10px 2px' } }, '还没有数据。把任务标记为「进行中」后这里会开始计时。'),

        h('div', { className: 'wl-sum-sect' }, '按项目'),
        rollupRows.length
          ? h('div', { className: 'wl-sum-projects' },
              rollupRows.map((row) => {
                const share = totalWork ? Math.round((row.workingMinutes / totalWork) * 100) : 0;
                return h('div', { key: row.project, className: 'wl-sum-proj' },
                  h('span', { className: 'wl-sum-proj-name' },
                    h('i', { className: 'wl-sum-dot', style: { background: labelColor(row.project) } }),
                    row.project),
                  h('span', { className: 'wl-sum-proj-bar' },
                    h('i', { style: { width: `${Math.max(2, share)}%`, background: labelColor(row.project) } })),
                  h('span', { className: 'wl-sum-muted' }, `${formatMinutes(row.workingMinutes)} · ${row.done}/${row.tasks}`));
              }))
          : null,

        h('div', { className: 'wl-hint', style: { marginTop: 10 } },
          '工时只统计「进行中」的时间：标记为受阻或已完成期间不计时。'));

      /* ------------------------------ calendar ------------------------------ */
      // A standard month grid: six weeks of cells, each listing that day's
      // tasks and log entries. This is the '看日历' view; the Gantt board stays
      // for planning spans. Both read the same store.
      const calendarWeeks = useMemo(() => {
        const [y, m] = anchor.split('-').map(Number);
        const first = `${y}-${pad2(m)}-01`;
        // Monday-first grid: step back to the Monday on or before the 1st.
        const firstNum = dayNum(first);
        const weekdayOfFirst = (new Date(firstNum * 86400000).getUTCDay() + 6) % 7;
        const gridStart = numDay(firstNum - weekdayOfFirst);
        return Array.from({ length: 6 }, (_, week) =>
          Array.from({ length: 7 }, (_, day) => addDays(gridStart, week * 7 + day)),
        );
      }, [anchor]);

      // Day classification from the host: holidays, 调休 workdays, weekends.
      const dayFacts = useMemo(() => {
        const map = new Map();
        for (const entry of data?.calendar?.days || []) map.set(entry.day, entry);
        return map;
      }, [data?.calendar]);

      const calendarDayCell = (day) => {
        const inMonth = monthOf(day) === anchor;
        const fact = dayFacts.get(day);
        const classes = ['wl-cal-cell'];
        if (!inMonth) classes.push('outside');
        if (day === today) classes.push('today');
        if (isWeekend(day)) classes.push('weekend');
        // Working days carry a soft wash; between them and the weekend tints
        // the month reads as work blocks rather than a flat white grid.
        else if (!fact?.off) classes.push('weekday');
        if (fact?.off) classes.push('rest');
        if (fact?.holiday) classes.push('holiday');
        if (fact?.makeup) classes.push('makeup');
        if (day === selectedDay) classes.push('selected');

        // The month grid is a completion log, not a workload chart. It shows
        // how many tasks were checked off that day plus a glyph for the notes
        // written about it — the same facts the floating dock records. Names
        // and detail live in the side panel for the selected day.
        const dayCheckins = (data?.checkins || []).filter((row) => row.date === day);
        const dayRecords = records.filter((record) => record.date === day);
        const doneCount = dayCheckins.length;
        const noteCount = dayRecords.length;
        if (doneCount || noteCount) classes.push('has-checkin');

        const items = [
          h('div', { key: 'num', className: 'wl-cal-daynum' },
            Number(day.slice(8, 10)),
            doneCount ? h('em', { className: 'wl-cal-done' }, `✓${doneCount}`) : null),
          fact?.holiday && fact.name
            ? h('div', { key: 'fest', className: 'wl-cal-fest' }, fact.name)
            : fact?.makeup
              ? h('div', { key: 'fest', className: 'wl-cal-fest makeup' }, '调休上班')
              : null,
        ];

        // Symbol row: one mark per recorded fact, no text. Task check-offs use a
        // check glyph tinted by that task's colour; notes use a pencil.
        const marks = [];
        for (const checkin of dayCheckins.slice(0, 5)) {
          const task = tasks.find((item) => item.id === checkin.taskId);
          marks.push(h('i', {
            key: 'c' + checkin.id,
            className: 'wl-cal-mark done',
            style: { color: task ? taskColor(task) : undefined },
            title: task ? `完成：${task.title}` : '完成的任务',
          }, '✓'));
        }
        if (noteCount) {
          marks.push(h('i', {
            key: 'note',
            className: 'wl-cal-mark note',
            title: `${noteCount} 条备注`,
          }, '✎'));
        }
        if (marks.length) items.push(h('div', { key: 'marks', className: 'wl-cal-marks' }, marks));

        return h('div', {
          key: day,
          className: classes.join(' '),
          // Selecting a day fills the side panel; creating a task needs the
          // explicit + button so a click never surprises the user.
          onClick: () => setSelectedDay(day),
          title: `${day}${doneCount ? ` · 完成 ${doneCount} 项` : ''}${noteCount ? ` · ${noteCount} 条备注` : ''}`,
        }, items);
      };

      const calendar = h('div', { className: 'wl-cal' },
        h('div', { className: 'wl-cal-head' },
          ['一', '二', '三', '四', '五', '六', '日'].map((name) => h('div', { key: name, className: 'wl-cal-dow' }, `周${name}`))),
        calendarWeeks.map((week, index) => h('div', { key: index, className: 'wl-cal-week' }, week.map(calendarDayCell))),
      );

      return h('div', { className: 'wl-root' },
        h(StyleOnce),
        h('header', { className: 'wl-head' },
          h('div', { className: 'wl-brand' }, h('span', { className: 'wl-mark' }, '◷'), view === 'calendar' ? '工作记录 · 日历' : view === 'summary' ? '工作记录 · 汇总' : '工作记录 · 甘特图'),
          h('div', { className: 'wl-head-actions' },
            h('div', { className: 'wl-monthnav' },
              h('button', {
                className: 'wl-nav-btn',
                'aria-label': '上个月',
                title: '上个月（←）',
                onClick: () => setAnchor((current) => {
                  const [y, m] = current.split('-').map(Number);
                  return monthOf(dayOf(new Date(y, m - 2, 1)));
                }),
              }, '‹'),
              h('div', { className: 'wl-month-cur' },
                h('select', {
                  className: 'wl-month-select',
                  value: anchor.slice(0, 4),
                  'aria-label': '年份',
                  onChange: (event) => setAnchor(`${event.target.value}-${anchor.slice(5, 7)}`),
                },
                  // A few years either way covers planning without a huge list.
                  Array.from({ length: 7 }, (_, i) => Number(anchor.slice(0, 4)) - 3 + i)
                    .map((year) => h('option', { key: year, value: String(year) }, `${year} 年`))),
                h('select', {
                  className: 'wl-month-select',
                  value: anchor.slice(5, 7),
                  'aria-label': '月份',
                  onChange: (event) => setAnchor(`${anchor.slice(0, 4)}-${event.target.value}`),
                },
                  Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, '0'))
                    .map((month) => h('option', { key: month, value: month }, `${Number(month)} 月`)))),
              h('button', {
                className: 'wl-nav-btn',
                'aria-label': '下个月',
                title: '下个月（→）',
                onClick: () => setAnchor((current) => {
                  const [y, m] = current.split('-').map(Number);
                  return monthOf(dayOf(new Date(y, m, 1)));
                }),
              }, '›')),
            h('button', { className: 'wl-btn', onClick: () => setAnchor(monthOf(today)) }, '今天'),
            h('input', {
              className: 'wl-search',
              placeholder: '搜索任务…',
              value: query,
              onChange: (event) => setQuery(event.target.value),
              'aria-label': '搜索任务',
            }),
            h('button', {
              className: 'wl-btn' + (hideDone ? ' on' : ''),
              title: hideDone ? '显示已完成' : '隐藏已完成',
              onClick: () => setHideDone((current) => !current),
            }, hideDone ? '全部' : '隐藏已完成'),
            h('div', { className: 'wl-switch', role: 'tablist' },
              h('button', {
                className: 'wl-switch-btn' + (view === 'calendar' ? ' on' : ''),
                role: 'tab',
                'aria-selected': view === 'calendar',
                onClick: () => setView('calendar'),
              }, '日历'),
              h('button', {
                className: 'wl-switch-btn' + (view === 'gantt' ? ' on' : ''),
                role: 'tab',
                'aria-selected': view === 'gantt',
                onClick: () => setView('gantt'),
              }, '甘特'),
              h('button', {
                className: 'wl-switch-btn' + (view === 'summary' ? ' on' : ''),
                role: 'tab',
                'aria-selected': view === 'summary',
                onClick: () => setView('summary'),
              }, '汇总')),
            h('select', {
              className: 'wl-select',
              value: settings.sortBy,
              title: '排序方式',
              onChange: (event) => mutate({ action: 'settings.update', settings: { sortBy: event.target.value } }).catch(() => undefined),
            },
              h('option', { value: 'start' }, '按开始时间'),
              h('option', { value: 'priority' }, '按优先级'),
              h('option', { value: 'project' }, '按项目'),
              h('option', { value: 'status' }, '按状态')),
            h('button', {
              className: 'wl-btn' + (settings.floatEnabled === false ? '' : ' on'),
              title: settings.floatEnabled === false ? '打开右下角浮窗' : '关闭右下角浮窗',
              onClick: () => mutate({
                action: 'settings.update',
                settings: { floatEnabled: settings.floatEnabled === false },
              }).catch(() => undefined),
            }, settings.floatEnabled === false ? '浮窗：关' : '浮窗：开'),
            h('button', { className: 'wl-btn primary', onClick: () => openNewTask(today) }, '+ 新任务'))),

        h('div', { className: 'wl-stats' },
          monthTaskIds.length
            ? h('button', {
                className: 'wl-stat wl-stat-btn' + (allPicked ? ' on' : ''),
                title: allPicked ? '取消全选' : '选中本月全部任务',
                onClick: () => setPicked(allPicked ? new Set() : new Set(monthTaskIds)),
              },
                h('b', null, allPicked ? '✓' : '全选'),
                h('span', null, `本月 ${monthTaskIds.length} 项`))
            : null,
          h(StatCard, { value: counts.active, label: '进行中' }),
          h(StatCard, { value: counts.today, label: '今天该做' }),
          h(StatCard, { value: counts.overdue, label: '已逾期', warn: counts.overdue > 0 }),
          h(StatCard, { value: formatMinutes(data?.stats?.today?.minutes || 0), label: '今日记录' }),
          h(StatCard, { value: counts.done, label: '已完成' })),

        error ? h('div', { className: 'wl-error' }, error) : null,
        loading && !data ? h('div', { className: 'wl-muted', style: { padding: '10px 24px' } }, '正在读取工作记录…') : null,

        groupBar,
        batchBar,

        h('div', { className: 'wl-body' },
          h('div', { className: 'wl-main' },
            // One shell for every view, so switching tabs never shifts the
            // frame by a border width or a padding step.
            h('div', { className: 'wl-stage' },
              view === 'calendar'
                ? calendar
                : h('div', { className: 'wl-stagescroll' },
                    view === 'summary' ? summary : canvas)),
            logPanel),
          sidePanel),
        drawer);
    }

    /* ------------------------------------------------------------------ *
     * Floating dock (shell.overlay)
     * Draggable, collapsible, and the single owner of the reminder timer so
     * reminders fire wherever the user is in the app.
     * ------------------------------------------------------------------ */

    /**
     * Mount a subtree on document.body so position:fixed resolves against the
     * viewport regardless of the slot host's stacking context.
     */
    // Optional: the app shell owns React, and react-dom may or may not be in
    // the shared module table. Resolve it lazily so a missing module can never
    // break materialization of the whole plugin.
    let reactDomCache;
    function getReactDom() {
      if (reactDomCache !== undefined) return reactDomCache;
      try {
        reactDomCache = require('react-dom');
      } catch {
        reactDomCache = null;
      }
      return reactDomCache;
    }

    function Portaled({ children }) {
      const [host, setHost] = useState(null);
      const reactDom = getReactDom();
      useEffect(() => {
        if (!getReactDom() || typeof getReactDom().createPortal !== 'function') return undefined;
        const node = document.createElement('div');
        node.setAttribute('data-worklog-portal', '');
        document.body.appendChild(node);
        setHost(node);
        return () => node.remove();
      }, []);
      // No portal target yet, or no react-dom: render in place. The dock is
      // fixed-positioned either way, so it stays usable in both cases.
      if (!host || !reactDom || typeof reactDom.createPortal !== 'function') return children;
      return reactDom.createPortal(children, host);
    }

    function FloatingDock({ ctx, openPanel }) {
      const { data, day: storeDay } = useWorklog();
      const [collapsed, setCollapsed] = useState(() => readJson(COLLAPSE_KEY, false) === true);
      // Closed removes the dock entirely; collapsed shrinks it to one icon.
      const [closed, setClosed] = useState(false);
      const [pos, setPos] = useState(() => readJson(FLOAT_KEY, null));
      const [iconPos, setIconPos] = useState(() => readJson(ICON_KEY, null));
      const [text, setText] = useState('');
      const [newTaskText, setNewTaskText] = useState('');
      const [dockQuery, setDockQuery] = useState('');
      const [toasts, setToasts] = useState([]);
      const [permission, setPermission] = useState(() =>
        typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
      const tasks = data?.tasks || [];
      const settings = data?.settings || {};
      // The shared day flips at midnight and re-renders this panel with a fresh
      // check-in set, so yesterday's ticks never leak into today.
      const today = storeDay;

      // The persisted flag drives visibility; the board can flip it back on.
      useEffect(() => {
        if (!data?.settings) return;
        if (data.settings.floatEnabled === false) setClosed(true);
        else setClosed(false);
      }, [data?.settings?.floatEnabled]);

      // Keep a dragged panel fully on screen. The size used here is a floor,
      // not the real height: the body scrolls, so only the header must stay
      // reachable — clamping by the full height would strand the panel.
      const clamp = useCallback((next) => {
        const width = 308;
        const visibleHeight = 56;
        const maxX = Math.max(8, window.innerWidth - width - 12);
        const maxY = Math.max(8, window.innerHeight - visibleHeight - 12);
        return { x: Math.max(8, Math.min(maxX, next.x)), y: Math.max(8, Math.min(maxY, next.y)) };
      }, []);

      useEffect(() => { writeJson(COLLAPSE_KEY, collapsed); }, [collapsed]);

      const clampIcon = useCallback((next) => {
        const size = 46;
        const maxX = Math.max(8, (window.innerWidth || 1280) - size - 10);
        const maxY = Math.max(8, (window.innerHeight || 800) - size - 10);
        return { x: Math.max(8, Math.min(maxX, next.x)), y: Math.max(8, Math.min(maxY, next.y)) };
      }, []);

      // A window resize can leave a remembered position outside the viewport.
      // The same reconcile runs when the page is shown again: switching out of
      // full screen does not always fire resize before the next paint, and an
      // off-screen dock looks exactly like a missing one.
      useEffect(() => {
        const reconcile = () => {
          setPos((current) => (current ? clamp(current) : current));
          setIconPos((current) => (current ? clampIcon(current) : current));
        };
        const onVisible = () => { if (!document.hidden) reconcile(); };
        window.addEventListener('resize', reconcile);
        document.addEventListener('visibilitychange', onVisible);
        return () => {
          window.removeEventListener('resize', reconcile);
          document.removeEventListener('visibilitychange', onVisible);
        };
      }, [clamp, clampIcon]);
      // A remembered drag position wins; otherwise dock bottom-right. Both
      // paths yield the same {left, top} shape so a drag never switches
      // coordinate systems mid-flight.
      const placement = (() => {
        if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
          // Clamp here too: the first paint must never land off-screen, even
          // before the mount effect has run.
          const point = clamp({ x: pos.x, y: pos.y });
          return { left: point.x, top: point.y };
        }
        // Default: right edge, vertically centred. The bottom-right corner is
        // where other widgets live, and a panel there hides behind them.
        const width = 308;
        const height = collapsed ? 44 : 420;
        const viewportWidth = window.innerWidth || 1280;
        const viewportHeight = window.innerHeight || 800;
        return {
          left: Math.max(12, viewportWidth - width - 20),
          top: Math.max(12, Math.round((viewportHeight - height) / 2)),
        };
      })();

      /**
       * Drag the dock by its header. Coordinates are captured once on
       * pointerdown and the pointer is captured, so the gesture survives the
       * cursor leaving the header — a plain pointermove listener would drop it
       * the moment the pointer crosses an iframe or another app surface.
       */
      const beginDrag = (event) => {
        if (event.button !== 0 && event.pointerType === 'mouse') return;
        const panel = event.currentTarget.closest('.wl-float');
        if (!panel) return;
        const rect = panel.getBoundingClientRect();
        const offsetX = event.clientX - rect.left;
        const offsetY = event.clientY - rect.top;
        const target = event.currentTarget;
        // With pointer capture, moves are delivered to the capturing element
        // rather than to document, so the listener must live there. Without
        // it, document is the surface that keeps receiving the gesture.
        let captured = false;
        try {
          target.setPointerCapture?.(event.pointerId);
          captured = Boolean(target.hasPointerCapture?.(event.pointerId));
        } catch {
          captured = false;
        }
        const surface = captured ? target : document;

        // Suppress text selection while dragging across the panel.
        const previousSelect = document.body?.style?.userSelect;
        if (document.body?.style) document.body.style.userSelect = 'none';

        const move = (moveEvent) => {
          setPos(clamp({ x: moveEvent.clientX - offsetX, y: moveEvent.clientY - offsetY }));
        };
        const finish = () => {
          surface.removeEventListener('pointermove', move);
          surface.removeEventListener('pointerup', finish);
          surface.removeEventListener('pointercancel', finish);
          if (captured) {
            try {
              target.releasePointerCapture?.(event.pointerId);
            } catch {
              /* already released */
            }
          }
          if (document.body?.style) document.body.style.userSelect = previousSelect || '';
          // Read the latest position out of state and remember it.
          setPos((current) => {
            const settled = current && Number.isFinite(current.x) ? clamp(current) : current;
            if (settled) writeJson(FLOAT_KEY, settled);
            return settled;
          });
        };
        surface.addEventListener('pointermove', move);
        surface.addEventListener('pointerup', finish);
        surface.addEventListener('pointercancel', finish);
      };

      /* ------------------------- reminder engine ------------------------ */
      useEffect(() => {
        const check = () => {
          const now = Date.now();
          const { due } = collectDue(tasks, settings, now);
          if (!due.length) return;
          const fired = readJson(REMIND_KEY, {});
          for (const task of due) {
            fired[task.id] = task.remindAt;
            setToasts((current) => [
              ...current.filter((item) => item.key !== task.id + task.remindAt),
              { key: task.id + task.remindAt, taskId: task.id, title: task.title, due: task.remindAt },
            ]);
            notify('工作提醒：' + task.title, `${task.remindAt.replace('T', ' ')} · ${task.project || task.group || '未分组'}`);
          }
          writeJson(REMIND_KEY, fired);
        };
        check();
        const timer = window.setInterval(check, 20000);
        return () => window.clearInterval(timer);
      }, [tasks, settings]);

      // Daily digest: one announcement per day at `digestAt`.
      useEffect(() => {
        const timer = window.setInterval(() => {
          const at = settings.digestAt || '09:30';
          const now = new Date();
          const hhmm = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
          if (hhmm !== at) return;
          const todayKey = dayOf();
          const store = readJson(DIGEST_KEY, {});
          if (store.day === todayKey) return;
          const dueToday = (data?.digest?.today || []).length;
          const overdue = (data?.digest?.overdue || []).length;
          if (!dueToday && !overdue) return;
          writeJson(DIGEST_KEY, { day: todayKey });
          const body = `今天 ${dueToday} 项待做，${overdue} 项已逾期。`;
          setToasts((current) => [...current, { key: 'digest-' + todayKey, title: '今日工作汇总', body }]);
          notify('今日工作汇总', body);
        }, 30000);
        return () => window.clearInterval(timer);
      }, [settings.digestAt, data?.digest]);

      // Auto-dismiss toasts; a reminder that is never dismissed would pile up.
      useEffect(() => {
        if (!toasts.length) return;
        const timer = window.setTimeout(() => setToasts((current) => current.slice(1)), 9000);
        return () => window.clearTimeout(timer);
      }, [toasts]);

      const overdue = data?.digest?.overdue || [];

      /**
       * What the dock should actually show today. "covers(today)" alone is too
       * broad: every open-ended task covers every day, so a long backlog would
       * bury the real work. Priority order:
       *   1. tasks due today (a deadline that lands today)
       *   2. tasks already in progress
       *   3. open-ended tasks, oldest first — the ones quietly waiting
       */
      /**
       * Every task the user can tick today — not just the ones scheduled for
       * today. Checking off is a record of what happened, and work often
       * happens off-schedule: an overdue item, an unscheduled one, or a task
       * whose window has not opened yet. Ordering still puts the most
       * decision-relevant items first so the top of the list stays useful.
       */
      // Today's check-ins: which tasks the user says they worked on today.
      const checkedToday = useMemo(
        () => new Set((data?.checkin?.marked || [])),
        [data?.checkin],
      );

      const focusTasks = useMemo(() => {
        // Already ticked today stays visible (and sorted to the top) so the
        // user can untick a mistake without hunting.
        const rank = (task) => ({ high: 0, normal: 1, low: 2 }[task.priority] ?? 1);
        // An absent field means the host predates the focus rule; an empty
        // array means every task is deliberately sidelined.
        const hasFocusData = Array.isArray(data?.focusTaskIds);
        const everyday = new Set(data?.focusTaskIds || []);
        const active = tasks.filter((task) =>
          task.status !== 'done' &&
          // Non-focus groups are long-term follow-ups: hidden from the dock
          // unless already ticked (that is evidence the user worked on it).
          (!hasFocusData || everyday.has(task.id) || checkedToday.has(task.id)));
        const dueToday = active.filter((task) => task.end === today);
        const overdue = active.filter((task) => task.end && diffDays(task.end, today) > 0);
        const inWindow = active.filter((task) =>
          !dueToday.includes(task) && !overdue.includes(task) && covers(task, today));
        const upcoming = active.filter((task) => !dueToday.includes(task) && !overdue.includes(task) && !inWindow.includes(task));
        const byPriority = (a, b) => rank(a) - rank(b);
        dueToday.sort(byPriority);
        overdue.sort(byPriority);
        inWindow.sort(byPriority);
        upcoming.sort((a, b) => byPriority(a, b) || a.start.localeCompare(b.start));
        return [...dueToday, ...overdue, ...inWindow, ...upcoming];
      }, [tasks, today, data?.focusTaskIds, checkedToday]);

      const doneToday = useMemo(
        () => tasks.filter((task) => checkedToday.has(task.id)),
        [tasks, checkedToday],
      );

      // The last few log entries of today, newest last (rendered reversed).
      const todayRecords = useMemo(
        () => (data?.records || []).filter((record) => record.date === today),
        [data?.records, today],
      );

      const quickAdd = async () => {
        if (!text.trim()) return;
        try {
          await mutate({ action: 'record.create', content: text.trim(), date: today });
          setText('');
        } catch {
          /* banner in the store */
        }
      };

      const toggleDone = (task) => {
        mutate({ action: 'task.update', id: task.id, status: task.status === 'done' ? 'doing' : 'done' }).catch(() => undefined);
      };

      // "I did this today" — independent of the task's own status.
      const toggleCheckin = (task) => {
        mutate({ action: 'checkin.toggle', taskId: task.id, date: today }).catch(() => undefined);
      };

      const askPermission = () => {
        if (typeof Notification === 'undefined') return;
        Notification.requestPermission().then((value) => setPermission(value)).catch(() => undefined);
      };

      /* ---------------------------- closed state ---------------------------- */
      // Fully closed: nothing on screen. Reopened from the board header or the
      // sidebar entry, so a dismissed dock is never lost.
      if (closed) return null;

      /* ---------------------------- icon state ----------------------------- */
      if (collapsed) {
        // A single draggable icon, not a shrunken panel. It keeps its own
        // position so it can be parked anywhere, including over other widgets.
        const handleIconDown = (event) => {
          if (event.button !== 0 && event.pointerType === 'mouse') return;
          const startX = event.clientX;
          const startY = event.clientY;
          const originX = iconPos ? iconPos.x : (window.innerWidth || 1280) - 60;
          const originY = iconPos ? iconPos.y : (window.innerHeight || 800) - 120;
          // Distinguish a click from a drag: only a real movement moves it.
          let moved = false;
          const move = (moveEvent) => {
            const dx = moveEvent.clientX - startX;
            const dy = moveEvent.clientY - startY;
            if (!moved && Math.abs(dx) + Math.abs(dy) < 3) return;
            moved = true;
            setIconPos(clampIcon({ x: originX + dx, y: originY + dy }));
          };
          const up = () => {
            document.removeEventListener('pointermove', move);
            document.removeEventListener('pointerup', up);
            if (moved) {
              setIconPos((current) => {
                if (current) writeJson(ICON_KEY, current);
                return current;
              });
            } else {
              // A tap (not a drag) opens the panel.
              setCollapsed(false);
            }
          };
          document.addEventListener('pointermove', move);
          document.addEventListener('pointerup', up);
        };
        const iconStyle = iconPos
          ? { left: iconPos.x, top: iconPos.y }
          : {
              left: Math.max(12, (window.innerWidth || 1280) - 68),
              top: Math.max(12, (window.innerHeight || 800) - 132),
            };
        const urgent = overdue.length > 0;
        return h(Portaled, null,
          h(StyleOnce),
          h('div', {
            className: 'wl-icon' + (urgent ? ' urgent' : ''),
            style: iconStyle,
            role: 'button',
            tabIndex: 0,
            title: '工作记录：点击展开，拖动可移动',
            onPointerDown: handleIconDown,
            onKeyDown: (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                setCollapsed(false);
              }
            },
          },
            h('span', { className: 'wl-icon-mark' }, '◷'),
            focusTasks.length
              ? h('span', { className: 'wl-icon-badge' }, focusTasks.length > 99 ? '99+' : focusTasks.length)
              : null),
          renderToasts());
      }

      /* --------------------------- expanded panel --------------------------- */
      const header = h('div', { className: 'wl-float-head', onPointerDown: beginDrag },
        h('div', { className: 'wl-float-title' },
          h('span', null, '◷'),
          '工作记录',
          focusTasks.length ? h('span', { className: 'wl-float-badge' }, focusTasks.length) : null),
        h('button', {
          className: 'wl-float-btn',
          title: '打开日历看板',
          onPointerDown: (event) => event.stopPropagation(),
          onClick: () => openPanel(),
        }, '⤢'),
        h('button', {
          className: 'wl-float-btn',
          title: '收起为图标',
          onPointerDown: (event) => event.stopPropagation(),
          onClick: () => setCollapsed(true),
        }, '—'),
        h('button', {
          className: 'wl-float-btn wl-float-close',
          title: '关闭浮窗（可从看板或侧边栏重新打开）',
          onPointerDown: (event) => event.stopPropagation(),
          onClick: () => {
            setClosed(true);
            mutate({ action: 'settings.update', settings: { floatEnabled: false } }).catch(() => undefined);
          },
        }, '×'));

      const metaLine = h('div', { className: 'wl-float-meta' },
        h('span', null, `${today.slice(5)} 周${weekday(today)}`),
        h('span', { className: 'wl-float-sep' }, '·'),
        h('span', null, `待办 ${focusTasks.length}`),
        overdue.length ? h('span', { className: 'wl-float-hot' }, `逾期 ${overdue.length}`) : null,
        h('span', { className: 'wl-float-sep' }, '·'),
        h('span', null, `已记 ${formatMinutes(data?.stats?.today?.minutes || 0)}`));

      const overdueBlock = overdue.length
        ? [
            h('div', { key: 'label', className: 'wl-float-sect hot' }, `逾期 ${overdue.length} 项`),
            ...overdue.slice(0, 3).map((task) => h('div', { key: task.id, className: 'wl-float-task hot' },
              h('span', {
                className: 'wl-float-check',
                role: 'checkbox',
                'aria-checked': false,
                tabIndex: 0,
                title: '标记完成',
                onClick: () => toggleDone(task),
                onKeyDown: (event) => { if (event.key === 'Enter') toggleDone(task); },
              }, '✓'),
              h('span', { className: 'wl-mini-text', title: task.title }, task.title),
              h('span', { className: 'wl-float-late' }, `${diffDays(task.end, today)} 天`))),
          ]
        : [];

      // Quick-add a task for today straight from the dock. This is the shortest
      // path from "something just came up" to it existing on the calendar.
      const addTodayTask = async () => {
        const title = newTaskText.trim()
        if (!title) return
        try {
          await mutate({ action: 'task.create', title, start: today, end: null, status: 'doing' })
          setNewTaskText('')
        } catch {
          /* the store surfaces the error banner */
        }
      }

      const quickAddTask = h('div', { className: 'wl-float-news' },
        h('input', {
          className: 'wl-float-newtask',
          placeholder: '新任务，回车加到今天…',
          value: newTaskText,
          onChange: (event) => setNewTaskText(event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              addTodayTask()
            }
          },
        }),
        h('button', {
          className: 'wl-btn',
          onClick: addTodayTask,
          disabled: !newTaskText.trim(),
          title: '把这条加到今天的日历',
        }, '加到日历'))

      // Today's check-off list: ticking a task means "I did this today".
      // Empty means "not today" — it never touches whether the task is done.
      // The check list shows every task so any of them can be ticked for today.
      // A long list scrolls inside its own box, and a filter box appears once
      // the list is long enough to need one.
      const visibleTasks = dockQuery.trim()
        ? focusTasks.filter((task) =>
            `${task.title} ${task.project || ''} ${task.group || ''}`
              .toLowerCase()
              .includes(dockQuery.trim().toLowerCase()))
        : focusTasks

      const checkinBlock = [
        h('div', { key: 'label', className: 'wl-float-sect' },
          doneToday.length
            ? `今天做了 ${doneToday.length} 项 / 共 ${focusTasks.length} 项`
            : `今天做了哪些？（${focusTasks.length} 项）`),
        focusTasks.length >= 6
          ? h('input', {
              key: 'filter',
              className: 'wl-float-filter',
              placeholder: '筛选任务…',
              value: dockQuery,
              onChange: (event) => setDockQuery(event.target.value),
            })
          : null,
        h('div', { key: 'list', className: 'wl-float-tasks' },
          visibleTasks.length
            ? visibleTasks.map((task) => {
                const checked = checkedToday.has(task.id)
                const overdueDays = task.end && diffDays(task.end, today) > 0 ? diffDays(task.end, today) : 0
                return h('div', {
                  key: task.id,
                  className: 'wl-float-task wl-check-row' + (checked ? ' checked' : ''),
                  title: checked ? `${task.title}（点击取消今日打卡）` : `${task.title}（点击记为今天做了）`,
                  onClick: () => toggleCheckin(task),
                },
                  h('span', {
                    className: 'wl-float-check' + (checked ? ' on' : ''),
                    role: 'checkbox',
                    'aria-checked': checked,
                    tabIndex: 0,
                    title: checked ? '取消今日打卡' : '记为今天做了',
                    onClick: (event) => { event.stopPropagation(); toggleCheckin(task); },
                    onKeyDown: (event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.stopPropagation()
                        event.preventDefault()
                        toggleCheckin(task)
                      }
                    },
                  }, '✓'),
                  h('span', { className: 'wl-mini-text' }, task.title),
                  overdueDays ? h('span', { className: 'wl-float-late' }, `${overdueDays} 天`) : null,
                  task.end === today ? h('span', { className: 'wl-float-due' }, '今天截止') : null,
                  task.status === 'blocked' ? h('span', { className: 'wl-float-late' }, '受阻') : null)
              })
            : [h('div', { key: 'empty', className: 'wl-muted' },
                dockQuery.trim()
                  ? '没有匹配的任务。'
                  : '还没有任务，可以在下面直接加一条。')]),
      ];

      const logBlock = [
        h('div', { key: 'label', className: 'wl-float-sect' }, '今天记了'),
        ...(todayRecords.length
          ? todayRecords.slice(-3).reverse().map((record) => h('div', { key: record.id, className: 'wl-float-log' },
              h('span', { className: 'wl-float-log-text' }, record.content),
              record.minutes ? h('span', { className: 'wl-float-late' }, formatMinutes(record.minutes)) : null))
          : [h('div', { key: 'empty', className: 'wl-muted' }, '还没记录。写一句刚才做了什么。')]),
      ];

      const composer = h('div', { className: 'wl-float-compose' },
        h('textarea', {
          className: 'wl-float-input',
          rows: 2,
          placeholder: '随手记一笔…（Ctrl+Enter 保存）',
          value: text,
          onChange: (event) => setText(event.target.value),
          onKeyDown: (event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
              event.preventDefault();
              quickAdd();
            }
          },
        }),
        h('div', { className: 'wl-float-foot' },
          h('button', { className: 'wl-btn primary', onClick: quickAdd, disabled: !text.trim() }, '记下'),
          h('button', { className: 'wl-btn', onClick: openPanel }, '打开日历'),
          h('span', { className: 'wl-hint', style: { marginLeft: 'auto' } }, '拖动标题栏可移动')));

      return h(Portaled, null,
        h(StyleOnce),
        h('div', { className: 'wl-float', style: placement },
          header,
          h('div', { className: 'wl-float-body' },
            metaLine,
            permission === 'default'
              ? h('button', {
                  className: 'wl-btn',
                  onClick: askPermission,
                  style: { fontSize: 11.5 },
                }, '开启桌面通知（可选）')
              : null,
            overdueBlock,
            checkinBlock,
            quickAddTask,
            logBlock,
            composer)),
        renderToasts());

      /**
       * Reminder toasts. Stacked from the bottom-right, two at most, each with
       * a direct "done" action so a reminder can be cleared without opening
       * anything else.
       */
      function renderToasts() {
        const shown = toasts.slice(-2);
        return shown.map((toast, index) => h('div', {
          key: toast.key,
          className: 'wl-toast',
          style: { bottom: 22 + index * 104 },
        },
          h('b', null, toast.title),
          h('span', null, toast.body || (toast.due ? toast.due.replace('T', ' ') + ' 到点了' : '')),
          h('div', { className: 'wl-toast-actions' },
            h('button', {
              className: 'wl-btn',
              onClick: () => setToasts((current) => current.filter((item) => item.key !== toast.key)),
            }, '知道了'),
            toast.taskId
              ? h('button', {
                  className: 'wl-btn',
                  onClick: () => {
                    const task = tasks.find((item) => item.id === toast.taskId);
                    if (task) mutate({ action: 'task.update', id: task.id, status: 'done' }).catch(() => undefined);
                    setToasts((current) => current.filter((item) => item.key !== toast.key));
                  },
                }, '标记完成')
              : null)));
      }
    }

    function PanelIcon({ size = 22 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
        h('rect', { x: 3.5, y: 5, width: 17, height: 15, rx: 2.4, fill: 'currentColor', opacity: 0.16 }),
        h('path', { d: 'M3.5 9h17', stroke: 'currentColor', strokeWidth: 1.5 }),
        h('path', { d: 'M8 3.6v3M16 3.6v3', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' }),
        h('rect', { x: 6.4, y: 12, width: 4.2, height: 2.2, rx: 1.1, fill: 'currentColor' }),
        h('rect', { x: 12.2, y: 15.2, width: 5.4, height: 2.2, rx: 1.1, fill: 'currentColor', opacity: 0.65 }));
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const openPanel = () => {
          try {
            ctx.get('layout')?.selectPanel?.('worklog-calendar');
          } catch {
            /* layout may not be mounted yet; the sidebar entry still works */
          }
        };

        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: 'worklog-calendar' }, () => h(Board, { ctx })),
        );
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register({
            name: 'sidebar.panellist',
            id: 'worklog-calendar',
            order: 6,
            label: () => '工作记录',
          }, PanelIcon),
        );
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: 'worklog-dock' }, () => h(FloatingDock, { ctx, openPanel })),
        );
      },
    };
  },
});
