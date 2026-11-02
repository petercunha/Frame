import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitForReferenceEndpoint } from './reference-readiness';

test('a stale Cloudflare DNS answer does not block a working Google answer and HTTPS proof', async () => {
  let proofChecked = false;
  const fetcher: typeof fetch = async url => Response.json(String(url).includes('cloudflare-dns') ? { Status: 3 } : { Status: 0, Answer: [{ type: 1, data: '104.16.230.132' }] });
  await waitForReferenceEndpoint('https://test.trycloudflare.com', '/private-ready', 'proof', { fetcher, systemLookup: async () => { throw new Error('negative cache'); }, probe: async (url, address, proof) => { assert.equal(url.pathname, '/private-ready'); assert.equal(address, '104.16.230.132'); assert.equal(proof, 'proof'); proofChecked = true; return true; } });
  assert(proofChecked);
});

test('DNS propagation longer than the old 45-second limit can succeed without a new hostname', async () => {
  let now = 0;
  const names = new Set<string>();
  const fetcher: typeof fetch = async url => {
    names.add(new URL(String(url)).searchParams.get('name')!);
    return Response.json(now < 65_000 ? { Status: 3 } : { Status: 0, Answer: [{ type: 1, data: '104.16.230.132' }] });
  };
  await waitForReferenceEndpoint('https://stable.trycloudflare.com', '/ready', 'proof', { fetcher, systemLookup: async () => [], now: () => now, pause: async milliseconds => { now += milliseconds; }, probe: async () => true });
  assert(now >= 65_000 && now < 120_000);
  assert.deepEqual([...names], ['stable.trycloudflare.com']);
});

test('system DNS can keep references working when both public DNS APIs are unavailable', async () => {
  await waitForReferenceEndpoint('https://test.trycloudflare.com', '/ready', 'proof', { fetcher: async () => { throw new Error('DNS API unavailable'); }, systemLookup: async () => ['104.16.230.132'], probe: async () => true });
});

test('an existing DNS record is insufficient if the file-only HTTPS endpoint is not ready', async () => {
  let now = 0;
  let attempts = 0;
  const fetcher: typeof fetch = async () => Response.json({ Status: 0, Answer: [{ type: 1, data: '104.16.230.132' }] });
  await waitForReferenceEndpoint('https://test.trycloudflare.com', '/ready', 'proof', { fetcher, systemLookup: async () => [], now: () => now, pause: async milliseconds => { now += milliseconds; }, probe: async () => ++attempts >= 3 });
  assert.equal(attempts, 3);
});

test('readiness failure distinguishes DNS failure from an unreachable HTTPS endpoint, and supports shutdown', async () => {
  for (const addressFound of [false, true]) {
    let now = 0;
    await assert.rejects(waitForReferenceEndpoint('https://test.trycloudflare.com', '/ready', 'proof', { timeoutMs: 4000, now: () => now, pause: async milliseconds => { now += milliseconds; }, systemLookup: async () => addressFound ? ['104.16.230.132'] : [], fetcher: async () => Response.json({ Status: 3 }), probe: async () => false }), addressFound ? /reference server is not reachable/ : /propagating in public DNS/);
  }
  const abort = new AbortController(); abort.abort();
  await assert.rejects(waitForReferenceEndpoint('https://test.trycloudflare.com', '/ready', 'proof', { signal: abort.signal }), /was stopped/);
});
