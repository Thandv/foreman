#!/usr/bin/env node
// Ported from the author's earlier tools (already zero-dependency;
// the diff algorithm itself lives unchanged in ./lib.js). This file is only
// the stdin/stdout wrapper for the toolbox calling convention.
//
// stdin: { before: string, after: string }
// stdout: { lines: [{kind: "same"|"add"|"remove"|"note", text}] }
import { unifiedDiff } from './lib.js';

function readStdin() {
  return new Promise((resolve, reject) => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { raw += chunk; });
    process.stdin.on('end', () => resolve(raw));
    process.stdin.on('error', reject);
  });
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

async function main() {
  const raw = await readStdin();
  let args;
  try {
    args = JSON.parse(raw || '{}');
  } catch (err) {
    return fail(`invalid JSON on stdin: ${err.message}`);
  }
  if (args === null || typeof args !== 'object') return fail('input must be a JSON object');
  const { before, after } = args;
  if (typeof before !== 'string' || typeof after !== 'string') {
    return fail('before and after must both be strings');
  }
  process.stdout.write(JSON.stringify({ lines: unifiedDiff(before, after) }));
}

main().catch((err) => fail(`unexpected error: ${err.message}`));
