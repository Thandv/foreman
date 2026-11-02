import './env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'cli.ts'), 'utf8');
// The serve branch only: a listener installed anywhere else in cli.ts says nothing about the order serve uses.
const start = source.indexOf("if (cmd === 'serve') {");
const end = source.indexOf('return -1; // stay alive', start);
const serve = source.slice(start, end);

test('serve installs its SIGINT, SIGTERM and SIGHUP listeners before it announces "foreman up"', () => {
  assert.ok(start > 0 && end > start, 'the serve branch is in cli.ts');
  const up = serve.indexOf('foreman up —');
  assert.ok(up > 0, 'the announcement is in the serve branch');
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    const at = serve.indexOf(`process.on('${sig}'`);
    assert.ok(at > 0, `${sig} listener is installed in the serve branch`);
    assert.ok(at < up, `${sig} listener comes before the "foreman up" line`);
  }
});
