type VolatilityDataPoint = [number, number, number, number, number];

interface VolatilityIndexParams {
  currency: string;
  days?: number;
  resolution?: number | '1D';
}

// Optional proxy (ui/worker). When unset, or when it fails, the browser calls Deribit directly:
// the public API sends Access-Control-Allow-Origin for any origin and needs no key.
const PROXY_URL: string | undefined = import.meta.env.VITE_VOLATILITY_API_URL || undefined;
const DERIBIT = 'https://www.deribit.com/api/v2/public/get_volatility_index_data';
const MAX_PAGES = 5; // Deribit caps each response at 1000 candles

const toDeribitResolution = (r: number | '1D') => (r === 86400 || r === '1D' ? '1D' : String(r));

const isSeries = (x: unknown): x is VolatilityDataPoint[] =>
  Array.isArray(x) && x.every((p) => Array.isArray(p) && p.length >= 5);

const fetchViaProxy = async (base: string, currency: string, days: number, resolution: number | '1D') => {
  const params = new URLSearchParams({ currency, days: String(days), resolution: toDeribitResolution(resolution) });
  const res = await fetch(`${base}?${params}`);
  const body = await res.json().catch(() => null);
  if (!res.ok || !isSeries(body)) {
    throw new Error(`Volatility proxy error ${res.status}: ${body?.error ?? 'bad payload'}`);
  }
  return body;
};

const fetchDirect = async (currency: string, days: number, resolution: number | '1D') => {
  const end = Date.now();
  const start = end - days * 86_400_000;
  const byTs = new Map<number, VolatilityDataPoint>();
  let cursor = end;
  for (let page = 0; page < MAX_PAGES && cursor > start; page++) {
    const params = new URLSearchParams({
      currency,
      start_timestamp: String(start),
      end_timestamp: String(cursor),
      resolution: toDeribitResolution(resolution),
    });
    const res = await fetch(`${DERIBIT}?${params}`);
    const body = await res.json().catch(() => null);
    const data = body?.result?.data;
    if (!res.ok || !isSeries(data)) {
      throw new Error(`Deribit error ${res.status}: ${body?.error?.message ?? 'bad payload'}`);
    }
    for (const row of data) byTs.set(row[0], row);
    const next = body.result.continuation;
    if (!next || next >= cursor || data.length === 0) break;
    cursor = next;
  }
  return [...byTs.values()].sort((a, b) => a[0] - b[0]);
};

export const fetchVolatilityIndexData = async ({
  currency,
  days = 30,
  resolution = '1D',
}: VolatilityIndexParams): Promise<VolatilityDataPoint[]> => {
  if (PROXY_URL) {
    try {
      return await fetchViaProxy(PROXY_URL, currency, days, resolution);
    } catch (err) {
      console.warn('[volatility] proxy failed, falling back to Deribit directly', err);
    }
  }
  return fetchDirect(currency, days, resolution);
};

export type { VolatilityDataPoint, VolatilityIndexParams };
