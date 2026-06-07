# Stage-derived sleep tool — Design Spec

**Date:** 2026-06-07
**Repo:** `google-health-mcp` (fork of `davidmosiah/google-health-mcp`)
**Status:** Approved design, pending implementation plan

## Problem

The Google Health API v4 reports a sleep *summary* whose "time asleep" tends to run
high — brief quiet wakefulness gets counted as sleep, inflating duration and efficiency.
The upstream server surfaces that summary as-is (via `daily_summary` / `weekly_summary`)
and has **no dedicated sleep tool** that exposes the underlying stage timeline or computes
duration from it.

This extension adds a sleep tool that returns the per-night **stage timeline** (AWAKE /
LIGHT / DEEP / REM) and a sleep duration computed **directly from those stages**, with
configurable handling of brief awakenings so the reported number reflects actual sleep
rather than time in bed.

## Approach: fork & extend, follow existing conventions

We fork rather than rebuild because the upstream already solves the expensive parts we
don't want to reimplement against a beta API: Google OAuth 2.0 + restricted-scope flow,
the v4 client (retry/cache/redaction), MCP plumbing, and a privacy layer. `upstream`
remote is retained for pulling future fixes.

### Does the repo already do analytics atop raw data? — Yes.

`src/services/summary.ts` is a substantial derived-analytics layer: it aggregates
rollups/reconciled streams into scorecards, computes averages, and classifies state
(`classifyReadiness`, `classifyWeeklyLoad`, `inferBottlenecks`, action recommendations).

So this is **not** the first analytics in the repo. Per the cleanliness rule (a brand-new
*kind* of code would warrant its own package; an existing kind should follow house style),
the sleep recompute belongs **in `src/services/`, following the established pattern — no
separate package.**

### Established conventions we will match

Observed in `summary.ts` + `google-health-tools.ts` (and to be documented in `AGENTS.md`,
which currently omits them):

- **Service shape:** `src/services/<name>.ts` exports an async `build<Name>(client, params)`
  returning a plain object, plus a paired `format<Name>Markdown(result)`. Pure derivation
  helpers live inline in the service module (as in `summary.ts`).
- **Raw→clean parsing:** isolated in a `*-normalize.ts` service (precedent:
  `nutrition-normalize.ts`). Defensive field extraction via `findNestedNumber`-style
  helpers — the v4 payloads are loosely typed (`unknown`).
- **Resilience:** wrap each upstream call in the `safe()` pattern; track
  `missing_or_failed` and surface a `data_quality.confidence`. Never throw on partial data.
- **Output envelope:** `{ kind, generated_at, source: "google_health", window, beta: true,
  data_quality: {...}, ..., safety: { medical_advice: false, ... } }`. Output keys are
  `snake_case`; internal TS identifiers are `camelCase`.
- **Tool registration:** `server.registerTool("google_health_<x>", { title, description,
  inputSchema: Schema.shape, outputSchema, annotations: { readOnlyHint: true,
  destructiveHint: false, idempotentHint: true, openWorldHint: true } }, handler)`.
- **Handler body:** `try { const r = await build<Name>(client(), params); return
  makeResponse(r, params.response_format, format<Name>Markdown(r)); } catch (e) { return
  makeError(...) }`. Every tool takes `response_format` (json|markdown) and applies the
  privacy layer (`applyPrivacy` / `resolvePrivacyMode`) for any raw passthrough.
- **Schemas:** zod, in `src/schemas/`.
- **Naming:** neutral and descriptive (`daily_summary`, `sleep_minutes`) — no editorializing
  adjectives.

## What we add

### 1. `src/services/sleep-normalize.ts`

Raw v4 sleep data points → a clean per-night timeline. Mirrors `nutrition-normalize.ts`.

```ts
type SleepStage = "awake" | "light" | "deep" | "rem";
interface StageSegment { start: string; end: string; stage: SleepStage; }  // ISO8601
interface SleepNight {
  date: string;                  // night-of date
  segments: StageSegment[];      // ordered, 30s-grained
  stagesAvailable: boolean;      // false for nap/classic logs → no recompute
  googleSummary?: { minutesAsleep?: number; minutesAwake?: number; efficiency?: number };
}
```

Reads via the same path `summary.ts` already uses for sleep — `reconcileDataPoints({
dataType: "sleep", filter: 'sleep.interval.civil_start_time >= "<date>" AND ... < "<end>"',
dataSourceFamily: "users/me/dataSourceFamilies/google-wearables" })` — but parses down to
the session's stage segments rather than stopping at `sleep.summary`. **Open item:** confirm
whether the segment list rides on the reconciled sleep record or requires `listDataPoints`;
verify exact field names against one captured live response.

### 2. `src/services/sleep.ts`

`buildSleep(client, params)` + `formatSleepMarkdown(result)`, following `summary.ts`.
Inline pure helpers compute, per night, from the normalized segments:

- `minutes_asleep` — **the headline number**, computed from stages with stricter wake
  handling (the corrected "what my sleep actually was").
- `minutes_by_stage` (deep / light / rem), `minutes_awake_in_bed`, `time_in_bed`,
  `efficiency`.
- A `google_summary` provenance subfield carrying Google's reported minutes — kept only as
  a quiet sanity/debug reference, not a headline and not framed as a delta.

Configurable wake handling (sensible defaults; overridable via params):
- `waso_threshold_min` — minimum contiguous AWAKE run that counts as wake.
- `reclassify_isolated_light` (+ `isolated_light_window_min`) — a LIGHT run bracketed by
  AWAKE on both sides within the window is treated as wake.
- `trim_onset` / `trim_final_awakening` — drop leading/trailing wake+light padding.

Degraded handling per convention: `stagesAvailable=false` → return `google_summary` with a
`data_quality` flag and no recompute; no data → empty night list, never a throw.

### 3. Tool: `google_health_sleep`

The dedicated sleep tool the upstream lacks. One date or a range; returns the per-night
result above (timeline + stage-derived durations + efficiency), in the house envelope.

```
google_health_sleep({ date? | start?, end?, config?, response_format? })
```

That is the whole sleep surface for v1 — it answers "what was my sleep," with the timeline
available for any drill-down. (No separate "inflation" tool, no delta metric.)

### 4. `AGENTS.md` — document the conventions above

The current `AGENTS.md` has Commands + Rules but no description of the service/tool/envelope
conventions. Add a short **Conventions** section capturing the patterns listed here, so the
next contributor (or agent) follows them without reverse-engineering `summary.ts`.

## Charts (later phase — out of v1 scope)

A standalone chart script (`scripts/charts/`) consuming series for sleep/steps/HR — not a
chart-rendering MCP tool. Designed later; the first plan ships only the data tool.

## Testing

- Engine helpers: `scripts/sleep-engine-test.mjs` over synthetic nights (all-wake,
  no-stages, isolated-light-bracketed-by-wake, normal). Follows the repo's
  `scripts/*-test.mjs` fixture pattern and is wired into the `npm test` gate.
- Normalizer: against one captured, redacted live v4 sleep response committed as a fixture.
- Sanity: stricter-recompute with all thresholds at zero must reproduce `google_summary`
  minutes from the same segments (proves parsing).

## Data sources & validation

- **Primary:** Google Health API v4 via the inherited client (ongoing source).
- **Takeout dump:** historical backfill / cross-check only; the one-time export is the new
  CSV format and its per-night segment availability is **unverified** (the `Sleep/` folder
  holds a weekly profile; `Sleep Score/sleep_score.csv` holds nightly summary scores). If it
  lacks the segment timeline it is used only to cross-check nightly minutes, not as engine
  input.

## OAuth / access — the known risk

All v4 scopes are **Restricted**; Google requires a privacy/security review to *publish* an
app. For single-user personal use the path is the OAuth app in **testing mode with the owner
as sole test user**, which normally clears restricted scopes without the full review —
confirmed only when the Google Cloud project is registered and the auth flow is run.
Mitigation if blocked: a legacy Fitbit Web API adapter behind the same `sleep-normalize`
contract (no-approval Personal app, full stages) — but it shuts down Sept 2026, so it is a
stopgap only, not built unless Google blocks access.

## Integration / registration

- Build `npm run build` → `dist/index.js`. Register in `.mcp.json` as **`health`** (stdio,
  `node .../dist/index.js`, `GOOGLE_HEALTH_*` OAuth env).
- Public repo on the owner's account; `upstream` remote retained.

## Out of scope (YAGNI for v1)

- Chart rendering (separate later phase).
- The other ~17 Takeout categories.
- Write/logging tools (inherited but unused).
- Fitbit legacy fallback adapter (only if Google blocks personal access).
- Integration with the upstream "Delx Wellness" profile ecosystem.

## Open items to resolve during implementation

1. Whether v4 sleep stage segments ride on the reconciled `sleep` record or need
   `listDataPoints`; exact segment field names — verify against a live response.
2. Whether the Takeout CSV dump contains a per-night stage timeline.
3. Whether restricted scopes clear in testing mode for the owner's account.
