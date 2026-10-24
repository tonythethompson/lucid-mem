// Relevance ranking for `amr context`: instead of "newest 25", pick the
// entries most likely to help a fresh session, within a size budget.
// Score = kind weight x recency decay x usage boost, with a penalty for
// session-state-shaped noise. Usage (which entries searches surfaced or
// the agent marked via `amr used`) lives in .git/amr-usage.json — local,
// never committed, so ranking is per-machine.

import fs from 'node:fs';
import path from 'node:path';
import { entryKind } from './core.mjs';
import { entryId } from './ids.mjs';

export const DEFAULT_BUDGET = 6000; // chars of entries, roughly 1.5k tokens
export const MIN_PER_SECTION = 3;

const KIND_WEIGHT = {
  pitfall: 3,
  decision: 2.5,
  preference: 2.5,
  howto: 2,
  fact: 1.5,
  state: 1,
};
const HALF_LIFE_DAYS = 60;
const USAGE_WINDOW_DAYS = 90;

const usagePath = (home) => path.join(home, '.git', 'amr-usage.json');

export function loadUsage(home) {
  try {
    return JSON.parse(fs.readFileSync(usagePath(home), 'utf8'));
  } catch {
    return {};
  }
}

export function bumpUsage(home, ids, now = Date.now()) {
  if (!ids.length) return;
  const u = loadUsage(home);
  for (const id of ids) {
    const e = u[id] || { n: 0 };
    u[id] = { n: e.n + 1, last: now };
  }
  try {
    fs.writeFileSync(usagePath(home), JSON.stringify(u));
  } catch {}
}

const latestDate = (line) => {
  const ds = [...line.matchAll(/(?:added|updated):\s*(\d{4}-\d{2}-\d{2})/g)]
    .map((m) => m[1])
    .sort();
  return ds.length ? ds[ds.length - 1] : null;
};

export function scoreEntry(line, usage = {}, isNoise = () => false, now = Date.now()) {
  const kind = entryKind(line);
  let s = KIND_WEIGHT[kind] ?? 1.5;
  const d = latestDate(line);
  const ageDays = d ? Math.max(0, (now - Date.parse(d)) / 864e5) : HALF_LIFE_DAYS;
  s *= Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
  const u = usage[entryId(line)];
  if (u && now - u.last < USAGE_WINDOW_DAYS * 864e5) s *= 1 + 0.5 * Math.log2(1 + u.n);
  if (kind !== 'state' && isNoise(line)) s *= 0.3;
  return s;
}

// Highest-scored entries first until `maxCount` or the char budget is
// hit (always at least MIN_PER_SECTION), returned in original order.
export function pickWithinBudget(arr, maxCount, budget, usage, isNoise) {
  const ranked = arr
    .map((line, i) => ({ line, i, s: scoreEntry(line, usage, isNoise) }))
    .sort((a, b) => b.s - a.s || b.i - a.i);
  const chosen = [];
  let chars = 0;
  for (const r of ranked) {
    if (chosen.length >= maxCount) break;
    if (chosen.length >= MIN_PER_SECTION && chars + r.line.length > budget) continue;
    chosen.push(r);
    chars += r.line.length;
  }
  chosen.sort((a, b) => a.i - b.i);
  return { items: chosen.map((r) => r.line), chars };
}
