# Stage-derived Sleep Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `google_health_sleep` MCP tool that returns per-night sleep computed directly from Google Health v4 stage segments (correcting brief wake misclassified as light), plus the stage timeline, per-stage minutes, and efficiency.

**Architecture:** Fork-and-extend. A pure `sleep-normalize.ts` parses loosely-typed v4 sleep records into a normalized per-night stage timeline; a pure engine in `sleep.ts` computes corrected metrics; `buildSleep`/`formatSleepMarkdown` follow the repo's `summary.ts` service pattern; one tool registers in `google-health-tools.ts`. No new package — the repo already does analytics in `src/services/`.

**Tech Stack:** TypeScript (Node, `tsc` build to `dist/`), `@modelcontextprotocol/sdk`, zod schemas, `node:assert` fixture tests under `scripts/*.mjs` wired into `npm test`.

**Conventions matched (verified in repo):** services export `build<Name>(client, params)` + `format<Name>Markdown`; output envelope `{ kind, generated_at, source:"google_health", window, beta:true, data_quality, ..., safety:{medical_advice:false} }`; output keys `snake_case`, internal identifiers `camelCase`; defensive multi-candidate field extraction (v4 payloads are `unknown`); tests import from `../dist/...` and use a `fakeClient`.

**Pre-flight (do once before Task 1):**
```bash
cd ~/git/google-health-mcp
git checkout -b feat/sleep-tool
npm ci
npm run build   # confirm a clean baseline build
```

**Note on TDD cycle here:** tests import compiled JS from `dist/`, so each cycle is: write `.mjs` test → `npm run build` → run test (fails) → write/modify `.ts` → `npm run build` → run test (passes) → commit. The "verify it fails" step runs against the current `dist/` (module missing or assertion fails).

---

### Task 1: Sleep normalizer (`sleep-normalize.ts`)

**Files:**
- Create: `src/services/sleep-normalize.ts`
- Test: `scripts/sleep-normalize-test.mjs`

- [ ] **Step 1: Write the failing test**

Create `scripts/sleep-normalize-test.mjs`:

```js
import assert from 'node:assert/strict';
import { fromReconciledSleep, normalizeStage } from '../dist/services/sleep-normalize.js';

// stage label normalization
assert.equal(normalizeStage('DEEP'), 'deep');
assert.equal(normalizeStage('Wake'), 'awake');
assert.equal(normalizeStage('core'), 'light');
assert.equal(normalizeStage('nonsense'), null);

// a night with a stage timeline
const payload = {
  dataPoints: [{
    sleep: {
      interval: { civilStartTime: '2026-06-01T23:30:00Z' },
      summary: { minutesAsleep: '7', efficiency: 90 },
      stages: [
        { stage: 'LIGHT', startTime: '2026-06-01T23:30:00Z', seconds: 120 },
        { stage: 'DEEP',  startTime: '2026-06-01T23:32:00Z', seconds: 180 },
        { stage: 'AWAKE', startTime: '2026-06-01T23:35:00Z', seconds: 60 },
        { stage: 'REM',   startTime: '2026-06-01T23:36:00Z', seconds: 120 }
      ]
    }
  }]
};
const nights = fromReconciledSleep(payload);
assert.equal(nights.length, 1);
assert.equal(nights[0].date, '2026-06-01');
assert.equal(nights[0].stagesAvailable, true);
assert.equal(nights[0].segments.length, 4);
assert.equal(nights[0].segments[1].stage, 'deep');
assert.equal(nights[0].segments[1].seconds, 180);
assert.equal(nights[0].googleSummary.minutesAsleep, 7);

// summary-only record (no stages) → stagesAvailable false
const summaryOnly = fromReconciledSleep({
  dataPoints: [{ sleep: { interval: { civilStartTime: '2026-06-02T23:00:00Z' }, summary: { minutesAsleep: 430 } } }]
});
assert.equal(summaryOnly[0].stagesAvailable, false);
assert.equal(summaryOnly[0].segments.length, 0);
assert.equal(summaryOnly[0].googleSummary.minutesAsleep, 430);

// duration derived from start/end when seconds absent
const derived = fromReconciledSleep({
  dataPoints: [{ sleep: { stages: [
    { level: 'rem', dateTime: '2026-06-03T01:00:00Z', endTime: '2026-06-03T01:30:00Z' }
  ] } }]
});
assert.equal(derived[0].segments[0].seconds, 1800);

console.log(JSON.stringify({ ok: true, nights: nights.length }, null, 2));
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/git/google-health-mcp && npm run build && node scripts/sleep-normalize-test.mjs`
Expected: FAIL — `Cannot find module '../dist/services/sleep-normalize.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/services/sleep-normalize.ts`:

```ts
// Pure, network-free parsing of Google Health v4 sleep records into a normalized
// per-night stage timeline. Uses defensive multi-candidate extraction like summary.ts
// because v4 payloads arrive loosely typed (`unknown`). Exact v4 segment field names
// are verified against a captured live response (see plan open items); candidate keys
// below cover the documented v4 shape and the Fitbit levels.data shape.

export type SleepStage = "awake" | "light" | "deep" | "rem";

export interface StageSegment {
  start: string;   // ISO 8601
  end: string;     // ISO 8601
  stage: SleepStage;
  seconds: number;
}

export interface SleepNight {
  date: string;                 // night-of (YYYY-MM-DD)
  segments: StageSegment[];     // ordered
  stagesAvailable: boolean;
  googleSummary?: { minutesAsleep?: number; minutesAwake?: number; efficiency?: number };
}

type UnknownRecord = Record<string, unknown>;

function isObject(value: unknown): value is UnknownRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function numberFrom(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function pickNumber(record: UnknownRecord, candidates: string[]): number | undefined {
  for (const key of candidates) {
    const value = numberFrom(record[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function pickString(record: UnknownRecord, candidates: string[]): string | undefined {
  for (const key of candidates) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

export function normalizeStage(raw: unknown): SleepStage | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  if (v === "awake" || v === "wake" || v === "wakefulness") return "awake";
  if (v === "light" || v === "core") return "light";
  if (v === "deep") return "deep";
  if (v === "rem") return "rem";
  return null;
}

const SEGMENT_LIST_KEYS = ["stages", "segments", "stageSegments"];

function segmentArray(sleep: UnknownRecord): UnknownRecord[] {
  for (const key of SEGMENT_LIST_KEYS) {
    const value = sleep[key];
    if (Array.isArray(value)) return value.filter(isObject);
  }
  // Fitbit-style: levels.data = [{ dateTime, level, seconds }]
  const levels = sleep.levels;
  if (isObject(levels) && Array.isArray(levels.data)) return levels.data.filter(isObject);
  return [];
}

function toSegment(raw: UnknownRecord): StageSegment | null {
  const stage = normalizeStage(raw.stage ?? raw.level ?? raw.type);
  if (!stage) return null;
  const start = pickString(raw, ["start", "startTime", "dateTime", "civilStartTime"]);
  if (!start) return null;
  let end = pickString(raw, ["end", "endTime", "civilEndTime"]);
  let seconds = pickNumber(raw, ["seconds", "durationSeconds", "durationSec"]);
  if (seconds === undefined) {
    const durationMs = pickNumber(raw, ["durationMillis", "durationMs"]);
    if (durationMs !== undefined) seconds = Math.round(durationMs / 1000);
  }
  if (seconds === undefined && end) {
    seconds = Math.round((Date.parse(end) - Date.parse(start)) / 1000);
  }
  if (seconds === undefined || seconds <= 0) return null;
  if (!end) end = new Date(Date.parse(start) + seconds * 1000).toISOString();
  return { start, end, stage, seconds };
}

function summaryOf(sleep: UnknownRecord): SleepNight["googleSummary"] {
  const summary = isObject(sleep.summary) ? sleep.summary : sleep;
  return {
    minutesAsleep: pickNumber(summary, ["minutesAsleep", "minutesInSleepPeriod"]),
    minutesAwake: pickNumber(summary, ["minutesAwake"]),
    efficiency: pickNumber(summary, ["efficiency"])
  };
}

function nightDate(sleep: UnknownRecord, segments: StageSegment[]): string {
  const interval = isObject(sleep.interval) ? sleep.interval : undefined;
  const start =
    (interval && pickString(interval, ["civilStartTime", "startTime", "start"])) ??
    pickString(sleep, ["startTime", "start", "dateOfSleep"]) ??
    segments[0]?.start;
  return start ? start.slice(0, 10) : "unknown";
}

export function fromReconciledSleep(payload: unknown): SleepNight[] {
  if (!isObject(payload) || !Array.isArray(payload.dataPoints)) return [];
  const nights: SleepNight[] = [];
  for (const point of payload.dataPoints) {
    if (!isObject(point)) continue;
    const sleep = isObject(point.sleep) ? point.sleep : point;
    const segments = segmentArray(sleep)
      .map(toSegment)
      .filter((s): s is StageSegment => s !== null);
    nights.push({
      date: nightDate(sleep, segments),
      segments,
      stagesAvailable: segments.length > 0,
      googleSummary: summaryOf(sleep)
    });
  }
  return nights;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/git/google-health-mcp && npm run build && node scripts/sleep-normalize-test.mjs`
Expected: PASS — prints `{ "ok": true, "nights": 1 }`.

- [ ] **Step 5: Commit**

```bash
git add src/services/sleep-normalize.ts scripts/sleep-normalize-test.mjs
git commit -m "feat: add v4 sleep stage-timeline normalizer"
```

---

### Task 2: Sleep recompute engine (`sleep.ts` — pure metrics)

**Files:**
- Create: `src/services/sleep.ts`
- Test: `scripts/sleep-engine-test.mjs`

- [ ] **Step 1: Write the failing test**

Create `scripts/sleep-engine-test.mjs`:

```js
import assert from 'node:assert/strict';
import { computeNightMetrics, DEFAULT_SLEEP_CONFIG } from '../dist/services/sleep.js';

const seg = (stage, minutes) => ({ start: '2026-06-01T00:00:00Z', end: '2026-06-01T00:00:00Z', stage, seconds: minutes * 60 });

// Case 1: normal night, no isolated light → asleep = deep+light+rem
const normal = {
  date: '2026-06-01', stagesAvailable: true,
  segments: [seg('light', 60), seg('deep', 90), seg('rem', 60), seg('light', 90)],
  googleSummary: { minutesAsleep: 300, efficiency: 100 }
};
const r1 = computeNightMetrics(normal, DEFAULT_SLEEP_CONFIG);
assert.equal(r1.minutes_asleep, 300);
assert.equal(r1.minutes_by_stage.deep, 90);
assert.equal(r1.stages_available, true);

// Case 2: isolated 4m light bracketed by awake → reclassified to wake
const isolated = {
  date: '2026-06-02', stagesAvailable: true,
  segments: [seg('deep', 100), seg('awake', 10), seg('light', 4), seg('awake', 10), seg('rem', 100)],
  googleSummary: { minutesAsleep: 204 }
};
const r2 = computeNightMetrics(isolated, DEFAULT_SLEEP_CONFIG);
assert.equal(r2.minutes_asleep, 200);          // 204 − 4 reclassified light
assert.equal(r2.minutes_awake_in_bed, 24);     // 10 + 4 + 10

// Case 3: reclassification + trim OFF reproduces Google's stage sum (parsing sanity)
const r3 = computeNightMetrics(isolated, { reclassify_isolated_light: false, isolated_light_window_min: 5, trim_edges: false });
assert.equal(r3.minutes_asleep, 204);

// Case 4: no stages → falls back to google summary, flagged
const noStages = { date: '2026-06-03', stagesAvailable: false, segments: [], googleSummary: { minutesAsleep: 430, efficiency: 88 } };
const r4 = computeNightMetrics(noStages, DEFAULT_SLEEP_CONFIG);
assert.equal(r4.minutes_asleep, 430);
assert.equal(r4.stages_available, false);
assert.equal(r4.google_summary.minutes_asleep, 430);

// Case 5: all awake → 0 asleep
const allWake = { date: '2026-06-04', stagesAvailable: true, segments: [seg('awake', 30)], googleSummary: {} };
assert.equal(computeNightMetrics(allWake, DEFAULT_SLEEP_CONFIG).minutes_asleep, 0);

console.log(JSON.stringify({ ok: true }, null, 2));
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/git/google-health-mcp && npm run build && node scripts/sleep-engine-test.mjs`
Expected: FAIL — `Cannot find module '../dist/services/sleep.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/services/sleep.ts` (engine portion; the service portion is added in Task 3):

```ts
import { type SleepNight, type SleepStage, type StageSegment } from "./sleep-normalize.js";

export interface SleepConfig {
  reclassify_isolated_light: boolean;
  isolated_light_window_min: number;
  trim_edges: boolean;
}

export const DEFAULT_SLEEP_CONFIG: SleepConfig = {
  reclassify_isolated_light: true,
  isolated_light_window_min: 5,
  trim_edges: true
};

export interface SleepNightResult {
  date: string;
  minutes_asleep: number;
  minutes_by_stage: { deep: number; light: number; rem: number };
  minutes_awake_in_bed: number;
  time_in_bed: number;
  efficiency: number;
  stages_available: boolean;
  google_summary?: { minutes_asleep?: number; efficiency?: number };
}

interface Run { stage: SleepStage; seconds: number; }

function mergeRuns(runs: Run[]): Run[] {
  const out: Run[] = [];
  for (const run of runs) {
    const last = out[out.length - 1];
    if (last && last.stage === run.stage) last.seconds += run.seconds;
    else out.push({ ...run });
  }
  return out;
}

function toRuns(segments: StageSegment[]): Run[] {
  return mergeRuns(segments.map((seg) => ({ stage: seg.stage, seconds: seg.seconds })));
}

function applyReclassification(runs: Run[], config: SleepConfig): Run[] {
  if (!config.reclassify_isolated_light) return runs;
  const windowSec = config.isolated_light_window_min * 60;
  const flipped: Run[] = runs.map((run, i) => {
    if (run.stage !== "light" || run.seconds > windowSec) return run;
    const prev = runs[i - 1];
    const next = runs[i + 1];
    const prevWake = !prev || prev.stage === "awake";   // record edge counts as wake
    const nextWake = !next || next.stage === "awake";
    return prevWake && nextWake ? { stage: "awake" as SleepStage, seconds: run.seconds } : run;
  });
  // flipping a LIGHT run to AWAKE can make it adjacent to existing AWAKE runs — re-merge.
  return mergeRuns(flipped);
}

function computeFromRuns(runs: Run[], config: SleepConfig) {
  const reclassified = applyReclassification(runs, config);
  let startIdx = 0;
  let endIdx = reclassified.length - 1;
  if (config.trim_edges) {
    while (startIdx <= endIdx && reclassified[startIdx].stage === "awake") startIdx++;
    while (endIdx >= startIdx && reclassified[endIdx].stage === "awake") endIdx--;
  }
  const inBed = reclassified.slice(startIdx, endIdx + 1);
  const sum = (stage: SleepStage) => inBed.filter((r) => r.stage === stage).reduce((s, r) => s + r.seconds, 0);
  const deep = sum("deep"), light = sum("light"), rem = sum("rem"), awake = sum("awake");
  const asleepSec = deep + light + rem;
  const inBedSec = asleepSec + awake;
  const toMin = (sec: number) => Math.round(sec / 60);
  return {
    minutes_asleep: toMin(asleepSec),
    minutes_by_stage: { deep: toMin(deep), light: toMin(light), rem: toMin(rem) },
    minutes_awake_in_bed: toMin(awake),
    time_in_bed: toMin(inBedSec),
    efficiency: inBedSec > 0 ? Math.round((asleepSec / inBedSec) * 1000) / 10 : 0
  };
}

export function computeNightMetrics(night: SleepNight, config: SleepConfig = DEFAULT_SLEEP_CONFIG): SleepNightResult {
  const google_summary = night.googleSummary
    ? { minutes_asleep: night.googleSummary.minutesAsleep, efficiency: night.googleSummary.efficiency }
    : undefined;

  if (!night.stagesAvailable || night.segments.length === 0) {
    const gm = night.googleSummary?.minutesAsleep ?? 0;
    const awake = night.googleSummary?.minutesAwake ?? 0;
    return {
      date: night.date,
      minutes_asleep: gm,
      minutes_by_stage: { deep: 0, light: 0, rem: 0 },
      minutes_awake_in_bed: awake,
      time_in_bed: gm + awake,
      efficiency: night.googleSummary?.efficiency ?? 0,
      stages_available: false,
      google_summary
    };
  }

  const metrics = computeFromRuns(toRuns(night.segments), config);
  return { date: night.date, ...metrics, stages_available: true, google_summary };
}
```

> Note: `mergeRuns` is the single place run-collapsing happens — `toRuns` uses it to build runs from segments, and `applyReclassification` uses it again after flipping an isolated LIGHT to AWAKE so the new AWAKE merges with its neighbours (DRY).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/git/google-health-mcp && npm run build && node scripts/sleep-engine-test.mjs`
Expected: PASS — prints `{ "ok": true }`.

- [ ] **Step 5: Commit**

```bash
git add src/services/sleep.ts scripts/sleep-engine-test.mjs
git commit -m "feat: add stage-derived sleep recompute engine"
```

---

### Task 3: Sleep service + markdown (`buildSleep` / `formatSleepMarkdown`)

**Files:**
- Modify: `src/services/sleep.ts` (append service functions)
- Test: `scripts/sleep-fixture-test.mjs`

- [ ] **Step 1: Write the failing test**

Create `scripts/sleep-fixture-test.mjs`:

```js
import assert from 'node:assert/strict';
import { buildSleep, formatSleepMarkdown } from '../dist/services/sleep.js';

const fakeClient = {
  async reconcileDataPoints({ dataType }) {
    assert.equal(dataType, 'sleep');
    return { dataPoints: [{ sleep: {
      interval: { civilStartTime: '2026-06-01T23:00:00Z' },
      summary: { minutesAsleep: 204, efficiency: 90 },
      stages: [
        { stage: 'DEEP',  startTime: '2026-06-01T23:00:00Z', seconds: 6000 },
        { stage: 'AWAKE', startTime: '2026-06-02T00:40:00Z', seconds: 600 },
        { stage: 'LIGHT', startTime: '2026-06-02T00:50:00Z', seconds: 240 },
        { stage: 'AWAKE', startTime: '2026-06-02T00:54:00Z', seconds: 600 },
        { stage: 'REM',   startTime: '2026-06-02T01:04:00Z', seconds: 6000 }
      ]
    } }] };
  }
};

const result = await buildSleep(fakeClient, { date: '2026-06-01' });
assert.equal(result.kind, 'sleep');
assert.equal(result.source, 'google_health');
assert.equal(result.beta, true);
assert.equal(result.safety.medical_advice, false);
assert.equal(result.nights.length, 1);

const n = result.nights[0];
assert.equal(n.date, '2026-06-01');
assert.equal(n.stages_available, true);
assert.equal(n.minutes_asleep, 200);             // 100 deep + 100 rem; isolated 4m light → wake
assert.equal(n.minutes_awake_in_bed, 24);
assert.equal(n.google_summary.minutes_asleep, 204);

const md = formatSleepMarkdown(result);
assert.ok(md.includes('# Google Health Sleep'));
assert.ok(md.includes('2026-06-01'));

console.log(JSON.stringify({ ok: true, asleep: n.minutes_asleep }, null, 2));
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/git/google-health-mcp && npm run build && node scripts/sleep-fixture-test.mjs`
Expected: FAIL — `buildSleep is not a function` (not yet exported).

- [ ] **Step 3: Write the implementation**

Append to `src/services/sleep.ts`:

```ts
import type { GoogleHealthClient } from "./google-health-client.js";
import { fromReconciledSleep } from "./sleep-normalize.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface SleepParams {
  date?: string;
  start?: string;
  end?: string;
  config?: Partial<SleepConfig>;
}

function dateString(daysAgo = 0): string {
  return new Date(Date.now() - daysAgo * DAY_MS).toISOString().slice(0, 10);
}

function normalizeDate(value?: string): string {
  return !value || value === "today" ? dateString(0) : value;
}

function addDays(date: string, days: number): string {
  const v = new Date(`${date}T00:00:00Z`);
  v.setUTCDate(v.getUTCDate() + days);
  return v.toISOString().slice(0, 10);
}

function eachDate(start: string, end: string): string[] {
  const out: string[] = [];
  let d = start;
  for (let i = 0; i < 366 && d <= end; i++) { out.push(d); d = addDays(d, 1); }
  return out;
}

async function safeReconcile(
  client: Pick<GoogleHealthClient, "reconcileDataPoints">,
  date: string
): Promise<unknown> {
  const endDate = addDays(date, 1);
  try {
    return await client.reconcileDataPoints({
      dataType: "sleep",
      filter: `sleep.interval.civil_start_time >= "${date}" AND sleep.interval.civil_start_time < "${endDate}"`,
      pageSize: 25,
      dataSourceFamily: "users/me/dataSourceFamilies/google-wearables"
    });
  } catch {
    return undefined;
  }
}

export async function buildSleep(
  client: Pick<GoogleHealthClient, "reconcileDataPoints">,
  params: SleepParams
) {
  const start = params.start ? normalizeDate(params.start) : normalizeDate(params.date);
  const end = params.end ? normalizeDate(params.end) : start;
  const config: SleepConfig = { ...DEFAULT_SLEEP_CONFIG, ...(params.config ?? {}) };

  const payloads = await Promise.all(eachDate(start, end).map((d) => safeReconcile(client, d)));
  const nights = payloads
    .flatMap((payload) => fromReconciledSleep(payload))
    .map((night) => computeNightMetrics(night, config));

  const withStages = nights.filter((n) => n.stages_available).length;
  return {
    kind: "sleep" as const,
    generated_at: new Date().toISOString(),
    source: "google_health",
    window: { start, end },
    beta: true,
    data_quality: {
      nights: nights.length,
      nights_with_stages: withStages,
      confidence: nights.length === 0 ? "low" : withStages >= Math.ceil(nights.length / 2) ? "medium" : "low"
    },
    config,
    nights,
    safety: {
      medical_advice: false,
      api_boundary:
        "Minutes asleep are computed from Google Health v4 stage segments; google_summary echoes Google's reported figure for reference."
    }
  };
}

export function formatSleepMarkdown(result: Awaited<ReturnType<typeof buildSleep>>): string {
  const hm = (m: number) => `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}`;
  const lines = [
    "# Google Health Sleep",
    "",
    `Generated: ${result.generated_at}`,
    `Window: ${result.window.start} → ${result.window.end}`,
    `Nights: ${result.data_quality.nights} (with stages: ${result.data_quality.nights_with_stages})`,
    ""
  ];
  for (const n of result.nights) {
    lines.push(`## ${n.date}`);
    lines.push(`- **asleep**: ${hm(n.minutes_asleep)} (${n.minutes_asleep} min)`);
    if (n.stages_available) {
      lines.push(`- **stages**: deep ${n.minutes_by_stage.deep} / light ${n.minutes_by_stage.light} / rem ${n.minutes_by_stage.rem} min`);
      lines.push(`- **awake in bed**: ${n.minutes_awake_in_bed} min`);
      lines.push(`- **efficiency**: ${n.efficiency}%`);
    } else {
      lines.push("- _no stage data; showing Google's reported summary_");
    }
    if (n.google_summary?.minutes_asleep !== undefined) {
      lines.push(`- **google reported**: ${n.google_summary.minutes_asleep} min`);
    }
    lines.push("");
  }
  lines.push("> Not medical advice.");
  return lines.join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/git/google-health-mcp && npm run build && node scripts/sleep-fixture-test.mjs`
Expected: PASS — prints `{ "ok": true, "asleep": 200 }`.

- [ ] **Step 5: Commit**

```bash
git add src/services/sleep.ts scripts/sleep-fixture-test.mjs
git commit -m "feat: add buildSleep service and markdown formatter"
```

---

### Task 4: Schemas + tool registration

**Files:**
- Modify: `src/schemas/common.ts` (append schemas)
- Modify: `src/tools/google-health-tools.ts` (import + register tool)
- Modify: `scripts/smoke-tools.mjs:5-13` (add tool to `expectedTools`)

- [ ] **Step 1: Update the smoke test's expected-tools list (the failing test)**

In `scripts/smoke-tools.mjs`, add `'google_health_sleep'` to the `expectedTools` array (the array around lines 5-13). Add it alphabetically, e.g. immediately after `'google_health_rollup',`:

```js
  'google_health_reconcile_data_points', 'google_health_revoke_access', 'google_health_rollup', 'google_health_sleep',
```

- [ ] **Step 2: Run smoke to verify it fails**

Run: `cd ~/git/google-health-mcp && npm run build && npm run smoke`
Expected: FAIL — `deepEqual` mismatch: actual tool list lacks `google_health_sleep` (it is expected but not yet registered).

- [ ] **Step 3: Add the schemas**

Append to `src/schemas/common.ts`:

```ts
const OptionalDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$|^today$/).optional();

export const SleepConfigSchema = z.object({
  reclassify_isolated_light: z.boolean(),
  isolated_light_window_min: z.number().int().min(0).max(60),
  trim_edges: z.boolean()
}).partial().strict().optional();

export const SleepInputSchema = z.object({
  date: OptionalDateSchema.describe("Single night (YYYY-MM-DD or 'today'). Ignored if start/end given."),
  start: OptionalDateSchema.describe("Range start (YYYY-MM-DD or 'today')."),
  end: OptionalDateSchema.describe("Range end (YYYY-MM-DD or 'today')."),
  config: SleepConfigSchema,
  response_format: ResponseFormatSchema
}).strict();

export const SleepOutputSchema = z.object({
  kind: z.literal("sleep"),
  generated_at: z.string()
}).passthrough();
```

- [ ] **Step 4: Register the tool**

In `src/tools/google-health-tools.ts`, add `SleepInputSchema` and `SleepOutputSchema` to the existing `from "../schemas/common.js"` import block, and add the service import near the other service imports:

```ts
import { buildSleep, formatSleepMarkdown } from "../services/sleep.js";
```

Then add this registration inside `registerGoogleHealthTools`, immediately after the `google_health_weekly_summary` block:

```ts
  server.registerTool("google_health_sleep", {
    title: "Google Health Sleep",
    description: "Per-night sleep computed from Google Health v4 stage segments: minutes asleep (corrected for brief wake misclassified as light), per-stage minutes, awake-in-bed, efficiency, and the stage timeline. Accepts a single date or a start/end range. Read-only, beta, non-medical.",
    inputSchema: SleepInputSchema.shape,
    outputSchema: SleepOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, async (params) => {
    try {
      const result = await buildSleep(client(), params);
      return makeResponse(result, params.response_format, formatSleepMarkdown(result));
    } catch (error) {
      return makeError((error as Error).message);
    }
  });
```

- [ ] **Step 5: Run smoke + typecheck to verify they pass**

Run: `cd ~/git/google-health-mcp && npm run typecheck && npm run build && npm run smoke`
Expected: PASS — smoke `deepEqual` now matches (the tool is registered); typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/schemas/common.ts src/tools/google-health-tools.ts scripts/smoke-tools.mjs
git commit -m "feat: register google_health_sleep tool with input/output schemas"
```

---

### Task 5: Document conventions in `AGENTS.md`

**Files:**
- Modify: `AGENTS.md` (add a Conventions section)

- [ ] **Step 1: Add the section**

Append to `AGENTS.md`:

```markdown
## Conventions

- **Analytics services** live in `src/services/<name>.ts` and export an async
  `build<Name>(client, params)` returning a plain object, paired with a
  `format<Name>Markdown(result)`. Pure derivation helpers stay inline in the module
  (see `summary.ts`, `sleep.ts`).
- **Raw → clean parsing** is isolated in a `*-normalize.ts` service (`nutrition-normalize.ts`,
  `sleep-normalize.ts`). v4 payloads are loosely typed; extract with defensive
  multi-candidate key lookups (`pickNumber`/`pickString`/`findNestedNumber`), never assume
  a single field name.
- **Output envelope** for analytic results: `{ kind, generated_at, source: "google_health",
  window, beta: true, data_quality: {...}, <payload>, safety: { medical_advice: false, ... } }`.
  Output JSON keys are `snake_case`; internal TypeScript identifiers are `camelCase`.
- **Resilience:** wrap each upstream call so partial data never throws; surface a
  `data_quality.confidence` and what was missing.
- **Tools** register in `src/tools/google-health-tools.ts` via `server.registerTool(
  "google_health_<x>", { title, description, inputSchema: Schema.shape, outputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true,
  openWorldHint: true } }, handler)`. Handlers `try { … return makeResponse(result,
  params.response_format, format…Markdown(result)); } catch { return makeError(…) }`, take a
  `response_format` (json|markdown), and apply the privacy layer for raw passthrough.
- **Schemas** are zod, defined in `src/schemas/common.ts`.
- **Naming** is neutral and descriptive (`daily_summary`, `sleep_minutes`) — no editorializing
  adjectives in tool or field names.
- **Tests** are `node:assert` fixtures under `scripts/*.mjs`, import from `../dist/...`, use a
  `fakeClient`, and are wired into the `npm test` chain. Adding a tool also requires adding it
  to the `expectedTools` list in `scripts/smoke-tools.mjs`.
```

- [ ] **Step 2: Verify**

Run: `cd ~/git/google-health-mcp && grep -c "Conventions" AGENTS.md`
Expected: `1` (or higher).

- [ ] **Step 3: Commit**

```bash
git add AGENTS.md
git commit -m "docs: document service/tool/test conventions in AGENTS.md"
```

---

### Task 6: Wire sleep tests into the gate + full run

**Files:**
- Modify: `package.json` (scripts: add sleep test tasks, append to `test`)

- [ ] **Step 1: Add the test scripts**

In `package.json` `scripts`, add three entries:

```json
    "test:sleep-normalize": "node scripts/sleep-normalize-test.mjs",
    "test:sleep-engine": "node scripts/sleep-engine-test.mjs",
    "test:sleep": "node scripts/sleep-fixture-test.mjs",
```

Then append them to the end of the existing `test` chain (before the closing quote):

```
... && npm run test:nutrition-normalize && npm run test:v4-nutrition && npm run test:sleep-normalize && npm run test:sleep-engine && npm run test:sleep
```

- [ ] **Step 2: Run the full gate**

Run: `cd ~/git/google-health-mcp && npm test`
Expected: PASS — typecheck, build, smoke, and all fixture tests including the three sleep tests succeed.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "test: wire sleep fixture tests into the npm test gate"
```

---

## Post-implementation (requires Andy / OAuth — not part of the offline build)

These are tracked, not executed by the worker:

1. **Register Google Cloud OAuth client** (Google Health API v4 enabled), run the upstream
   `setup`/`auth` flow in testing mode with Andy as sole user; confirm restricted scopes clear.
2. **Capture one live `sleep` response**, verify the real segment field names against the
   `sleep-normalize.ts` candidate keys (open item), adjust candidates if needed, and commit a
   redacted live fixture.
3. **Register in `~/.claude-assistant/.mcp.json`** as `health` (stdio, `node
   ~/git/google-health-mcp/dist/index.js`, `GOOGLE_HEALTH_*` env).
4. **Cross-check** computed nights against the one-time Takeout dump.
5. **Charts phase** (separate plan): `scripts/charts/` for sleep/steps/HR.

---

## Self-Review

**Spec coverage:**
- `sleep-normalize.ts` (raw→timeline) → Task 1. ✓
- `sleep.ts` engine (reproduce Google + stricter recompute, configurable, degraded cases) → Tasks 2-3. ✓
- `google_health_sleep` tool (single neutral tool; no inflation tool) → Task 4. ✓
- Follow conventions / no separate package → Tasks 1-4 mirror `summary.ts`; documented in Task 5. ✓
- AGENTS.md conventions → Task 5. ✓
- Testing (synthetic fixtures, reproduce-Google sanity, npm test gate) → Tasks 1-3, 6. ✓
- OAuth risk, live-field verification, Takeout cross-check, charts → tracked in Post-implementation. ✓

**Placeholder scan:** No TBD/TODO in executable steps; all code is complete. Open items (live field names) are isolated to Post-implementation with a tolerant-parser mitigation already coded. ✓

**Type consistency:** `SleepNight`/`StageSegment`/`SleepStage` defined in Task 1 and consumed in Tasks 2-3; `SleepConfig`/`DEFAULT_SLEEP_CONFIG`/`SleepNightResult` defined in Task 2 and used in Task 3; `buildSleep`/`formatSleepMarkdown` defined in Task 3 and referenced in Task 4; schema names `SleepInputSchema`/`SleepOutputSchema` consistent between Task 4 schema + registration. Output keys `snake_case` throughout. ✓
