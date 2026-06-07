import type { GoogleHealthClient } from "./google-health-client.js";
import { fromReconciledSleep, type SleepNight, type SleepStage, type StageSegment } from "./sleep-normalize.js";

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
