import test from 'node:test';
import assert from 'node:assert/strict';
import { nextPressure, thresholds, pickTerminationCandidate, UsageModel } from './lifecycle.mjs';
import { defaults } from './config.mjs';

const p = () => defaults().performance;
const fresh = () => ({ level: 'normal', since: 0, candidate: null });

test('load must be sustained before the pressure level rises', () => {
  let state = fresh();
  state = nextPressure(state, { cpu: 80, availableMB: 4000 }, p(), 0);
  assert.equal(state.level, 'normal');
  state = nextPressure(state, { cpu: 80, availableMB: 4000 }, p(), 21000);
  assert.equal(state.level, 'elevated');
});

test('memory exhaustion acts immediately', () => {
  const state = nextPressure(fresh(), { cpu: 10, availableMB: 100 }, p(), 0);
  assert.equal(state.level, 'critical');
  assert.equal(state.memoryLow, true);
});

test('hysteresis: recovery needs lower load for 30 seconds', () => {
  let state = { level: 'elevated', since: 0, candidate: null };
  state = nextPressure(state, { cpu: 70, availableMB: 4000 }, p(), 0);
  assert.equal(state.level, 'elevated');
  state = nextPressure(state, { cpu: 50, availableMB: 4000 }, p(), 1000);
  state = nextPressure(state, { cpu: 50, availableMB: 4000 }, p(), 32000);
  assert.equal(state.level, 'normal');
});

test('modes shift thresholds; max never terminates', () => {
  assert.equal(thresholds({ ...p(), mode: 'eco' }).elevated, 60);
  assert.equal(thresholds({ ...p(), mode: 'max' }).terminate, 'never');
});

test('termination picks the costliest long-idle background app and protects the rest', () => {
  const now = 100 * 60000;
  const apps = [
    { id: 'gev', lifecycle: 'background', residency: 'auto', weight: 'heavy', cpu: 40, heapMB: 900, lastActive: now - 25 * 60000 },
    { id: 'board', lifecycle: 'background', residency: 'auto', weight: 'standard', cpu: 2, heapMB: 100, lastActive: now - 30 * 60000 },
    { id: 'home', lifecycle: 'background', residency: 'always', weight: 'standard', cpu: 60, heapMB: 400, lastActive: now - 90 * 60000 },
    { id: 'astra', lifecycle: 'active', residency: 'auto', weight: 'light', cpu: 90, heapMB: 50, lastActive: now },
  ];
  const args = { active: 'astra', protectedIds: new Set(), minIdleMs: 20 * 60000, cooldowns: new Map(), now };
  assert.equal(pickTerminationCandidate(apps, args).id, 'gev');
  assert.equal(pickTerminationCandidate(apps, { ...args, protectedIds: new Set(['gev']) }).id, 'board');
  assert.equal(pickTerminationCandidate(apps, { ...args, cooldowns: new Map([['gev', now + 1], ['board', now + 1]]) }), null);
  assert.equal(pickTerminationCandidate(apps, { ...args, minIdleMs: 60 * 60000 }), null);
});

test('never-used apps count idle time from when they were opened', () => {
  const now = 100 * 60000;
  const app = { id: 'gev', lifecycle: 'background', residency: 'auto', weight: 'heavy', cpu: 40, heapMB: 900, lastActive: 0, openedAt: now - 5 * 60000 };
  const args = { active: 'x', protectedIds: new Set(), minIdleMs: 20 * 60000, cooldowns: new Map(), now };
  assert.equal(pickTerminationCandidate([app], args), null);
});

test('usage model predicts the app used at this hour', () => {
  const usage = new UsageModel('/dev/null');
  const at = new Date(2026, 0, 5, 7, 30);
  usage.add('astra', 1800, at); usage.add('gev', 100, at);
  const guess = usage.predict(0, at.getTime());
  assert.equal(guess.id, 'astra');
  assert(guess.share > 0.9);
  assert.equal(usage.predict(0, new Date(2026, 0, 5, 15).getTime()), null);
});
