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
