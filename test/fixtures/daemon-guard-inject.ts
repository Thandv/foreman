// Preloaded with `node --import` into a spawned `foreman serve` (test/daemon-guard-serve.test.ts). It watches the
// process's own stdout for the 'foreman up' line, then injects the error the test names in GUARD_INJECT.
import fs from 'node:fs';
import net from 'node:net';

const mode = process.env['GUARD_INJECT'];
const portFile = process.env['GUARD_PORT_FILE'];

// The port is 0 (the OS picks one), so the listening server tells the test where it is.
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (this: net.Server, ...args: unknown[]) {
  if (portFile) {
    this.once('listening', () => {
      const addr = this.address();
      if (addr && typeof addr === 'object') fs.writeFileSync(portFile, String(addr.port));
    });
  }
  return (listen as (...a: unknown[]) => net.Server).apply(this, args);
} as typeof net.Server.prototype.listen;

const write = process.stdout.write;
let injected = false;
process.stdout.write = function (this: NodeJS.WriteStream, ...args: unknown[]) {
  const done = (write as (...a: unknown[]) => boolean).apply(this, args);
  if (!injected && String(args[0]).includes('foreman up')) {
    injected = true;
    if (mode === 'reject') void Promise.reject(new Error('injected rejection'));
    if (mode === 'throw') {
      setImmediate(() => {
        throw new Error('injected exception');
      });
    }
  }
  return done;
} as typeof process.stdout.write;
