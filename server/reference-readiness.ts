import { Resolver } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { ApiError } from './openrouter';

interface ReadinessOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  now?: () => number;
  pause?: (milliseconds: number) => Promise<void>;
  fetcher?: typeof fetch;
  systemLookup?: (hostname: string) => Promise<string[]>;
  probe?: (url: URL, address: string, proof: string, signal?: AbortSignal) => Promise<boolean>;
}

export function probeHttps(url: URL, address: string, proof: string, signal?: AbortSignal): Promise<boolean> {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve(false);
    // Keep Host/SNI and normal certificate validation. Only address resolution is
    // supplied by the DNS checks, bypassing stale OS-level negative DNS caches.
    const req = request(url, { method: 'GET', family: 4, agent: false, servername: url.hostname, signal, lookup: (_host, _options, callback) => callback(null, address, 4) }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', data => { body += data; if (body.length > 512) req.destroy(); });
      response.on('end', () => resolve(response.statusCode === 200 && body === proof));
      response.on('error', () => resolve(false));
    });
    req.setTimeout(5000, () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false)); req.end();
  });
}

export async function waitForReferenceEndpoint(origin: string, path: string, proof: string, options: ReadinessOptions = {}) {
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;
  const pause = options.pause ?? (milliseconds => delay(milliseconds, undefined, { signal: options.signal }));
  const probe = options.probe ?? probeHttps;
  const hostname = new URL(origin).hostname;
  const deadline = now() + (options.timeoutMs ?? 120_000);
  const lookup = options.systemLookup ?? (async (host: string) => {
    const resolver = new Resolver({ timeout: 2000, tries: 1 });
    return resolver.resolve4(host);
  });
  let sawAddress = false;
  while (now() < deadline && !options.signal?.aborted) {
    const queries = ['https://cloudflare-dns.com/dns-query', 'https://dns.google/resolve'].map(async endpoint => {
      const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000);
      const response = await fetcher(`${endpoint}?name=${encodeURIComponent(hostname)}&type=A`, { headers: { Accept: 'application/dns-json' }, signal, cache: 'no-store' });
      if (!response.ok) return [];
      const data = await response.json() as { Status?: number; Answer?: { type: number; data: string }[] };
      return data.Status === 0 ? (data.Answer ?? []).filter(answer => answer.type === 1 && isIP(answer.data) === 4).map(answer => answer.data) : [];
    });
    const results = await Promise.allSettled([lookup(hostname), ...queries]);
    const addresses = [...new Set(results.flatMap(result => result.status === 'fulfilled' ? result.value : []))].filter(address => isIP(address) === 4);
    sawAddress ||= addresses.length > 0;
    // A DNS record alone is insufficient: verify the private sidecar's exact
    // challenge response over public HTTPS before allowing a paid submission.
    const probes = await Promise.allSettled(addresses.slice(0, 2).map(address => probe(new URL(path, origin), address, proof, options.signal)));
    if (probes.some(result => result.status === 'fulfilled' && result.value)) return;
    if (now() >= deadline || options.signal?.aborted) break;
    try { await pause(Math.min(2000, deadline - now())); } catch { break; }
  }
  if (options.signal?.aborted) throw new ApiError(503, 'HTTPS reference sharing was stopped. No generation was submitted.');
  throw new ApiError(503, sawAddress
    ? 'The HTTPS address exists, but the reference server is not reachable yet. Its address is being kept warm; please retry. No generation was submitted.'
    : 'The temporary address is still propagating in public DNS. Its address is being kept warm; please retry. No generation was submitted.');
}
