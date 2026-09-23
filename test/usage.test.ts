import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { networkKey, UsageLimiter, UsageLimitError, USAGE_LIMITS } from '../src/server/node.js';

const open: UsageLimiter[] = [];
const directories: string[] = [];
const policies = () => ({
  review: { windows: [{ seconds: 60, perIp: 2, site: 4 }], perIpConcurrent: 1, siteConcurrent: 2, leaseSeconds: 20 },
  analyze: { windows: [{ seconds: 60, perIp: 2, site: 4 }], perIpConcurrent: 2, siteConcurrent: 3, leaseSeconds: 20 },
  correct: { windows: [{ seconds: 60, perIp: 2, site: 4 }], perIpConcurrent: 1, siteConcurrent: 2, leaseSeconds: 30 }
});
const create = (path = ':memory:', limits = policies(), now = () => 10000) => {
  const limiter = new UsageLimiter(path, limits, now);
  open.push(limiter);
  return limiter;
};
afterEach(() => {
  for (const limiter of open.splice(0)) limiter.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('persistent usage limits', () => {
  it('allows the boundary, then rejects before another request can be admitted', () => {
    let now = 10000;
    const limiter = create(':memory:', policies(), () => now);
    limiter.reserve('analyze', '192.0.2.1')();
    limiter.reserve('analyze', '192.0.2.1')();
    expect(() => limiter.reserve('analyze', '192.0.2.1')).toThrow(UsageLimitError);
    try { limiter.reserve('analyze', '192.0.2.1'); }
    catch (error) { expect((error as UsageLimitError).retryAfter).toBe(50); }
    now = 60000;
    expect(() => limiter.reserve('analyze', '192.0.2.1')()).not.toThrow();
  });

  it('enforces the longest exhausted window instead of resetting everything each minute', () => {
    let now = 10000;
    const limits = policies();
    limits.analyze.windows.push({ seconds: 3600, perIp: 3, site: 10 });
    const limiter = create(':memory:', limits, () => now);
    limiter.reserve('analyze', '192.0.2.1')();
    limiter.reserve('analyze', '192.0.2.1')();
    now = 60000;
    limiter.reserve('analyze', '192.0.2.1')();
    try { limiter.reserve('analyze', '192.0.2.1'); throw new Error('Quota was not enforced'); }
    catch (error) { expect(error).toMatchObject({ retryAfter: 3540 }); }
  });

  it('shares the site cap across different visitors but keeps the two models independent', () => {
    const limiter = create();
    for (let i = 1; i <= 4; i++) limiter.reserve('analyze', `192.0.2.${i}`)();
    expect(() => limiter.reserve('analyze', '192.0.2.5')).toThrow(UsageLimitError);
    expect(() => limiter.reserve('correct', '192.0.2.5')()).not.toThrow();
  });

  it('persists counters across new processes/connections, and rejects do not consume global quota', () => {
    const directory = mkdtempSync(join(tmpdir(), 'spacebar-limits-'));
    directories.push(directory);
    const path = join(directory, 'usage.sqlite');
    const first = create(path);
    first.reserve('analyze', '192.0.2.1')();
    first.reserve('analyze', '192.0.2.1')();
    const second = create(path);
    expect(() => second.reserve('analyze', '192.0.2.1')).toThrow(UsageLimitError);
    second.reserve('analyze', '192.0.2.2')();
    second.reserve('analyze', '192.0.2.2')();
    expect(() => first.reserve('analyze', '192.0.2.3')).toThrow(UsageLimitError);
  });

  it('limits simultaneous requests, releases idempotently, and recovers abandoned slots', () => {
    let now = 10000;
    const limits = policies();
    limits.analyze.windows[0].perIp = 20;
    limits.analyze.windows[0].site = 50;
    const limiter = create(':memory:', limits, () => now);
    const one = limiter.reserve('analyze', '192.0.2.1');
    limiter.reserve('analyze', '192.0.2.1');
    expect(() => limiter.reserve('analyze', '192.0.2.1')).toThrow(UsageLimitError);
    one(); one();
    limiter.reserve('analyze', '192.0.2.1');
    limiter.reserve('analyze', '192.0.2.2');
    expect(() => limiter.reserve('analyze', '192.0.2.3')).toThrow(UsageLimitError);
    now = 31000;
    expect(() => limiter.reserve('analyze', '192.0.2.1')()).not.toThrow();
  });

  it('does not multiply allowances by rotating IPv6 addresses within one /64', () => {
    const limiter = create();
    limiter.reserve('analyze', '2001:db8::1')();
    limiter.reserve('analyze', '2001:0db8:0000:0000::2')();
    expect(() => limiter.reserve('analyze', '2001:db8::abcd')).toThrow(UsageLimitError);
    expect(() => limiter.reserve('analyze', '2001:db8:0:1::1')()).not.toThrow();
    expect(networkKey('::ffff:192.0.2.1')).toBe(networkKey('192.0.2.1'));
  });

  it('has headroom for 100 visitors typing quickly without exhausting a shared minute cap', () => {
    const limiter = create(':memory:', USAGE_LIMITS);
    // 100 separate visitors, each with 12 requests in flight, then 15 requests/second for one minute.
    const releases = Array.from({ length: 100 }, (_, visitor) =>
      Array.from({ length: 12 }, () => limiter.reserve('analyze', `198.51.100.${visitor + 1}`))
    ).flat();
    releases.forEach((release) => release());
    for (let visitor = 1; visitor <= 100; visitor++) {
      for (let request = 12; request < 900; request++) limiter.reserve('analyze', `198.51.100.${visitor}`)();
      for (let correction = 0; correction < 10; correction++) limiter.reserve('correct', `198.51.100.${visitor}`)();
      for (let review = 0; review < 10; review++) limiter.reserve('review', `198.51.100.${visitor}`)();
    }
  }, 30000);
});
