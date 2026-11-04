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
 * The doctor's memory line. When Ollama (/api/ps) holds a model other than the
 * one being judged, the slowness is Ollama swapping models, not a shortage:
 * say which model holds the memory and that the other must be swapped in.
 * Otherwise it is the plain memory warning.
 */
export function doctorMemoryNote(
  mem: MemoryState | null,
  target: { name: string; sizeGb: number } | null,
  resident: ResidentModel[],
): string | null {
  const warning = memoryWarning(mem, target?.sizeGb || undefined);
  if (!warning || !target) return warning;
  const other = resident.filter((m) => !same(m.name, target.name));
  if (other.length === 0 || resident.some((m) => same(m.name, target.name))) return warning;
  const holder = other.map((m) => `${m.name} (${m.sizeGb.toFixed(1)} GB)`).join(', ');
  return `Ollama has ${holder} resident, so ${target.name} must be swapped in before it can answer — ` +
    'the first ping after a swap is slow; this is model swapping, not a memory shortage. Re-run doctor, or unload the resident model';
}
