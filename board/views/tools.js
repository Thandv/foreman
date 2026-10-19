/**
 * views/tools.js — the toolbox workers built for themselves.
 *
 * Every row here is code the daemon will run again, unattended, on a future
 * task. So the two numbers that matter are on the table itself (how often it
 * has been called, how often it failed), and the primary action is not delete
 * but quarantine: keeping a tool while stopping agents from reaching it is the
 * reversible move, and reversible moves belong in front of destructive ones.
 */
import { add, api, el, emptyState, post } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { tip } from '../lib/tooltip.js';
import { button, chip, expandable, loadInto, section, table, viewHead } from '../lib/view.js';

export const meta = {
  id: 'tools',
  title: 'Tools',
  icon: 'tools',
  desc: 'The toolbox workers built for themselves — every reusable script, and whether it is trusted to run.',
};

const COLUMNS = [
  { label: 'name', desc: 'The name a worker calls this tool by. It is also the directory it lives in.' },
  { label: 'description', desc: 'What the tool claims to do, from its own manifest. This is the text the planner matches an ask against when it looks for a tool to reuse.' },
  { label: 'runtime', desc: 'What executes the entry file — node or python.' },
  { label: 'uses', desc: 'How many times a task has called this tool.', cls: 'num' },
  { label: 'failures', desc: 'How many of those calls ended in an error. A tool that fails repeatedly is quarantined automatically.', cls: 'num' },
  { label: 'state', desc: 'Live means agents may call it. Quarantined means it stays in the catalog but no worker can reach it.' },
  { label: '', cls: 'act' },
];

export function mount(root) {
  root.className = 'view';

  const list = section('Registered tools', 'Everything in the catalog, with the usage record that tells you whether to trust it.');
  add(root, viewHead(meta.title, meta.desc), list.node);

  const refresh = () => loadInto(list.body, () => api('/api/tools'), (data) => {
    const wrap = el('div', 'stack');
    if (!data.tools.length) {
      wrap.appendChild(emptyState(
        'No tools yet',
        'Workers register a tool when they build something worth reusing — a script that solved a problem cleanly enough to keep. Queue a task of kind "tool" to get the first one.',
        { icon: icon('tools') },
      ));
      const dir = el('div', 'faint mono', data.dir);
      tip(dir, 'Toolbox directory', 'Where registered tools live on disk. It is a git-tracked folder, so the catalog can be reviewed and versioned like any other code.');
      wrap.appendChild(dir);
      return wrap;
    }

    const rows = data.tools.map((tool) => {
      const quarantined = Boolean(tool.quarantined);
      const actions = el('div', 'row');
      actions.appendChild(quarantined
        ? button({
          label: 'Release',
          icon: 'check',
          variant: 'sm',
          desc: 'Let agents call this tool again. Its usage record is kept, not reset.',
          run: async () => { await post(`/api/tools/${tool.name}/release`); await refresh(); },
          ok: `Released "${tool.name}"`,
        })
        : button({
          label: 'Quarantine',
          icon: 'ban',
          variant: 'sm',
          desc: 'Keep the tool but stop agents using it. Reversible, and the record of what it did is preserved.',
          run: async () => { await post(`/api/tools/${tool.name}/quarantine`); await refresh(); },
          ok: `Quarantined "${tool.name}"`,
        }));
      actions.appendChild(button({
        label: 'Remove',
        icon: 'trash',
        variant: 'sm danger',
        desc: 'Delete the tool and its source from the catalog for good. There is no undo — quarantine instead if you may want it back.',
        run: async () => {
          await api(`/api/tools/${tool.name}`, { method: 'DELETE' });
          await refresh();
        },
        ok: `Removed "${tool.name}"`,
      }));

      const state = quarantined
        ? chip('quarantined', 'bad', 'Quarantined', tool.quarantineReason || 'No worker can call this tool. It stays in the catalog and can be released again.')
        : chip('live', 'ok', 'Live', 'Agents may call this tool as part of a task.');

      return [
        tool.name,
        expandable(tool.description, 90),
        tool.runtime,
        String(tool.stats?.calls ?? 0),
        String(tool.stats?.failures ?? 0),
        state,
        actions,
      ];
    });

    wrap.appendChild(table(COLUMNS, rows));
    const dir = el('div', 'faint mono', data.dir);
    tip(dir, 'Toolbox directory', 'Where registered tools live on disk. It is a git-tracked folder, so the catalog can be reviewed and versioned like any other code.');
    wrap.appendChild(dir);
    return wrap;
  });

  void refresh();
  return undefined;
}
