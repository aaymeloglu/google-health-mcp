import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GoogleHealthClient } from '../dist/services/google-health-client.js';

const dir = mkdtempSync(join(tmpdir(), 'google-health-mcp-endpoint-contract-'));
const tokenPath = join(dir, 'tokens.json');
writeFileSync(tokenPath, JSON.stringify({ access_token: 'synthetic-token' }), { mode: 0o600 });

const config = {
  clientId: 'synthetic-client',
  clientSecret: 'synthetic-secret',
  redirectUri: 'http://127.0.0.1/callback',
  scopes: [],
  tokenPath,
  privacyMode: 'structured',
  cacheEnabled: false,
  cachePath: join(dir, 'cache.sqlite'),
  apiBaseUrl: 'https://health.googleapis.com',
};
const client = new GoogleHealthClient(config);

const originalFetch = globalThis.fetch;
const originalNoCache = process.env.GOOGLE_HEALTH_NO_CACHE;
const requests = [];
process.env.GOOGLE_HEALTH_NO_CACHE = 'true';

globalThis.fetch = async (input, init = {}) => {
  requests.push({ url: new URL(String(input)), body: init.body ? JSON.parse(String(init.body)) : undefined });
  return Response.json({ rollupDataPoints: [{ steps: { countSum: '42' } }] });
};

try {
  const daily = await client.dailyRollup({
    dataType: 'steps',
    startDate: '2026-07-08',
    endDate: '2026-07-15',
  });
  assert.match(requests[0].url.pathname, /dataTypes\/steps\/dataPoints:dailyRollUp$/);
  assert.deepEqual(requests[0].body.range.start.date, { year: 2026, month: 7, day: 8 });
  assert.deepEqual(requests[0].body.range.end.date, { year: 2026, month: 7, day: 15 });
  assert.equal(daily.rollupDataPoints[0].steps.countSum, '42');

  await client.rollup({
    dataType: 'heart-rate',
    startTime: '2026-07-08T23:00:00-03:00',
    endTime: '2026-07-15T23:00:00-03:00',
    windowSize: '3600s',
  });
  assert.equal(requests[1].body.range.startTime, '2026-07-08T23:00:00-03:00');
  assert.equal(requests[1].body.range.endTime, '2026-07-15T23:00:00-03:00');

  // issue #15: nutrition-log maxDurationDays=90; default/oversize page_size must clamp
  // so window_size_days * page_size never exceeds the cap (independent of date range).
  await client.dailyRollup({
    dataType: 'nutrition-log',
    startDate: '2026-07-13',
    endDate: '2026-07-14',
    pageSize: 100,
  });
  const nutritionReq = requests[2];
  assert.match(nutritionReq.url.pathname, /dataTypes\/nutrition-log\/dataPoints:dailyRollUp$/);
  assert.equal(nutritionReq.body.windowSizeDays, 1);
  assert.equal(nutritionReq.body.pageSize, 90, 'page_size 100 must clamp to 90 for nutrition-log');

  await client.dailyRollup({
    dataType: 'nutrition-log',
    startDate: '2026-07-13',
    endDate: '2026-07-14',
    windowSizeDays: 2,
    pageSize: 100,
  });
  assert.equal(requests[3].body.windowSizeDays, 2);
  assert.equal(requests[3].body.pageSize, 45, '2 * page_size must stay <= 90');

  // steps has no known cap — oversized page_size is left alone (still within MAX)
  await client.dailyRollup({
    dataType: 'steps',
    startDate: '2026-07-13',
    endDate: '2026-07-14',
    pageSize: 100,
  });
  assert.equal(requests[4].body.pageSize, 100);

  // issue #18 / @maxgow on #3: total-calories maxDurationDays=14
  await client.dailyRollup({
    dataType: 'total-calories',
    startDate: '2026-07-13',
    endDate: '2026-07-14',
    pageSize: 100,
  });
  assert.equal(requests[5].body.pageSize, 14, 'page_size 100 must clamp to 14 for total-calories');

  await client.dailyRollup({
    dataType: 'total-calories',
    startDate: '2026-07-13',
    endDate: '2026-07-14',
    windowSizeDays: 2,
    pageSize: 100,
  });
  assert.equal(requests[6].body.windowSizeDays, 2);
  assert.equal(requests[6].body.pageSize, 7, '2 * page_size must stay <= 14 for total-calories');

  // "today" resolves in the caller's timezone, with an injected clock
  const justAfterUtcMidnight = Date.parse('2026-08-03T00:30:00Z'); // 20:30 on 2026-08-02 in New York
  await client.dailyRollup({ dataType: 'steps', startDate: 'today', timezone: 'America/New_York', now: justAfterUtcMidnight });
  assert.deepEqual(requests.at(-1).body.range.start.date, { year: 2026, month: 8, day: 2 });
  assert.deepEqual(requests.at(-1).body.range.end.date, { year: 2026, month: 8, day: 3 });
  await client.dailyRollup({ dataType: 'steps', startDate: '2026-07-08', endDate: 'today', now: justAfterUtcMidnight });
  assert.deepEqual(requests.at(-1).body.range.end.date, { year: 2026, month: 8, day: 3 });

  const fetchCountBeforeInvalid = requests.length;
  for (const action of [
    () => client.dailyRollup({ dataType: 'steps', startDate: '2026-02-30' }),
    () => client.dailyRollup({ dataType: 'steps', startDate: 'today', timezone: 'Mars/Olympus_Mons' }),
    () => client.dailyRollup({ dataType: 'steps', startDate: '' }),
    () => client.dailyRollup({ dataType: 'steps', startDate: '2026-07-15', endDate: '2026-07-08' }),
    () => client.rollup({ dataType: 'heart-rate', startTime: 'not-a-date', endTime: '2026-07-15T00:00:00Z', windowSize: '3600s' }),
    () => client.rollup({ dataType: 'heart-rate', startTime: '2026-07-15T00:00:00Z', endTime: '2026-07-08T00:00:00Z', windowSize: '3600s' }),
  ]) {
    await assert.rejects(action, /Invalid Google Health|Google Health start|Invalid timezone/);
  }
  assert.equal(requests.length, fetchCountBeforeInvalid, 'invalid ranges must fail before HTTP');

  // Exercise the real authenticated request path; cache operations are a generic
  // method+URL Map double. No SQLite constructor, token refresh or network runs.
  const persistentCases = [
    { name: 'initial success', cacheEnabled: true, outcome: 'success' },
    { name: 'refreshed success', cacheEnabled: true, refresh: true, outcome: 'success' },
    { name: 'initial HTTP error', cacheEnabled: true, outcome: 'http' },
    { name: 'refreshed HTTP error', cacheEnabled: true, refresh: true, outcome: 'http' },
    { name: 'same credential HTTP error', cacheEnabled: true, sameCredential: true, outcome: 'http' },
    { name: 'disabled cache HTTP error', cacheEnabled: false, outcome: 'http' },
    { name: 'transport error', cacheEnabled: true, outcome: 'transport' },
    { name: 'response read error', cacheEnabled: true, outcome: 'read' },
  ];
  for (const scenario of persistentCases) {
    const scoped = new GoogleHealthClient({ ...config, cacheEnabled: scenario.cacheEnabled });
    const url = 'https://health.googleapis.com/v4/users/me/identity';
    const key = `GET ${url}`;
    const stale = { marker: 'synthetic-existing-cache-entry' };
    const cached = new Map([[key, stale]]);
    const calls = { opens: 0, gets: 0, sets: 0, refreshes: 0, requests: [] };
    const storage = {
      get(method, requestUrl) { calls.gets++; return cached.get(`${method} ${requestUrl}`); },
      set(method, requestUrl, payload) { calls.sets++; cached.set(`${method} ${requestUrl}`, payload); },
    };
    scoped.getCache = () => { calls.opens++; return storage; };
    let credential = 'synthetic-A';
    scoped.getValidToken = async () => ({ access_token: credential });
    scoped.refreshToken = async () => { calls.refreshes++; return { access_token: 'synthetic-refreshed' }; };
    const error = new Error(`synthetic ${scenario.outcome} failure`);
    let phase = 'first';
    scoped.fetchWithRetry = async (requestUrl, init) => {
      calls.requests.push({ url: requestUrl, authorization: new Headers(init.headers).get('Authorization') });
      if (phase === 'first') return Response.json({ marker: 'synthetic-fresh-A' });
      if (scenario.refresh && calls.refreshes === 0) return new Response('', { status: 401 });
      if (scenario.outcome === 'transport') throw error;
      if (scenario.outcome === 'read') {
        const response = new Response('', { status: 200 });
        response.text = async () => { throw error; };
        return response;
      }
      if (scenario.outcome === 'http') return Response.json({ message: 'synthetic unavailable' }, { status: 503 });
      return Response.json({ marker: 'synthetic-fresh-B' });
    };
    assert.deepEqual(await scoped.getIdentity(), { marker: 'synthetic-fresh-A' }, scenario.name);
    phase = 'second';
    if (!scenario.sameCredential) credential = 'synthetic-B';
    if (scenario.outcome === 'success') {
      assert.deepEqual(await scoped.getIdentity(), { marker: 'synthetic-fresh-B' }, scenario.name);
    } else if (scenario.outcome === 'http') {
      await assert.rejects(() => scoped.getIdentity(), /Google Health API HTTP 503/, scenario.name);
    } else {
      await assert.rejects(() => scoped.getIdentity(), observed => observed === error, scenario.name);
    }
    assert.equal(calls.opens, 0, `${scenario.name}: authenticated payloads must not open persistent cache`);
    assert.equal(calls.gets, 0, `${scenario.name}: authenticated errors must not read fallback`);
    assert.equal(calls.sets, 0, `${scenario.name}: authenticated successes must not persist payloads`);
    assert.deepEqual([...cached.entries()], [[key, stale]], `${scenario.name}: existing cache entries stay untouched`);
    assert.equal(calls.refreshes, scenario.refresh ? 1 : 0, scenario.name);
    assert.deepEqual(calls.requests.map(r => r.url), Array(scenario.refresh ? 3 : 2).fill(url), scenario.name);
    assert.deepEqual(calls.requests.map(r => r.authorization), [
      'Bearer synthetic-A',
      scenario.sameCredential ? 'Bearer synthetic-A' : 'Bearer synthetic-B',
      ...(scenario.refresh ? ['Bearer synthetic-refreshed'] : []),
    ], scenario.name);
  }
  // Status must describe containment without opening or inspecting SQLite.
  for (const configured of [true, false]) {
    const statusClient = new GoogleHealthClient({ ...config, cacheEnabled: configured });
    statusClient.getCache = () => { throw new Error('status must not open SQLite'); };
    const status = statusClient.cacheStatus();
    assert.equal(status.enabled, false);
    assert.equal(status.configured, configured);
    assert.equal(status.authenticated_requests_bypass, true);
    assert.equal(status.existing_entries_preserved, true);
    assert.equal(status.entries_inspected, false);
    assert.equal(Object.hasOwn(status, 'entries'), false, 'uninspected stored entry count must be omitted');
    assert.equal(status.path, config.cachePath);
    assert.match(status.reason, /authenticated payload caching and offline fallback are disabled/i);
    assert.equal(status.http_cache.default_ttl_seconds, 60);
    assert.equal(typeof status.http_cache.hit_count, 'number');
    assert.equal(typeof status.http_cache.miss_count, 'number');
  }
  console.log(JSON.stringify({ ok: true, suite: 'endpoint-contracts', requests: requests.length, persistent_cases: persistentCases.length }, null, 2));
} finally {
  globalThis.fetch = originalFetch;
  if (originalNoCache === undefined) delete process.env.GOOGLE_HEALTH_NO_CACHE;
  else process.env.GOOGLE_HEALTH_NO_CACHE = originalNoCache;
  rmSync(dir, { recursive: true, force: true });
}
