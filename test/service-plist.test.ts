import './env.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { servicePlist } from '../src/service.ts';

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
