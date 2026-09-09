import assert from 'node:assert/strict';
import { buildSleep } from '../dist/services/sleep.js';

// A fetch failure (auth expiry, network, API error) must surface as a thrown
// error — never be swallowed into an empty "0 nights" result. listDataPoints
// already retries transient blips internally, so anything that reaches buildSleep
// is a real failure the caller must see.
const failingClient = {
  async listDataPoints() {
    throw new Error('invalid_grant: refresh token rejected');
  }
};

await assert.rejects(
  () => buildSleep(failingClient, {}),
  /invalid_grant/,
  'buildSleep should propagate a listDataPoints failure, not return empty nights'
);

await assert.rejects(
  () => buildSleep(failingClient, { start: '2026-06-21', end: '2026-06-28' }),
  /invalid_grant/,
  'ranged buildSleep should propagate a listDataPoints failure too'
);

// Healthy client with zero data points is the ONLY legitimate "0 nights" path.
const emptyClient = { async listDataPoints() { return { dataPoints: [] }; } };
const empty = await buildSleep(emptyClient, {});
assert.equal(empty.data_quality.nights, 0);
assert.equal(empty.data_quality.confidence, 'low');

console.log(JSON.stringify({ ok: true, propagates_errors: true }, null, 2));

// The tool-level error response must still satisfy SleepOutputSchema; otherwise a
// strict MCP client rejects the response instead of showing the error message.
const { makeSummaryError } = await import('../dist/services/format.js');
const { SleepOutputSchema } = await import('../dist/schemas/common.js');
const errorResponse = makeSummaryError('sleep', 'invalid_grant: refresh token rejected', 'markdown');
assert.equal(errorResponse.isError, true);
assert.doesNotThrow(() => SleepOutputSchema.parse(errorResponse.structuredContent), 'sleep error payload must match SleepOutputSchema');
assert.match(errorResponse.structuredContent.error, /invalid_grant/);
