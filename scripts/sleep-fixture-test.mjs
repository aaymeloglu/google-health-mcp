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
assert.equal(n.minutes_asleep, 204);             // deep100 + light4 + rem100 (Google's definition)
assert.equal(n.restorative_minutes, 200);        // deep100 + rem100
assert.equal(n.light_minutes, 4);
assert.equal(n.awake_in_bed, 20);
assert.equal(n.long_light_blocks.length, 0);     // the 4m light run is below the 45m threshold
assert.equal(n.google_summary.minutes_asleep, 204);

const md = formatSleepMarkdown(result);
assert.ok(md.includes('# Google Health Sleep'));
assert.ok(md.includes('restorative'));

// no-args path returns the single most recent night
const recent = await buildSleep(fakeClient, {});
assert.equal(recent.nights.length, 1);
assert.equal(recent.nights[0].restorative_minutes, 200);

console.log(JSON.stringify({ ok: true, asleep: n.minutes_asleep, restorative: n.restorative_minutes }, null, 2));
