import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'cli.ts'), 'utf8');

test('serve installs its SIGINT, SIGTERM and SIGHUP listeners before it announces "foreman up"', () => {
  const up = source.indexOf('foreman up —');
  assert.ok(up > 0, 'the announcement is in cli.ts');
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    const at = source.indexOf(`process.on('${sig}'`);
    assert.ok(at > 0, `${sig} listener is installed in cli.ts`);
    assert.ok(at < up, `${sig} listener comes before the "foreman up" line`);
  }
});
