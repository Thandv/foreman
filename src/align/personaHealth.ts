import { loadPersonas, personaServerUrl, type Persona } from './personas.ts';
import { personaServerPid, servePersona } from './personaServe.ts';

/**
 * Who owns an adopted persona's `mlx_lm.server`.
 *
 * Adoption changes *routing*: the moment a persona is adopted, `modelForTask`
 * hands it live tickets. Before this module, whether anything was listening on
 * the other end was a separate manual step (`foreman persona serve`), so the
 * normal failure was a ticket dying on a connection refused halfway through a
 * run, after a worktree had been cut and a worker had spent turns.
 *
 * Two jobs, in order of importance:
 *
 *   1. **Refuse rather than fall back.** The local-only policy: a dead persona server
 *      refuses the ticket — it never quietly serves it from the unadapted base.
 *      The whole point of adopting a persona is that the base was not good
 *      enough, so silently substituting it produces work that looks fine and
 *      is not.
 *   2. **Start what should be running**, at daemon boot, so the operator does
 *      not have to remember.
 */

/** Adopted personas, i.e. the ones something can actually route to. */
export function adoptedPersonas(): Persona[] {
  try {
    return loadPersonas().personas.filter((p) => p.status === 'adopted' && p.alias);
  } catch {
    return []; // a broken personas directory must not take down the daemon
  }
}

/** The adopted persona an alias belongs to, or null if the alias is not one. */
export function personaForAlias(alias: string): Persona | null {
  return adoptedPersonas().find((p) => p.alias === alias) ?? null;
}

export class PersonaUnavailable extends Error {}

/**
 * Is this persona's server actually answering?
 *
 * A live pid is necessary but not sufficient — mlx_lm can be up and still
 * loading a model — so this asks the endpoint, with a short timeout. The pid
 * check runs first only because it is free and rules out the common case.
 */
export async function personaReachable(persona: Persona, timeoutMs = 3_000): Promise<boolean> {
  if (personaServerPid(persona.id) === null) return false;
  try {
    const res = await fetch(`${personaServerUrl(persona.id)}/models`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Preflight for one alias, called before a run commits to it.
 *
 * An alias that is not an adopted persona passes straight through: ollama
 * aliases have their own availability story and are not this module's business.
 *
 * The refusal names the fix, because the fix is one command and the operator
 * will otherwise be reading a connection-refused stack trace to find it.
 */
export async function assertPersonaReachable(alias: string): Promise<void> {
  const persona = personaForAlias(alias);
  if (!persona) return;
  if (await personaReachable(persona)) return;
  throw new PersonaUnavailable(
    `persona '${persona.id}' is adopted and routed here, but nothing is serving it on ` +
    `${personaServerUrl(persona.id)}. Start it with \`foreman persona serve ${persona.id}\`. ` +
    `Refusing rather than falling back to the unadapted base ${persona.base} — the base is ` +
    `precisely the model this persona beat at its adoption gate.`,
  );
}

export interface PersonaStartReport {
  id: string;
  ok: boolean;
  reason: string;
}

/**
 * Bring up every adopted persona that is not already answering. Best-effort by
 * design: a persona that will not start is reported and left alone, because
 * the daemon's job is to run the queue and a failed model server is a reason
 * to refuse *those* tickets, not to refuse to boot.
 *
 * Started sequentially. On a 17 GB machine two mlx servers loading at once is
 * how you get 30 GB of swap, and the tickets they serve are queued behind a
 * worker pool anyway.
 */
export async function startAdoptedPersonas(
  opts: { startTimeoutMs?: number } = {},
): Promise<PersonaStartReport[]> {
  const out: PersonaStartReport[] = [];
  for (const persona of adoptedPersonas()) {
    if (await personaReachable(persona)) {
      out.push({ id: persona.id, ok: true, reason: 'already serving' });
      continue;
    }
    try {
      const res = await servePersona(persona, opts);
      out.push({ id: persona.id, ok: res.ok, reason: res.reason });
    } catch (err) {
      out.push({ id: persona.id, ok: false, reason: (err as Error).message });
    }
  }
  return out;
}
