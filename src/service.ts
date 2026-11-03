// The launchd plist `foreman service` prints. servicePlist is pure; stableNodePath only resolves symlinks. Nothing is installed or loaded.

import fs from 'node:fs';

export function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export interface ServicePlistInput {
  node: string;
  cli: string;
  cwd: string;
  home: string; // FOREMAN_HOME, absolute
  env: Record<string, string | undefined>;
  userHome: string;
}

// A name segment (split on _) that marks a secret. Segment, not substring: FOREMAN_COUNCIL_MAX_TOKENS is a count.
// (src/debug.ts has a substring pattern for log fields; it lacks PASSWD/CREDENTIAL/AUTH and would catch the counts.)
const SECRET_SEGMENT = /^(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)$/;

export function looksSecret(name: string): boolean {
  return name.toUpperCase().split('_').some((seg) => SECRET_SEGMENT.test(seg));
}

/** The FOREMAN_* variables set in env that the plist leaves out because their names look secret. */
export function skippedSecrets(env: Record<string, string | undefined>): string[] {
  return Object.keys(env).filter((n) => n.startsWith('FOREMAN_') && env[n] !== undefined && looksSecret(n)).sort();
}

const DISABLES: Record<string, string> = {
  FOREMAN_GATEWAY_KEY: 'gateway models will be called without a key',
  FOREMAN_TRACE_KEY: 'the trace sink will get no Authorization header',
};

/** One line per skipped variable: its name and what stops working under the service. Never the value. */
export function secretWarning(name: string): string {
  const what = DISABLES[name] ?? 'whatever reads it will not see it';
  return `warning: ${name} not written to the plist (secret); ${what}. Start the daemon by hand with it set (foreman serve) to use it.`;
}

/** Prefer a stable node path over a versioned Homebrew Cellar one, when it is the same binary. */
export function stableNodePath(execPath: string, pathEnv: string | undefined): string {
  const at = execPath.indexOf('/Cellar/');
  if (at < 0) return execPath;
  const candidates = [`${execPath.slice(0, at)}/bin/node`];
  const real = (p: string): string | null => {
    try {
      return fs.realpathSync(p);
    } catch {
      return null;
    }
  };
  const onPath = (pathEnv ?? '').split(':').filter(Boolean).map((d) => `${d}/node`).find((p) => real(p) !== null);
  if (onPath) candidates.push(onPath); // the first node on PATH
  const mine = real(execPath);
  for (const c of candidates) if (mine !== null && real(c) === mine) return c;
  return execPath;
}

export function servicePlist(i: ServicePlistInput): string {
  const vars: Record<string, string> = {};
  for (const name of Object.keys(i.env).sort()) {
    const v = i.env[name];
    if (name.startsWith('FOREMAN_') && v !== undefined && !looksSecret(name)) vars[name] = v;
  }
  vars['FOREMAN_HOME'] = i.home;
  vars['PATH'] = i.env['PATH'] ?? '/usr/bin:/bin';
  vars['HOME'] = i.env['HOME'] ?? i.userHome;
  const entries = Object.entries(vars)
    .map(([k, v]) => `    <key>${xmlEscape(k)}</key><string>${xmlEscape(v)}</string>`)
    .join('\n');
  const s = (v: string): string => `<string>${xmlEscape(v)}</string>`;
  // KeepAlive restarts only after a crash (non-zero exit). `foreman stop` and SIGTERM/SIGINT/SIGHUP exit 0 and stay stopped.
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.foreman.daemon</string>
  <key>ProgramArguments</key>
  <array>${s(i.node)}${s(i.cli)}<string>serve</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>WorkingDirectory</key>${s(i.cwd)}
  <key>StandardOutPath</key>${s(`${i.home}/daemon.log`)}
  <key>StandardErrorPath</key>${s(`${i.home}/daemon.err.log`)}
  <key>EnvironmentVariables</key>
  <dict>
${entries}
  </dict>
</dict>
</plist>
`;
}
