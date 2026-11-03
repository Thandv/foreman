// The launchd plist `foreman service` prints. Pure: it reads nothing but its arguments, installs and loads nothing.

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

export function servicePlist(i: ServicePlistInput): string {
  const vars: Record<string, string> = {};
  for (const name of Object.keys(i.env).sort()) {
    const v = i.env[name];
    if (name.startsWith('FOREMAN_') && v !== undefined) vars[name] = v;
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
