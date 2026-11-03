import './env.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { secretWarning, servicePlist, skippedSecrets, stableNodePath } from '../src/service.ts';

// A small plist reader (dict, array, string, true, false): enough to parse what servicePlist writes, so the tests
// check the document's meaning rather than substrings. Nothing is installed or loaded.
type PV = string | boolean | PV[] | { [k: string]: PV };
function unescape(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}
function parsePlist(xml: string): PV {
  const body = xml.slice(xml.indexOf('<plist'));
  const toks = body.match(/<[^>]+>|[^<]+/g)!.filter((t) => t.trim() !== '');
  let i = 1; // after <plist ...>
  const value = (): PV => {
    const t = toks[i++]!;
    if (t === '<true/>') return true;
    if (t === '<false/>') return false;
    if (t === '<string>') {
      // One text token at most, with no bare & in it: an unescaped < or & is a broken plist, not text.
      const text = toks[i] === '</string>' ? '' : toks[i++]!;
      assert.equal(toks[i++], '</string>', `an unescaped < in a string: ${text}`);
      assert.doesNotMatch(text, /&(?!(?:amp|lt|gt|quot|apos);)/, `an unescaped & in a string: ${text}`);
      return unescape(text);
    }
    if (t === '<array>') {
      const a: PV[] = [];
      while (toks[i] !== '</array>') a.push(value());
      i++;
      return a;
    }
    if (t === '<dict>') {
      const d: { [k: string]: PV } = {};
      while (toks[i] !== '</dict>') {
        assert.equal(toks[i++], '<key>');
        const k = unescape(toks[i++]!);
        assert.equal(toks[i++], '</key>');
        d[k] = value();
      }
      i++;
      return d;
    }
    throw new Error(`unexpected token ${t}`);
  };
  return value();
}

const base = { node: '/usr/bin/node', cli: '/x/cli.ts', cwd: '/work', home: '/h/.foreman', userHome: '/Users/u' };

test('the plist has KeepAlive {SuccessfulExit: false}, not a bare true', () => {
  const p = parsePlist(servicePlist({ ...base, env: {} })) as Record<string, PV>;
  assert.deepEqual(p['KeepAlive'], { SuccessfulExit: false });
  assert.equal(p['RunAtLoad'], true);
  assert.deepEqual(p['ProgramArguments'], ['/usr/bin/node', '/x/cli.ts', 'serve']);
});

test('every FOREMAN_* variable in the environment is carried, with PATH and HOME, and nothing else', () => {
  const env = {
    FOREMAN_HOME: '/relative',
    FOREMAN_MAX_WORKERS: '3',
    FOREMAN_PORT: '4999',
    FOREMAN_DEBUG: '1',
    FOREMAN_CLAUDE_BIN: '/opt/claude',
    PATH: '/opt/bin:/usr/bin',
    HOME: '/Users/real',
    SECRET_TOKEN: 'nope',
    FOREMANX: 'nope',
  };
  const p = parsePlist(servicePlist({ ...base, env })) as Record<string, PV>;
  assert.deepEqual(p['EnvironmentVariables'], {
    FOREMAN_CLAUDE_BIN: '/opt/claude',
    FOREMAN_DEBUG: '1',
    FOREMAN_HOME: '/h/.foreman', // the resolved absolute home wins
    FOREMAN_MAX_WORKERS: '3',
    FOREMAN_PORT: '4999',
    PATH: '/opt/bin:/usr/bin',
    HOME: '/Users/real',
  });
});

test('HOME and PATH fall back when the environment lacks them', () => {
  const p = parsePlist(servicePlist({ ...base, env: {} })) as Record<string, Record<string, PV>>;
  assert.equal(p['EnvironmentVariables']!['HOME'], '/Users/u');
  assert.equal(p['EnvironmentVariables']!['PATH'], '/usr/bin:/bin');
});

test('a value with & < > and quotes is XML-escaped in the text and round-trips through the parse', () => {
  const nasty = `a&b <c> "d" 'e' &amp;`;
  const xml = servicePlist({ ...base, cwd: '/w&x<y>', env: { FOREMAN_NASTY: nasty } });
  assert.ok(xml.includes('<key>FOREMAN_NASTY</key><string>a&amp;b &lt;c&gt; &quot;d&quot; &apos;e&apos; &amp;amp;</string>'), xml);
  assert.ok(!xml.includes('<c>'));
  const p = parsePlist(xml) as Record<string, PV>;
  assert.equal((p['EnvironmentVariables'] as Record<string, PV>)['FOREMAN_NASTY'], nasty);
  assert.equal(p['WorkingDirectory'], '/w&x<y>');
});

test('`foreman service` itself carries the FOREMAN_* variables of the shell it runs in', () => {
  const cli = path.join(import.meta.dirname, '..', 'src', 'cli.ts');
  const xml = execFileSync(process.execPath, [cli, 'service'], {
    env: { ...process.env, FOREMAN_SERVICE_PROBE: 'a&b<c>' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  });
  const env = (parsePlist(xml) as Record<string, Record<string, PV>>)['EnvironmentVariables']!;
  assert.equal(env['FOREMAN_SERVICE_PROBE'], 'a&b<c>');
  assert.equal(env['FOREMAN_HOME'], process.env['FOREMAN_HOME']);
});

test('secret-looking FOREMAN_* variables are left out of the plist, non-secret ones stay, and each skip is warned without its value', () => {
  const env = {
    FOREMAN_GATEWAY_KEY: 'gw-value-123',
    FOREMAN_TRACE_KEY: 'trace-value-456',
    FOREMAN_DB_PASSWORD: 'pw-value-789',
    FOREMAN_X_SECRETS: 'sec-value-1', FOREMAN_X_CREDENTIALS: 'cred-value-2', FOREMAN_APIKEY: 'api-value-3',
    FOREMAN_COUNCIL_MAX_TOKENS: '900',
    FOREMAN_KEYBOARD: 'dvorak',
    FOREMAN_PORT: '4999',
  };
  const xml = servicePlist({ ...base, env });
  const vars = (parsePlist(xml) as Record<string, Record<string, PV>>)['EnvironmentVariables']!;
  for (const n of ['FOREMAN_GATEWAY_KEY', 'FOREMAN_TRACE_KEY', 'FOREMAN_DB_PASSWORD', 'FOREMAN_X_SECRETS', 'FOREMAN_X_CREDENTIALS', 'FOREMAN_APIKEY']) {
    assert.ok(!(n in vars), n);
  }
  assert.equal(vars['FOREMAN_COUNCIL_MAX_TOKENS'], '900');
  assert.equal(vars['FOREMAN_KEYBOARD'], 'dvorak');
  assert.equal(vars['FOREMAN_PORT'], '4999');
  const skipped = skippedSecrets(env);
  assert.deepEqual(skipped, ['FOREMAN_APIKEY', 'FOREMAN_DB_PASSWORD', 'FOREMAN_GATEWAY_KEY', 'FOREMAN_TRACE_KEY', 'FOREMAN_X_CREDENTIALS', 'FOREMAN_X_SECRETS']);
  const warnings = skipped.map(secretWarning);
  skipped.forEach((n, k) => assert.ok(warnings[k]!.includes(n)));
  assert.match(warnings[2]!, /gateway/);
  assert.match(warnings[3]!, /trace/);
  const out = xml + warnings.join('\n');
  for (const v of ['gw-value-123', 'trace-value-456', 'pw-value-789', 'sec-value-1', 'cred-value-2', 'api-value-3']) assert.ok(!out.includes(v), v);
});

test('`foreman service` prints a warning per skipped secret on stderr and no value anywhere', () => {
  const cli = path.join(import.meta.dirname, '..', 'src', 'cli.ts');
  const r = spawnSync(process.execPath, [cli, 'service'], {
    env: { ...process.env, FOREMAN_GATEWAY_KEY: 'sekrit-gw', FOREMAN_TRACE_KEY: 'sekrit-tr' }, encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /FOREMAN_GATEWAY_KEY/);
  assert.match(r.stderr, /FOREMAN_TRACE_KEY/);
  assert.ok(!(r.stdout + r.stderr).includes('sekrit'));
  const vars = (parsePlist(r.stdout) as Record<string, Record<string, PV>>)['EnvironmentVariables']!;
  assert.ok(!('FOREMAN_GATEWAY_KEY' in vars) && !('FOREMAN_TRACE_KEY' in vars));
  assert.equal(vars['FOREMAN_HOME'], process.env['FOREMAN_HOME'], 'the parsed plist is the real one');
});

test('a versioned Cellar node path is replaced by the stable one when it is the same binary; otherwise execPath is kept', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'svc-node-')));
  try {
    const cellar = path.join(root, 'Cellar', 'node', '26.0.0', 'bin', 'node');
    fs.mkdirSync(path.dirname(cellar), { recursive: true });
    fs.writeFileSync(cellar, '#!/bin/sh\n');
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    fs.symlinkSync(cellar, path.join(bin, 'node'));
    assert.equal(stableNodePath(cellar, '/nonexistent'), path.join(bin, 'node'));
    fs.unlinkSync(path.join(bin, 'node'));
    const other = path.join(root, 'other');
    fs.mkdirSync(other);
    fs.symlinkSync(cellar, path.join(other, 'node'));
    assert.equal(stableNodePath(cellar, ['/nonexistent', other].join(':')), path.join(other, 'node'));
    fs.unlinkSync(path.join(other, 'node'));
    fs.writeFileSync(path.join(other, 'node'), 'different');
    assert.equal(stableNodePath(cellar, other), cellar);
    assert.equal(stableNodePath('/usr/bin/node', other), '/usr/bin/node');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
