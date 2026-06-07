import assert from 'node:assert/strict';
import { buildSleep, formatSleepMarkdown } from '../dist/services/sleep.js';

// Real Google Health v4 listDataPoints shape (verified against live API 2026-06-07):
// dataPoints[].sleep = { interval, type, stages[], summary }
const fakeClient = {
  async listDataPoints({ dataType, pageToken }) {
    assert.equal(dataType, 'sleep');
    if (pageToken) return { dataPoints: [] }; // single page
    return { dataPoints: [{ sleep: {
      interval: { startTime: '2026-06-01T01:00:00Z', startUtcOffset: '0s', endTime: '2026-06-01T04:44:00Z', endUtcOffset: '0s' },
      type: 'STAGES',
      summary: { minutesInSleepPeriod: '224', minutesAsleep: '204', minutesAwake: '20' },
      stages: [
        { type: 'DEEP',  startTime: '2026-06-01T01:00:00Z', endTime: '2026-06-01T02:40:00Z' }, // 100m
        { type: 'AWAKE', startTime: '2026-06-01T02:40:00Z', endTime: '2026-06-01T02:50:00Z' }, // 10m
        { type: 'LIGHT', startTime: '2026-06-01T02:50:00Z', endTime: '2026-06-01T02:54:00Z' }, // 4m isolated
        { type: 'AWAKE', startTime: '2026-06-01T02:54:00Z', endTime: '2026-06-01T03:04:00Z' }, // 10m
        { type: 'REM',   startTime: '2026-06-01T03:04:00Z', endTime: '2026-06-01T04:44:00Z' }  // 100m
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
assert.equal(n.google_summary.minutes_asleep, 204);  // Google's inflated figure, for reference

const md = formatSleepMarkdown(result);
assert.ok(md.includes('# Google Health Sleep'));
assert.ok(md.includes('2026-06-01'));

// no-args path returns the single most recent night
const recent = await buildSleep(fakeClient, {});
assert.equal(recent.nights.length, 1);
assert.equal(recent.nights[0].minutes_asleep, 200);

console.log(JSON.stringify({ ok: true, asleep: n.minutes_asleep, google: n.google_summary.minutes_asleep }, null, 2));
