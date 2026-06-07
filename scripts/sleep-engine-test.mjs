import assert from 'node:assert/strict';
import { computeNightMetrics } from '../dist/services/sleep.js';

// A night with a 60m light block (flagged) and a 30m light block (not flagged).
const night = {
  date: '2026-06-01',
  utcOffsetSeconds: 0,
  stagesAvailable: true,
  segments: [
    { start: '2026-06-01T00:00:00Z', end: '2026-06-01T01:30:00Z', stage: 'deep',  seconds: 5400 }, // 90m
    { start: '2026-06-01T01:30:00Z', end: '2026-06-01T02:30:00Z', stage: 'light', seconds: 3600 }, // 60m → flag
    { start: '2026-06-01T02:30:00Z', end: '2026-06-01T03:30:00Z', stage: 'rem',   seconds: 3600 }, // 60m
    { start: '2026-06-01T03:30:00Z', end: '2026-06-01T03:40:00Z', stage: 'awake', seconds: 600 },  // 10m
    { start: '2026-06-01T03:40:00Z', end: '2026-06-01T04:10:00Z', stage: 'light', seconds: 1800 }  // 30m → no flag
  ],
  googleSummary: { minutesAsleep: 240, efficiency: 96 }
};
const r = computeNightMetrics(night);
assert.equal(r.minutes_asleep, 240);          // deep90 + light90 + rem60
assert.equal(r.restorative_minutes, 150);     // deep90 + rem60
assert.equal(r.light_minutes, 90);
assert.equal(r.awake_in_bed, 10);
assert.equal(r.time_in_bed, 250);
assert.equal(r.efficiency, 96);               // 240/250
assert.equal(r.restorative_pct, 62.5);        // 150/240
assert.equal(r.long_light_blocks.length, 1);
assert.deepEqual(r.long_light_blocks[0], { start: '01:30', end: '02:30', minutes: 60 });

// local-time blocks honor the wearable offset (−5h)
const off = computeNightMetrics({ ...night, utcOffsetSeconds: -18000 });
assert.equal(off.long_light_blocks[0].start, '20:30'); // 01:30Z − 5h

// no-stages night → falls back to Google's number, restorative unknown, flagged
const noStages = computeNightMetrics({ date: '2026-06-02', utcOffsetSeconds: 0, stagesAvailable: false, segments: [], googleSummary: { minutesAsleep: 430, efficiency: 88 } });
assert.equal(noStages.minutes_asleep, 430);
assert.equal(noStages.restorative_minutes, 0);
assert.equal(noStages.stages_available, false);
assert.equal(noStages.long_light_blocks.length, 0);

console.log(JSON.stringify({ ok: true, restorative_pct: r.restorative_pct }, null, 2));
