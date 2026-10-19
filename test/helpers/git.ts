import type { TestContext } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The environment for a fixture's own git calls: the machine's system gitconfig (ubuntu's adds filter.lfs.*) is not
 * read, and the global config is an empty scratch file made for this test and removed when it ends, so a fixture
 * does not depend on, or write to, the ~/.gitconfig of whoever runs the suite.
 */
export function hermeticGitEnv(t: TestContext): NodeJS.ProcessEnv {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-gitcfg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const global = path.join(dir, 'gitconfig');
  fs.writeFileSync(global, '');
  return { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: global };
}
