import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { deadlineNote, RunClock } from '../src/runClock.ts';
import { FakeTime } from './fakeclock.ts';

const MIN = 60_000;

function clock(budgetMin: number, time = new FakeTime()): { time: FakeTime; c: RunClock; expired: () => number } {
  let n = 0;
  const c = new RunClock(budgetMin * MIN, () => { n++; }, time.now, time);
  return { time, c, expired: () => n };
}

function withCredit<T>(ms: string | undefined, fn: () => T): T {
  const prev = process.env['FOREMAN_SLOT_WAIT_CREDIT_MS'];
  if (ms === undefined) delete process.env['FOREMAN_SLOT_WAIT_CREDIT_MS'];
  else process.env['FOREMAN_SLOT_WAIT_CREDIT_MS'] = ms;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env['FOREMAN_SLOT_WAIT_CREDIT_MS'];
    else process.env['FOREMAN_SLOT_WAIT_CREDIT_MS'] = prev;
  }
}

test('RunClock expires at its budget, once, and not before', () => {
  const { time, c, expired } = clock(60);
  const start = time.now();
  assert.equal(c.deadlineAt, start + 60 * MIN);
  time.advance(60 * MIN - 1);
  assert.equal(expired(), 0, 'one millisecond short of the budget');
  time.advance(1);
  assert.equal(expired(), 1);
  time.advance(600 * MIN);
  assert.equal(expired(), 1, 'an expiry is said once');
});

test('RunClock: a 20-minute pause moves the expiry by 20 minutes', () => {
  const { time, c, expired } = clock(60);
  const start = time.now();
  time.advance(30 * MIN);
  c.pause('test-slot');
  time.advance(20 * MIN);
  assert.equal(c.deadlineAt, start + 80 * MIN, 'the deadline moves on while the wait is open');
  c.resume('test-slot');
  assert.equal(c.pausedMs, 20 * MIN);
  assert.equal(c.deadlineAt, start + 80 * MIN);
  time.advance(30 * MIN - 1);
  assert.equal(expired(), 0, 'at 79:59.999 of wall time the run has had 59:59.999 of its own');
  time.advance(1);
  assert.equal(expired(), 1);
});

test('RunClock: a paused clock does not expire however long the wait, and a stopped one never does', () => {
  const { time, c, expired } = clock(60);
  c.pause('verify-lane');
  time.advance(600 * MIN);
  assert.equal(expired(), 0);
  c.resume('verify-lane');
  time.advance(59 * MIN);
  assert.equal(expired(), 0);
  c.stop();
  time.advance(600 * MIN);
  assert.equal(expired(), 0, 'the run ended first');
});

test('RunClock: overlapping keys count once; the same key opened twice is one wait', () => {
  const { time, c, expired } = clock(60);
  const start = time.now();
  c.pause('test-slot');
  time.advance(10 * MIN);
  c.pause('verify-lane');
  c.pause('verify-lane');
  time.advance(10 * MIN);
  c.resume('test-slot');
  assert.equal(expired(), 0);
  time.advance(10 * MIN);
  c.resume('verify-lane');
  c.resume('verify-lane');
  c.resume('never-opened');
  assert.equal(c.pausedMs, 30 * MIN, '30 minutes of wall time were spent waiting, under two keys that overlapped for 10');
  assert.equal(c.deadlineAt, start + 90 * MIN);
  time.advance(60 * MIN - 1);
  assert.equal(expired(), 0);
  time.advance(1);
  assert.equal(expired(), 1);
});

test('RunClock: worker-slot credit stops at the cap, in total across waits, and the clock runs on past it', () =>
  withCredit(undefined, () => {
    const { time, c, expired } = clock(60);
    const start = time.now();
    c.pause('worker-slot:1');
    time.advance(20 * MIN);
    c.resume('worker-slot:1');
    assert.equal(c.pausedMs, 20 * MIN);
    c.pause('worker-slot:1');
    time.advance(25 * MIN);
    assert.equal(c.pausedMs, 30 * MIN, 'the default cap is 30 minutes for the whole run, not per wait');
    assert.equal(c.deadlineAt, start + 90 * MIN);
    // Still waiting, but the cap is spent: the run's own 60 minutes run from here.
    time.advance(45 * MIN - 1);
    assert.equal(expired(), 0);
    time.advance(1);
    assert.equal(expired(), 1, 'a worker cannot hold its own deadline off for ever by waiting on a slot');
  }));

test('RunClock: the cap is FOREMAN_SLOT_WAIT_CREDIT_MS, and it does not limit the daemon-side waits', () =>
  withCredit(String(5 * MIN), () => {
    const { time, c, expired } = clock(60);
    c.pause('worker-slot:1');
    time.advance(50 * MIN);
    c.resume('worker-slot:1');
    assert.equal(c.pausedMs, 5 * MIN);
    c.pause('test-slot');
    time.advance(120 * MIN);
    c.resume('test-slot');
    assert.equal(c.pausedMs, 125 * MIN, 'a wait behind other runs\' tests is credited in full');
    assert.equal(expired(), 0);
    // 45 of its own minutes are spent (50 waited, 5 credited): 15 left.
    time.advance(15 * MIN - 1);
    assert.equal(expired(), 0);
    time.advance(1);
    assert.equal(expired(), 1);
  }));

test('deadlineNote names the budget, the stage and the queueing that was not charged', () => {
  assert.equal(deadlineNote(60 * MIN, 'work', 12.5 * MIN), 'run deadline (60 min) reached during work; 12.5 min queued were not counted');
  assert.equal(deadlineNote(30 * MIN, null, 0), 'run deadline (30 min) reached during the run; 0 min queued were not counted');
});

// ------------------------------------------------------------ review r1 on-top: rules no test above held

test('RunClock: a resume with no wait open changes nothing, also for a daemon-side key', () => {
  const { time, c, expired } = clock(60);
  c.resume('test-slot');
  c.resume('worker-slot:1');
  c.pause('test-slot');
  time.advance(90 * MIN);
  assert.equal(expired(), 0, 'the stray resume did not cancel the wait that came after it');
  c.resume('test-slot');
  c.resume('test-slot');
  assert.equal(c.pausedMs, 90 * MIN);
  time.advance(60 * MIN - 1);
  assert.equal(expired(), 0);
  time.advance(1);
  assert.equal(expired(), 1);
});

test('RunClock: after expiry nothing moves — a pause is not counted, and it does not expire a second time', () => {
  const { time, c, expired } = clock(60);
  c.pause('test-slot');
  time.advance(10 * MIN);
  c.resume('test-slot');
  time.advance(60 * MIN);
  assert.equal(expired(), 1);
  const [paused, deadline] = [c.pausedMs, c.deadlineAt];
  c.pause('worker-slot:1');
  time.advance(20 * MIN);
  c.resume('worker-slot:1');
  c.pause('verify-lane');
  time.advance(20 * MIN);
  c.resume('verify-lane');
  time.advance(600 * MIN);
  assert.equal(expired(), 1, 'one expiry per run');
  assert.deepEqual([c.pausedMs, c.deadlineAt], [paused, deadline], 'the message a timed-out run ends with does not grow afterwards');
});

test('RunClock: a stopped clock stays stopped through later pauses and resumes', () => {
  const { time, c, expired } = clock(60);
  c.stop();
  c.pause('worker-slot:1');
  time.advance(5 * MIN);
  c.resume('worker-slot:1');
  c.pause('test-slot');
  c.resume('test-slot');
  time.advance(600 * MIN);
  assert.equal(expired(), 0);
});

test('RunClock: a cap of 0 means no credit for a worker\'s own slot wait', () =>
  withCredit('0', () => {
    const { time, c, expired } = clock(60);
    c.pause('worker-slot:1');
    time.advance(60 * MIN - 1);
    assert.equal(c.pausedMs, 0);
    assert.equal(expired(), 0);
    time.advance(1);
    assert.equal(expired(), 1);
  }));

test('RunClock: a budget longer than a timer can hold is waited out in steps, never handed to setTimeout whole', () => {
  // setTimeout fires a delay over 2^31-1 ms after 1 ms: unclamped, a 60-day budget would re-arm in a 1 ms loop.
  const time = new FakeTime();
  const delays: number[] = [];
  const timers = { set: (fn: () => void, ms: number): unknown => { delays.push(ms); return time.set(fn, ms); }, clear: (h: unknown): void => time.clear(h) };
  let n = 0;
  const DAY = 24 * 60 * MIN;
  const c = new RunClock(60 * DAY, () => { n++; }, time.now, timers);
  time.advance(60 * DAY - 1);
  assert.equal(n, 0);
  time.advance(1);
  assert.equal(n, 1);
  assert.ok(delays.length >= 3 && delays.every((ms) => ms <= 2 ** 31 - 1), `every delay fits a timer: ${delays.join(', ')}`);
  c.stop();
});
