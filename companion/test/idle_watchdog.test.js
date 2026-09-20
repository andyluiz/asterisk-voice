import assert from 'node:assert/strict';
import test from 'node:test';

import { createIdleWatchdog, shouldResetIdleWatchdog } from '../src/idle_watchdog.js';

function createFakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    setTimeout(fn, delay) {
      const id = nextId++;
      timers.set(id, { at: now + delay, fn });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    advance(ms) {
      const until = now + ms;
      while (true) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= until)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = due[1].at;
        timers.delete(due[0]);
        due[1].fn();
      }
      now = until;
    },
  };
}

test('warns then times out an idle session after its configured inactivity deadlines', () => {
  const clock = createFakeClock();
  const events = [];
  const watchdog = createIdleWatchdog({
    warningMs: 90_000,
    timeoutMs: 120_000,
    setTimeoutFn: clock.setTimeout,
    clearTimeoutFn: clock.clearTimeout,
    onWarning: () => events.push('warning'),
    onTimeout: () => events.push('timeout'),
  });

  watchdog.reset('session-ready');
  clock.advance(89_999);
  assert.deepEqual(events, []);
  clock.advance(1);
  assert.deepEqual(events, ['warning']);
  clock.advance(30_000);
  assert.deepEqual(events, ['warning', 'timeout']);
});

test('caller or assistant activity restarts both inactivity deadlines', () => {
  const clock = createFakeClock();
  const events = [];
  const watchdog = createIdleWatchdog({
    warningMs: 90_000,
    timeoutMs: 120_000,
    setTimeoutFn: clock.setTimeout,
    clearTimeoutFn: clock.clearTimeout,
    onWarning: () => events.push('warning'),
    onTimeout: () => events.push('timeout'),
  });

  watchdog.reset('session-ready');
  clock.advance(80_000);
  watchdog.reset('caller-speech');
  clock.advance(89_999);
  assert.deepEqual(events, []);
  clock.advance(1);
  assert.deepEqual(events, ['warning']);
});

test('pause suppresses idle expiry until the watchdog is resumed', () => {
  const clock = createFakeClock();
  const events = [];
  const watchdog = createIdleWatchdog({
    warningMs: 90_000,
    timeoutMs: 120_000,
    setTimeoutFn: clock.setTimeout,
    clearTimeoutFn: clock.clearTimeout,
    onWarning: () => events.push('warning'),
    onTimeout: () => events.push('timeout'),
  });

  watchdog.reset('session-ready');
  clock.advance(40_000);
  watchdog.pause();
  clock.advance(120_000);
  assert.deepEqual(events, []);
  watchdog.resume('hermes-resolved');
  clock.advance(90_000);
  assert.deepEqual(events, ['warning']);
});

test('the idle warning speech itself does not count as renewed interaction', () => {
  assert.equal(shouldResetIdleWatchdog('assistant-transcript', 'idle-warning'), false);
  assert.equal(shouldResetIdleWatchdog('assistant-transcript', 'hermes-result'), true);
  assert.equal(shouldResetIdleWatchdog('caller-transcript', 'idle-warning'), true);
});
