import type { GoogleHealthClient } from "./google-health-client.js";
import { fromSleepDataPoints, type SleepNight, type SleepStage, type StageSegment } from "./sleep-normalize.js";

const DAY_MS = 24 * 60 * 60 * 1000;

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

export interface SleepParams {
  date?: string;
  start?: string;
  end?: string;
  config?: Partial<SleepConfig>;
}

const SLEEP_PAGE_SIZE = 50;
const SLEEP_MAX_PAGES = 40; // safety cap (~2000 nights)

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function dateString(daysAgo = 0): string {
  return new Date(Date.now() - daysAgo * DAY_MS).toISOString().slice(0, 10);
}

function normalizeDate(value?: string): string {
  return !value || value === "today" ? dateString(0) : value;
}

// The v4 sleep filter DSL rejects every interval member path we can form
// (INVALID_DATA_POINT_FILTER_DATA_TYPE_MEMBER), so we list newest-first and
// page until we've covered the requested range, then filter by local night date
// client-side. This is the reliable contract for the sleep (Session) data type.
async function collectSleepNights(
  client: Pick<GoogleHealthClient, "listDataPoints">,
  keep: (night: SleepNight) => boolean,
  stopWhenBefore?: string
): Promise<SleepNight[]> {
  const out: SleepNight[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < SLEEP_MAX_PAGES; page++) {
    let payload: unknown;
    try {
      payload = await client.listDataPoints({ dataType: "sleep", pageSize: SLEEP_PAGE_SIZE, pageToken });
    } catch {
      break;
    }
    const nights = fromSleepDataPoints(payload);
    let passedRange = false;
    for (const night of nights) {
      if (keep(night)) out.push(night);
      if (stopWhenBefore && night.date < stopWhenBefore) passedRange = true;
    }
    pageToken = isObject(payload) && typeof payload.nextPageToken === "string" ? payload.nextPageToken : undefined;
    if (!pageToken || passedRange) break;
  }
  return out;
}

export async function buildSleep(
  client: Pick<GoogleHealthClient, "listDataPoints">,
  params: SleepParams
) {
  const config: SleepConfig = { ...DEFAULT_SLEEP_CONFIG, ...(params.config ?? {}) };
  const hasRange = Boolean(params.date || params.start || params.end);

  let start: string;
  let end: string;
  let collected: SleepNight[];

  if (!hasRange) {
    // No window given → just the most recent night (the natural "how did I sleep?").
    collected = (await collectSleepNights(client, () => true, undefined)).slice(0, 1);
    start = collected[0]?.date ?? dateString(0);
    end = start;
  } else {
    start = normalizeDate(params.start ?? params.date);
    end = normalizeDate(params.end ?? params.date ?? params.start);
    if (end < start) [start, end] = [end, start];
    collected = await collectSleepNights(client, (n) => n.date >= start && n.date <= end, start);
  }

  collected.sort((a, b) => a.date.localeCompare(b.date)); // newest-first API → chronological
  const nights = collected.map((night) => computeNightMetrics(night, config));

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
