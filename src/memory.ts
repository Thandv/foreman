import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface MemoryState {
  /** Free + inactive + speculative pages: what a model load can take without paging anything out. */
  reclaimableGb: number;
  swapUsedGb: number;
  swapTotalGb: number;
}

/**
 * Parse `vm_stat` and `sysctl vm.swapusage` output. Pure, so it is testable
 * without a Mac in a particular state.
 */
export function parseMemory(vmStat: string, swapUsage: string): MemoryState | null {
  const pageSize = Number(/page size of (\d+) bytes/.exec(vmStat)?.[1] ?? 16384);
  const pages = (label: string): number => Number(new RegExp(`${label}:\\s+(\\d+)`).exec(vmStat)?.[1] ?? NaN);
  const reclaimable = pages('Pages free') + pages('Pages inactive') + pages('Pages speculative');
  const mb = (label: string): number => Number(new RegExp(`${label} = ([\\d.]+)M`).exec(swapUsage)?.[1] ?? NaN);
  const used = mb('used');
  const total = mb('total');
  if (!Number.isFinite(reclaimable) || !Number.isFinite(used) || !Number.isFinite(total)) return null;
  return {
    reclaimableGb: (reclaimable * pageSize) / 1e9,
    swapUsedGb: used / 1024,
    swapTotalGb: total / 1024,
  };
}

/** Current memory state on macOS; null anywhere else, or if the tools are missing. */
export async function readMemory(): Promise<MemoryState | null> {
  if (process.platform !== 'darwin') return null;
  try {
    const [vm, swap] = await Promise.all([
      execFileAsync('vm_stat', [], { timeout: 5_000 }),
      execFileAsync('sysctl', ['vm.swapusage'], { timeout: 5_000 }),
    ]);
    return parseMemory(vm.stdout, swap.stdout);
  } catch {
    return null;
  }
}

/** Bytes→GB of an Ollama model on disk, which is close to what it needs resident. Null if unknown. */
export async function modelSizeGb(model: string): Promise<number | null> {
  const base = process.env['FOREMAN_OLLAMA_URL'] ?? 'http://127.0.0.1:11434';
  try {
    const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(3_000) });
    const body = (await res.json()) as { models?: Array<{ name?: string; size?: number }> };
    const hit = body.models?.find((m) => m.name === model);
    return hit?.size ? hit.size / 1e9 : null;
  } catch {
    return null;
  }
}

/**
 * A one-line warning when the machine cannot host a model of `needGb`, else null.
 *
 * The failure this names is otherwise unfalsifiable from inside Foreman: on a
 * 17 GB machine with a browser and a game resident, a 9 GB model load pages
 * everything out, the first token never arrives, and the only symptom is an
 * idle timeout that looks exactly like a hung Ollama.
 *
 * Compared against the model's own size, not a fixed line: 6 GB reclaimable is
 * plenty for the 2B and not enough for the 14B. The swap RATIO is not used —
 * macOS grows swapfiles on demand, so used/total sits above 80% on a healthy
 * machine — and neither is the kernel's pressure level, which read "normal"
 * here at 0.8 GB reclaimable while a 14B could not produce one token in
 * fifteen minutes.
 */
export function memoryWarning(m: MemoryState | null, needGb = 1.5): string | null {
  if (!m) return null;
  const want = needGb + 0.5;
  if (m.reclaimableGb >= want) return null;
  return `the machine is short of memory (${m.reclaimableGb.toFixed(1)} GB reclaimable for a model needing ` +
    `~${needGb.toFixed(1)} GB; ${m.swapUsedGb.toFixed(1)}/${m.swapTotalGb.toFixed(1)} GB swap in use) — it will page ` +
    'instead of answering; close memory-heavy apps or pick a smaller model';
}

// ------------------------------------------------------------------ capacity

/** Models Ollama holds resident, with what each occupies. */
export async function residentModels(): Promise<Array<{ name: string; sizeGb: number; contextLength: number | null }>> {
  const base = process.env['FOREMAN_OLLAMA_URL'] ?? 'http://127.0.0.1:11434';
  const res = await fetch(`${base}/api/ps`, { signal: AbortSignal.timeout(3_000) });
  if (!res.ok) throw new Error(`ollama ps: ${res.status}`);
  const body = (await res.json()) as { models?: Array<{ name?: string; size?: number; context_length?: number }> };
  return (body.models ?? []).map((m) => ({
    name: String(m.name ?? ''),
    sizeGb: Number(m.size ?? 0) / 1e9,
    contextLength: Number.isFinite(m.context_length) ? Number(m.context_length) : null,
  }));
}

/**
 * Memory a model load may use beyond what is reclaimable outright.
 *
 * macOS compresses and swaps other processes to make room, so "reclaimable"
 * alone undercounts what a load can take — on this machine, at 0.8 GB
 * reclaimable, the 9B (6.6 GB) still answered in 8 s while the coder-14B
 * (9 GB, at an 8k window) could not produce a first token in fifteen minutes.
 * The default sits between those two measurements. It is a calibration from
 * two observations, not a law: an operator who sees the wrong model chosen
 * moves it with FOREMAN_PAGING_ALLOWANCE_GB.
 */
export function pagingAllowanceGb(): number {
  const raw = Number(process.env['FOREMAN_PAGING_ALLOWANCE_GB']);
  return Number.isFinite(raw) && raw >= 0 ? raw : 7;
}

/** What a load of this model at this window needs: weights plus a rough KV cache. */
export function loadNeedGb(sizeGb: number, numCtx: number | undefined): number {
  return sizeGb + 0.5 * ((numCtx ?? 4096) / 8192);
}

const SIZE_TTL_MS = 5 * 60_000;
const MEMORY_TTL_MS = 5_000;
let sizeCache: { at: number; ok: boolean; sizes: Map<string, number> } | null = null;
let memoryCache: { at: number; state: MemoryState | null } | null = null;

async function cachedSize(model: string): Promise<number | null> {
  if (!sizeCache || Date.now() - sizeCache.at > SIZE_TTL_MS) {
    const base = process.env['FOREMAN_OLLAMA_URL'] ?? 'http://127.0.0.1:11434';
    const sizes = new Map<string, number>();
    let ok = false;
    try {
      const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(3_000) });
      const body = (await res.json()) as { models?: Array<{ name?: string; size?: number }> };
      for (const m of body.models ?? []) if (m.name && m.size) sizes.set(m.name, m.size / 1e9);
      ok = res.ok;
    } catch {
      /* an empty map: every size unknown, so nothing is judged too big */
    }
    sizeCache = { at: Date.now(), ok, sizes };
  }
  for (const [name, size] of sizeCache.sizes) if (sameModel(name, model)) return size;
  return null;
}

let memoryReader: () => Promise<MemoryState | null> = readMemory;
/** Test hook: read memory from somewhere other than this machine's vm_stat. */
export function setMemoryReader(reader: (() => Promise<MemoryState | null>) | null): void {
  memoryReader = reader ?? readMemory;
  memoryCache = null;
}

async function cachedMemory(): Promise<MemoryState | null> {
  if (!memoryCache || Date.now() - memoryCache.at > MEMORY_TTL_MS) {
    memoryCache = { at: Date.now(), state: await memoryReader() };
  }
  return memoryCache.state;
}

/**
 * Whether this model can be loaded now without paging the machine to a halt.
 *
 * Resident already: yes. Unknown size, or no way to read memory (not macOS):
 * yes — this only ever steps DOWN on evidence, never on a guess. Otherwise the
 * load's need is compared with what is reclaimable, plus every model Ollama
 * holds resident (busy ones included: the broker's residency guard waits for
 * them to drain before loading another, and the load evicts them then), plus
 * the paging allowance.
 */
export async function modelFits(model: string, numCtx: number | undefined): Promise<boolean> {
  let resident: Awaited<ReturnType<typeof residentModels>>;
  try {
    resident = await cachedResident();
  } catch {
    return true;
  }
  // Resident at a window at least this big: nothing to load. Resident at a
  // smaller one: Ollama reloads it for the new window, so it is judged like
  // any load (its own memory counts as evictable below).
  if (resident.some((m) => sameModel(m.name, model) && (m.contextLength === null || (numCtx ?? 4096) <= m.contextLength))) return true;
  const size = await cachedSize(model);
  const mem = await cachedMemory();
  if (size === null || mem === null) return true;
  const evictable = resident.reduce((n, m) => n + m.sizeGb, 0);
  return loadNeedGb(size, numCtx) <= mem.reclaimableGb + evictable + pagingAllowanceGb();
}

/**
 * Whether Ollama has this model pulled. False only on evidence — the tag list
 * was read and the model is not in it; an unreachable Ollama is "unknown",
 * which is true, so a transient error never removes a model from a chain.
 */
export async function modelInstalled(model: string): Promise<boolean> {
  await cachedSize(model);
  if (!sizeCache?.ok) return true;
  return [...sizeCache.sizes.keys()].some((name) => sameModel(name, model));
}

/** `llama3.1` and `llama3.1:latest` are one model. */
function sameModel(a: string, b: string): boolean {
  const norm = (n: string): string => (n.includes(':') ? n : `${n}:latest`);
  return norm(a) === norm(b);
}

let residentCache: { at: number; models: Awaited<ReturnType<typeof residentModels>> } | null = null;
async function cachedResident(): Promise<Awaited<ReturnType<typeof residentModels>>> {
  if (!residentCache || Date.now() - residentCache.at > 2_000) {
    residentCache = { at: Date.now(), models: await residentModels() };
  }
  return residentCache.models;
}

/** Test hook: forget cached sizes and memory readings. */
export function resetCapacityCache(): void {
  sizeCache = null;
  memoryCache = null;
  residentCache = null;
}
