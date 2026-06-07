// Standalone health-chart generator. Pulls a date range from the Google Health v4 API
// (via the compiled client) and writes a single self-contained HTML file with four charts:
//   1. Sleep — restorative (deep+REM) vs light vs awake, stacked, with an efficiency line
//   2. Steps — daily bars with the window average
//   3. Resting heart rate — daily trend
//   4. Overnight heart rate — per-sample HR for the most recent night, with sleep-stage bands
//
// Usage (needs the same GOOGLE_HEALTH_* env as the MCP server, and a saved token):
//   node scripts/charts/build-charts.mjs [startYYYY-MM-DD] [endYYYY-MM-DD]
// Output: ~/.google-health-mcp/charts/health-charts.html  (no personal data is committed)

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const distDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../dist/services");
const { GoogleHealthClient } = await import(join(distDir, "google-health-client.js"));
const { getConfig } = await import(join(distDir, "config.js"));
const { buildSleep } = await import(join(distDir, "sleep.js"));
const { fromSleepDataPoints } = await import(join(distDir, "sleep-normalize.js"));

const DAY_MS = 86_400_000;
const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const addDays = (d, n) => isoDate(Date.parse(`${d}T00:00:00Z`) + n * DAY_MS);
const todayUTC = () => new Date().toISOString().slice(0, 10);

const end = process.argv[3] || todayUTC();
const start = process.argv[2] || addDays(end, -13);

const client = new GoogleHealthClient(getConfig());

function isObj(v) { return Boolean(v && typeof v === "object" && !Array.isArray(v)); }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : undefined; }
const ymd = (d) => `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;

// --- 1. Sleep -------------------------------------------------------------
async function getSleep() {
  const r = await buildSleep(client, { start, end });
  return r.nights.filter((n) => n.stages_available).map((n) => ({
    date: n.date,
    restorative: n.restorative_minutes,
    light: n.light_minutes,
    awake: n.awake_in_bed,
    efficiency: n.efficiency
  }));
}

// --- 2. Steps -------------------------------------------------------------
async function getSteps() {
  try {
    const r = await client.dailyRollup({ dataType: "steps", startDate: start, endDate: addDays(end, 1) });
    const points = isObj(r) && Array.isArray(r.rollupDataPoints) ? r.rollupDataPoints : [];
    return points
      .map((p) => ({ date: isObj(p.civilStartTime) ? ymd(p.civilStartTime.date) : undefined, steps: num(p.steps?.countSum) }))
      .filter((p) => p.date && p.steps !== undefined && p.date >= start && p.date <= end)
      .sort((a, b) => a.date.localeCompare(b.date));
  } catch { return []; }
}

// --- 3. Resting heart rate (list + client-side date filter) ---------------
async function getRestingHr() {
  const out = [];
  let pageToken;
  for (let i = 0; i < 30; i++) {
    let r;
    try { r = await client.listDataPoints({ dataType: "daily-resting-heart-rate", pageSize: 50, pageToken }); }
    catch { break; }
    const pts = isObj(r) && Array.isArray(r.dataPoints) ? r.dataPoints : [];
    let passed = false;
    for (const p of pts) {
      const d = isObj(p.dailyRestingHeartRate) && isObj(p.dailyRestingHeartRate.date) ? ymd(p.dailyRestingHeartRate.date) : undefined;
      const bpm = num(p.dailyRestingHeartRate?.beatsPerMinute);
      if (d && bpm !== undefined && d >= start && d <= end) out.push({ date: d, bpm });
      if (d && d < start) passed = true;
    }
    pageToken = isObj(r) && typeof r.nextPageToken === "string" ? r.nextPageToken : undefined;
    if (!pageToken || passed) break;
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

// --- 4. Overnight HR + stage bands for the most recent night --------------
async function getOvernight() {
  let session;
  try { session = (await client.listDataPoints({ dataType: "sleep", pageSize: 5 })).dataPoints?.[0]?.sleep; }
  catch { return null; }
  if (!isObj(session) || !isObj(session.interval)) return null;
  const s = session.interval.startTime, e = session.interval.endTime;
  const off = Number(String(session.interval.startUtcOffset ?? "0s").replace(/s$/, "")) || 0;
  const localHM = (iso) => new Date(Date.parse(iso) + off * 1000).toISOString().slice(11, 16);

  // stage bands
  const night = fromSleepDataPoints({ dataPoints: [{ sleep: session }] })[0];
  const bands = [];
  for (const seg of night?.segments ?? []) {
    const last = bands[bands.length - 1];
    if (last && last.stage === seg.stage) last.end = seg.end;
    else bands.push({ stage: seg.stage, start: seg.start, end: seg.end });
  }

  // HR samples across the session, paged, downsampled to per-minute median
  const byMin = new Map();
  let pageToken;
  for (let i = 0; i < 15; i++) {
    let r;
    try {
      r = await client.listDataPoints({
        dataType: "heart-rate", pageSize: 1000, pageToken,
        filter: `heart_rate.sample_time.physical_time >= "${s}" AND heart_rate.sample_time.physical_time < "${e}"`
      });
    } catch { break; }
    for (const p of (isObj(r) && Array.isArray(r.dataPoints) ? r.dataPoints : [])) {
      const t = p.heartRate?.sampleTime?.physicalTime, bpm = num(p.heartRate?.beatsPerMinute);
      if (!t || bpm === undefined) continue;
      const minKey = new Date(Date.parse(t) + off * 1000).toISOString().slice(0, 16);
      (byMin.get(minKey) ?? byMin.set(minKey, []).get(minKey)).push(bpm);
    }
    pageToken = isObj(r) && typeof r.nextPageToken === "string" ? r.nextPageToken : undefined;
    if (!pageToken) break;
  }
  const hr = [...byMin.entries()]
    .map(([k, v]) => ({ t: k.slice(11, 16), bpm: Math.round(v.sort((a, b) => a - b)[Math.floor(v.length / 2)]) }))
    .sort((a, b) => a.t.localeCompare(b.t));

  return {
    date: night?.date ?? isoDate(Date.parse(e) + off * 1000),
    range: `${localHM(s)}–${localHM(e)}`,
    hr,
    bands: bands.map((b) => ({ stage: b.stage, start: localHM(b.start), end: localHM(b.end) }))
  };
}

console.error(`Fetching ${start} → ${end} …`);
const [sleep, steps, restingHr, overnight] = await Promise.all([getSleep(), getSteps(), getRestingHr(), getOvernight()]);
console.error(`  sleep ${sleep.length} nights · steps ${steps.length} days · restingHr ${restingHr.length} days · overnight ${overnight ? overnight.hr.length + " min" : "n/a"}`);

const data = { start, end, generated: new Date().toISOString(), sleep, steps, restingHr, overnight };

const outDir = join(homedir(), ".google-health-mcp", "charts");
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, "health-charts.html");
writeFileSync(outFile, renderHtml(data));
console.log(outFile);

function renderHtml(d) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Health charts ${d.start} → ${d.end}</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/chartjs-plugin-annotation@3.0.1/dist/chartjs-plugin-annotation.min.js"></script>
<style>
  :root { color-scheme: dark; }
  body { margin:0; background:#0b1020; color:#e6edf3; font:15px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif; }
  header { padding:28px 32px 8px; }
  h1 { margin:0 0 4px; font-size:22px; font-weight:650; letter-spacing:-.01em; }
  .sub { color:#8b98a9; font-size:13px; }
  main { display:grid; gap:22px; padding:20px 32px 48px; max-width:1100px; }
  .card { background:#121a2e; border:1px solid #1f2a44; border-radius:14px; padding:18px 20px 8px; }
  .card h2 { margin:0 0 2px; font-size:15px; font-weight:600; }
  .card p { margin:0 0 12px; color:#8b98a9; font-size:12.5px; }
  .wrap { position:relative; height:300px; }
  footer { padding:0 32px 40px; color:#5c6b7e; font-size:12px; }
</style></head>
<body>
<header><h1>Health charts</h1><div class="sub">${d.start} → ${d.end} · generated ${d.generated.slice(0,16).replace("T"," ")}</div></header>
<main>
  <div class="card"><h2>Sleep composition</h2><p>Restorative (deep+REM) vs light vs awake-in-bed, per night. Line = Google's efficiency.</p><div class="wrap"><canvas id="sleep"></canvas></div></div>
  <div class="card"><h2>Steps</h2><p>Daily steps. Dashed line = window average.</p><div class="wrap"><canvas id="steps"></canvas></div></div>
  <div class="card"><h2>Resting heart rate</h2><p>Daily resting HR.</p><div class="wrap"><canvas id="rhr"></canvas></div></div>
  <div class="card"><h2>Overnight heart rate${d.overnight ? ` — ${d.overnight.date} (${d.overnight.range})` : ""}</h2><p>Per-minute HR across the most recent night, shaded by sleep stage.</p><div class="wrap"><canvas id="night"></canvas></div></div>
</main>
<footer>Source: Google Health API v4 (read-only). Google's stage verdicts, not independently re-derived. Not medical advice.</footer>
<script>
const D = ${JSON.stringify(d)};
const C = { restorative:"#34d399", light:"#60a5fa", awake:"#f87171", deep:"#34d399", rem:"#a78bfa", steps:"#38bdf8", rhr:"#fb7185", hr:"#facc15" };
const grid = { color:"#1f2a44" }, ticks = { color:"#8b98a9" };
const base = (extra={}) => ({ responsive:true, maintainAspectRatio:false, plugins:{ legend:{ labels:{ color:"#c7d2dd" } } }, ...extra });

if (D.sleep.length) new Chart(sleep, { type:"bar", data:{ labels:D.sleep.map(n=>n.date.slice(5)),
  datasets:[
    { type:"bar", label:"restorative", data:D.sleep.map(n=>n.restorative), backgroundColor:C.restorative, stack:"s", yAxisID:"y" },
    { type:"bar", label:"light", data:D.sleep.map(n=>n.light), backgroundColor:C.light, stack:"s", yAxisID:"y" },
    { type:"bar", label:"awake", data:D.sleep.map(n=>n.awake), backgroundColor:C.awake, stack:"s", yAxisID:"y" },
    { type:"line", label:"efficiency %", data:D.sleep.map(n=>n.efficiency), borderColor:"#e6edf3", backgroundColor:"#e6edf3", yAxisID:"y2", tension:.3, pointRadius:2 }
  ]},
  options: base({ scales:{
    x:{ stacked:true, grid, ticks },
    y:{ stacked:true, grid, ticks:{...ticks, callback:v=>(v/60).toFixed(0)+"h" }, title:{display:true,text:"hours",color:"#8b98a9"} },
    y2:{ position:"right", min:0, max:100, grid:{drawOnChartArea:false}, ticks:{...ticks, callback:v=>v+"%"} }
  }}) });

if (D.steps.length){ const avg=D.steps.reduce((a,b)=>a+b.steps,0)/D.steps.length;
  new Chart(steps, { type:"bar", data:{ labels:D.steps.map(s=>s.date.slice(5)),
    datasets:[{ type:"bar", label:"steps", data:D.steps.map(s=>s.steps), backgroundColor:C.steps }]},
    options: base({ plugins:{ legend:{labels:{color:"#c7d2dd"}}, annotation:{ annotations:{ avg:{ type:"line", yMin:avg, yMax:avg, borderColor:"#e6edf3", borderDash:[6,4], borderWidth:1, label:{display:true,content:"avg "+Math.round(avg),color:"#0b1020",backgroundColor:"#e6edf3",position:"end"} } } } },
      scales:{ x:{grid,ticks}, y:{grid,ticks,beginAtZero:true} } }) });
}

if (D.restingHr.length) new Chart(rhr, { type:"line", data:{ labels:D.restingHr.map(r=>r.date.slice(5)),
  datasets:[{ label:"resting HR (bpm)", data:D.restingHr.map(r=>r.bpm), borderColor:C.rhr, backgroundColor:C.rhr, tension:.3, pointRadius:2 }]},
  options: base({ scales:{ x:{grid,ticks}, y:{grid,ticks,title:{display:true,text:"bpm",color:"#8b98a9"}} } }) });

if (D.overnight && D.overnight.hr.length){
  const stageColor={ deep:"rgba(52,211,153,.16)", light:"rgba(96,165,250,.14)", rem:"rgba(167,139,250,.18)", awake:"rgba(248,113,113,.16)" };
  const labels=D.overnight.hr.map(p=>p.t);
  const ann={}; D.overnight.bands.forEach((b,i)=>{ ann["b"+i]={ type:"box", xMin:b.start, xMax:b.end, backgroundColor:stageColor[b.stage]||"transparent", borderWidth:0 }; });
  new Chart(night, { type:"line", data:{ labels, datasets:[{ label:"HR (bpm)", data:D.overnight.hr.map(p=>p.bpm), borderColor:C.hr, backgroundColor:C.hr, pointRadius:0, borderWidth:1.5, tension:.25 }]},
    options: base({ plugins:{ legend:{labels:{color:"#c7d2dd"}}, annotation:{ annotations:ann } },
      scales:{ x:{grid,ticks:{...ticks, maxTicksLimit:12}}, y:{grid,ticks,title:{display:true,text:"bpm",color:"#8b98a9"}} } }) });
}
</script>
</body></html>`;
}
