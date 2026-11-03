import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeAfterStops, stopsFirst } from './helpers/removal.ts';

// The dir is registered first, as the fixtures do; plain t.after hooks would remove it before either stop ran.
const seen: string[] = [];
let dir = '';
test('removeAfterStops: a dir registered before the stoppers is still there while each of them runs', (t) => {
  dir = removeAfterStops(t, fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-removal-')));
  for (const name of ['first', 'second']) {
    stopsFirst(t, async () => {
      await new Promise((r) => setImmediate(r));
      seen.push(`${name}:${fs.existsSync(dir)}`);
    });
  }
});

test('removeAfterStops: and it is removed once the last stopper has finished', () => {
  assert.deepEqual(seen, ['first:true', 'second:true']);
  assert.equal(fs.existsSync(dir), false);
});
