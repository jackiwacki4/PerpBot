import test from 'node:test';
import assert from 'node:assert/strict';

import { pruneRateLimits, rateLimit } from '../lib/app.js';

const limit = { windowMs: 1000, maxRequests: 3 };

test('rate limit allows traffic up to the cap', () => {
  const now = Date.now();
  for (let i = 0; i < 3; i++) {
    assert.equal(rateLimit('a', now, limit).allowed, true, `request ${i + 1} should pass`);
  }
});

test('rate limit rejects once the cap is exceeded', () => {
  const now = Date.now();
  for (let i = 0; i < 3; i++) rateLimit('b', now, limit);
  const blocked = rateLimit('b', now, limit);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSec > 0, 'tells the client when to come back');
});

test('rate limit resets after the window passes', () => {
  const now = Date.now();
  for (let i = 0; i < 4; i++) rateLimit('c', now, limit);
  assert.equal(rateLimit('c', now, limit).allowed, false);
  assert.equal(rateLimit('c', now + 1001, limit).allowed, true);
});

test('rate limit tracks clients independently', () => {
  const now = Date.now();
  for (let i = 0; i < 4; i++) rateLimit('d', now, limit);
  assert.equal(rateLimit('d', now, limit).allowed, false);
  assert.equal(rateLimit('e', now, limit).allowed, true);
});

test('pruning drops only expired windows', () => {
  const now = Date.now();
  rateLimit('old', now, limit);
  rateLimit('fresh', now + 900, limit);
  pruneRateLimits(now + 1500, limit);

  // "old" was pruned, so its next request starts a fresh window and passes.
  assert.equal(rateLimit('old', now + 1500, limit).allowed, true);
});
