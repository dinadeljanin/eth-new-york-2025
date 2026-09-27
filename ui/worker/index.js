// volatility-api: read-only proxy for Deribit's public volatility index (DVOL).
// GET /?currency=ETH&days=1095&resolution=1D  ->  [[ts, open, high, low, close], ...]
//
// Deribit docs: public/get_volatility_index_data
//   currency: BTC | ETH, resolution: 1 | 60 | 3600 | 43200 | "1D"
//   max 1000 candles per call; older data via result.continuation (pass as end_timestamp)

const DERIBIT = 'https://www.deribit.com/api/v2/public/get_volatility_index_data';
const CURRENCIES = new Set(['BTC', 'ETH']);
const RESOLUTIONS = new Map([
  ['1', '1'],
  ['60', '60'],
  ['3600', '3600'],
  ['43200', '43200'],
  ['1D', '1D'],
  ['86400', '1D'], // what the frontend historically sent
]);
const MAX_DAYS = 1825;
const MAX_PAGES = 5;
const CACHE_SECONDS = 1800;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS, ...extra },
  });

class UpstreamError extends Error {
  constructor(message, status, snippet) {
    super(message);
    this.status = status;
    this.snippet = snippet;
  }
}

async function fetchPage(currency, start, end, resolution) {
  const qs = new URLSearchParams({
    currency,
    start_timestamp: String(start),
    end_timestamp: String(end),
    resolution,
  });
  const res = await fetch(`${DERIBIT}?${qs}`, {
    headers: { Accept: 'application/json', 'User-Agent': 'volatility-api (dina.wtf)' },
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    // Deribit's edge answers some callers (e.g. Cloudflare Workers egress) with an HTML page.
    throw new UpstreamError('Upstream returned non-JSON', res.status, text.slice(0, 160));
  }
  if (!res.ok || body.error || !body.result || !Array.isArray(body.result.data)) {
    throw new UpstreamError(body.error?.message || 'Unexpected upstream payload', res.status);
  }
  return body.result;
}

async function fetchSeries(currency, days, resolution) {
  const end = Date.now();
  const start = end - days * 86_400_000;
  const byTs = new Map();
  let cursor = end;
  for (let page = 0; page < MAX_PAGES && cursor > start; page++) {
    const { data, continuation } = await fetchPage(currency, start, cursor, resolution);
    for (const row of data) byTs.set(row[0], row);
    if (!continuation || continuation >= cursor || data.length === 0) break;
    cursor = continuation;
  }
  return [...byTs.values()].sort((a, b) => a[0] - b[0]);
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405, { Allow: 'GET, OPTIONS' });

    const url = new URL(request.url);
    const currency = (url.searchParams.get('currency') || 'ETH').toUpperCase();
    const days = Number.parseInt(url.searchParams.get('days') || '30', 10);
    const resolution = RESOLUTIONS.get(url.searchParams.get('resolution') || '1D');

    if (!CURRENCIES.has(currency)) return json({ error: 'currency must be BTC or ETH' }, 400);
    if (!Number.isFinite(days) || days < 1 || days > MAX_DAYS)
      return json({ error: `days must be 1-${MAX_DAYS}` }, 400);
    if (!resolution) return json({ error: 'resolution must be one of 1, 60, 3600, 43200, 1D' }, 400);

    // Normalised cache key (a real URL; the Cache API ignores workers.dev hosts, so this only
    // helps once the worker is on a custom-domain route).
    const cacheKey = new Request(`${url.origin}/__cache/${currency}/${days}/${resolution}`);
    const cache = caches.default;
    const hit = await cache.match(cacheKey);
    if (hit) return hit;

    try {
      const data = await fetchSeries(currency, days, resolution);
      const res = json(data, 200, { 'Cache-Control': `public, max-age=${CACHE_SECONDS}` });
      ctx.waitUntil(cache.put(cacheKey, res.clone()));
      return res;
    } catch (err) {
      if (err instanceof UpstreamError) {
        return json(
          { error: err.message, upstreamStatus: err.status, ...(err.snippet ? { upstreamSnippet: err.snippet } : {}) },
          502,
        );
      }
      return json({ error: 'Worker error', detail: String(err?.message || err) }, 500);
    }
  },
};
