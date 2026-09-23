import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { isIP } from 'node:net';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { RateLimitError } from './limits.js';
import type { ModelRoute } from './limits.js';
export type { ModelRoute } from './limits.js';
export type WindowLimit = { seconds: number; perIp: number; site: number };
export type Policy = { windows: WindowLimit[]; perIpConcurrent: number; siteConcurrent: number; leaseSeconds: number };
export type Policies = Record<ModelRoute, Policy>;

export const USAGE_LIMITS: Policies = {
  review: {
    windows: [
      { seconds: 60, perIp: 30, site: 3000 },
      { seconds: 3600, perIp: 150, site: 15000 },
      { seconds: 86400, perIp: 500, site: 50000 }
    ],
    perIpConcurrent: 1, siteConcurrent: 100, leaseSeconds: 20
  },
  analyze: {
    windows: [
      { seconds: 60, perIp: 1500, site: 150000 },
      { seconds: 3600, perIp: 20000, site: 2000000 },
      { seconds: 86400, perIp: 50000, site: 2000000 }
    ],
    perIpConcurrent: 12, siteConcurrent: 1200, leaseSeconds: 20
  },
  correct: {
    windows: [
      { seconds: 60, perIp: 30, site: 3000 },
      { seconds: 3600, perIp: 150, site: 15000 },
      { seconds: 86400, perIp: 500, site: 50000 }
    ],
    perIpConcurrent: 3, siteConcurrent: 300, leaseSeconds: 30
  }
};

export class UsageLimitError extends RateLimitError {
  constructor(retryAfter: number, kind: ModelRoute) {
    const wait = retryAfter < 60 ? `${retryAfter} seconds` : `${Math.ceil(retryAfter / 60)} minutes`;
    super(retryAfter, `${kind === 'analyze' ? 'Spacing' : kind === 'review' ? 'Full-text review' : 'Typo correction'} limit reached. Try again in ${wait}. You can keep typing.`);
  }
}

// Group an IPv6 /64 so rotating interface addresses cannot reset a visitor's quota.
export function networkKey(address: string): string {
  if (isIP(address) === 4) return address;
  if (isIP(address) !== 6) throw new Error('Invalid client address');
  const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const [left, right] = canonical.split('::');
  const start = left ? left.split(':') : [];
  const end = right ? right.split(':') : [];
  const parts = right === undefined ? start : [...start, ...Array(8 - start.length - end.length).fill('0'), ...end];
  const words = parts.map((part) => Number.parseInt(part, 16));
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 65535) {
    return [words[6] >> 8, words[6] & 255, words[7] >> 8, words[7] & 255].join('.');
  }
  return words.slice(0, 4).map((word) => word.toString(16)).join(':') + '::/64';
}

export class UsageLimiter {
  private db: DatabaseSync;
  private salt: string;
  private lastCleanup = 0;

  constructor(path: string, private policies: Policies = USAGE_LIMITS, private now = Date.now) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=2000;
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS budgets (key TEXT PRIMARY KEY, used INTEGER NOT NULL, resets INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS budgets_expiry ON budgets(resets);
      CREATE TABLE IF NOT EXISTS leases (id TEXT PRIMARY KEY, client TEXT NOT NULL, kind TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS leases_expiry ON leases(expires);
    `);
    this.db.prepare('INSERT OR IGNORE INTO metadata VALUES (?, ?)').run('salt', randomBytes(32).toString('hex'));
    this.salt = (this.db.prepare('SELECT value FROM metadata WHERE key = ?').get('salt') as { value: string }).value;
  }

  reserve(kind: ModelRoute, address: string): () => void {
    const client = createHmac('sha256', this.salt).update(networkKey(address)).digest('hex');
    const now = Math.floor(this.now() / 1000);
    const policy = this.policies[kind];
    const lease = randomUUID();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM leases WHERE expires <= ?').run(now);
      if (now - this.lastCleanup >= 60) {
        this.db.prepare('DELETE FROM budgets WHERE resets <= ?').run(now);
        this.lastCleanup = now;
      }
      const budgets = policy.windows.flatMap(({ seconds, perIp, site }) => {
        const resets = (Math.floor(now / seconds) + 1) * seconds;
        return [
          { key: `${kind}:${seconds}:${client}`, limit: perIp, resets },
          { key: `${kind}:${seconds}:site`, limit: site, resets }
        ];
      }).map((budget) => {
        const row = this.db.prepare('SELECT used, resets FROM budgets WHERE key = ?').get(budget.key) as { used: number; resets: number } | undefined;
        return { ...budget, used: row && row.resets > now ? row.used : 0 };
      });
      const blocked = budgets.filter((budget) => budget.used >= budget.limit);
      if (blocked.length) throw new UsageLimitError(Math.max(...blocked.map((budget) => budget.resets - now)), kind);

      const active = this.db.prepare('SELECT client, expires FROM leases WHERE kind = ?').all(kind) as { client: string; expires: number }[];
      const own = active.filter((row) => row.client === client);
      if (active.length >= policy.siteConcurrent || own.length >= policy.perIpConcurrent) {
        throw new UsageLimitError(2, kind);
      }
      // Count before sending a paid request, and never refund on disconnect or provider failure.
      const update = this.db.prepare('INSERT INTO budgets VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET used=excluded.used, resets=excluded.resets');
      for (const budget of budgets) update.run(budget.key, budget.used + 1, budget.resets);
      this.db.prepare('INSERT INTO leases VALUES (?, ?, ?, ?)').run(lease, client, kind, now + policy.leaseSeconds);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    let released = false;
    return () => {
      if (released) return;
      this.db.prepare('DELETE FROM leases WHERE id = ?').run(lease);
      released = true;
    };
  }

  close() { this.db.close(); }
}
