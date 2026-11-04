import { memoryWarning, type MemoryState } from './memory.ts';

/**
 * Ping order for `foreman doctor`. Local models are pinged one at a time (the
 * machine holds one at once), so on a Mac where another process keeps a model
 * resident each local ping can run its full timeout. The remote models (the
 * claude-cli ones do most real work) run alongside that sequence instead of
 * after it, so a spent budget can never leave them 'not pinged'.
 * Results keep the roster order: local first, then remote.
 */
export async function pingRoster<S extends { local: boolean }, R>(
  all: S[],
  pingLocal: (spec: S) => Promise<R>,
  pingRemote: (spec: S) => Promise<R>,
): Promise<R[]> {
  const remote = Promise.all(all.filter((s) => !s.local).map(pingRemote));
  const local: R[] = [];
  for (const spec of all.filter((s) => s.local)) local.push(await pingLocal(spec));
  return [...local, ...await remote];
}

export interface ResidentModel { name: string; sizeGb: number }

/** `llama3.1` and `llama3.1:latest` are one model. */
function same(a: string, b: string): boolean {
  const norm = (n: string): string => (n.includes(':') ? n : `${n}:latest`);
  return norm(a) === norm(b);
}

/**
 * The swap note, or null. Only when Ollama (/api/ps, read before doctor's own pings load anything) holds other
 * models and evicting them makes room for `target`; with no room even then it is a real shortage.
 */
export function swapNote(
  mem: MemoryState | null,
  target: { name: string; sizeGb: number } | null,
  resident: ResidentModel[],
): string | null {
  if (!mem || !target?.sizeGb || resident.length === 0 || resident.some((m) => same(m.name, target.name))) return null;
  if (mem.reclaimableGb + resident.reduce((n, m) => n + m.sizeGb, 0) < target.sizeGb + 0.5) return null;
  const holder = resident.map((m) => `${m.name} (${m.sizeGb.toFixed(1)} GB)`).join(', ');
  return `Ollama has ${holder} resident, so ${target.name} must be swapped in before it can answer — ` +
    'the first ping after a swap is slow; this is model swapping, not a memory shortage. Re-run doctor, or unload the resident model';
}

/** The doctor's memory line: the plain memory warning, or the swap note where that is the truth. */
export function doctorMemoryNote(
  mem: MemoryState | null,
  target: { name: string; sizeGb: number } | null,
  resident: ResidentModel[],
): string | null {
  const warning = memoryWarning(mem, target?.sizeGb || undefined);
  return warning && (swapNote(mem, target, resident) ?? warning);
}

/** A local ping's stall error names a memory shortage (models.ts); where the doctor sees a swap, it says that instead. */
export function pingError(message: string, swap: string | null): string {
  const cut = message.indexOf(' — the machine is short of memory');
  return swap && cut >= 0 ? `${message.slice(0, cut)} — ${swap}` : message;
}
