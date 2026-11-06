import { redact, conflictView, formatDiff } from './diff-view.mjs';

export async function runSync(sync, direction, ui) {
  let plan = sync.prepare(direction);
  while (plan.conflicts.length) {
    const conflict = plan.conflicts[0];
    const choice = await ui.conflict(conflictView(conflict), conflict);
    if (!['local', 'remote'].includes(choice)) return false;
    plan = sync.resolve(plan, { [conflict.id]: choice });
  }
  if (!plan.changes.length && plan.head === plan.remote) {
    ui.notify(['Nessuna differenza.', ...(plan.notes || [])].join('\n'));
    if (direction === 'pull') await ui.packages?.();
    return false;
  }
  if (!await ui.review(plan)) return false;
  const backup = sync.apply(plan);
  ui.notify(`Operazione completata. Backup locale: ${backup}`);
  if (direction === 'pull' && ui.packages) await ui.packages();
  else ui.notify('Esegui /reload se sono cambiate risorse o impostazioni.');
  return true;
}

const actions = [
  ['Mostra eccezioni', 'show'], ['Forza un’impostazione solo qui', 'set'],
  ['Rimuovi un’impostazione locale', 'unset'], ['Escludi un provider', 'exclude-provider'],
  ['Riabilita un provider', 'include-provider'], ['Disattiva un pacchetto solo qui', 'exclude-package'],
  ['Riabilita un pacchetto', 'include-package'], ['Imposta il modello/provider di riserva', 'fallback'],
  ['Applica il file modificato a mano', 'apply'], ['Annulla', 'cancel'],
].map(([label, value]) => ({ label, value }));
export const localUsage = 'local [show | set <impostazione> <valore JSON> | unset <impostazione> | exclude-provider <nome> | include-provider <nome> | exclude-package <source> | include-package <source> | fallback <defaultProvider|defaultModel> <valore> | apply]';

export async function runLocal(sync, args, ui) {
  let [action, key, ...rest] = args;
  let value;
  const rules = sync.localRules();
  if (!action) {
    action = await ui.choose('Eccezioni di questo PC — non condivise su GitHub', actions);
    if (!action || action === 'cancel') return false;
    if (action === 'unset' || action.startsWith('include-')) {
      const candidates = action === 'unset' ? Object.keys(rules.overrides || {}) : rules[action === 'include-provider' ? 'excludedProviders' : 'excludedPackages'] || [];
      if (!candidates.length) { ui.notify('Nessuna eccezione di questo tipo.'); return false; }
      key = await ui.choose('Quale eccezione vuoi togliere?', candidates.map(value => ({ label: value, value })));
    } else if (action === 'fallback') {
      key = await ui.choose('Quale valore di riserva?', ['defaultProvider', 'defaultModel'].map(value => ({ label: value, value })));
    } else if (!['show', 'apply'].includes(action)) {
      key = await ui.input(action === 'set' ? 'Impostazione (es. hideThinkingBlock oppure compaction.enabled)' : action.endsWith('provider') ? 'Nome del provider (es. deepseek)' : 'Sorgente del pacchetto (es. git:github.com/utente/repo)');
    }
    if (!['show', 'apply'].includes(action) && !key) return false;
    if (action === 'set' || action === 'fallback') {
      const entered = await ui.input(action === 'set' ? 'Valore JSON (es. false, 42, "dark")' : 'Valore di riserva (es. openai-codex)');
      if (entered === undefined) return false;
      rest = [entered];
    }
  }
  if (action === 'show') { ui.notify(JSON.stringify(redact(rules), null, 2)); return false; }
  if (action === 'set') {
    try { value = JSON.parse(rest.join(' ')); }
    catch { throw new Error('Valore JSON non valido. Usa per esempio false, 42 oppure "dark".'); }
  } else if (action === 'fallback') value = rest.join(' ');
  if (!['set', 'unset', 'exclude-provider', 'include-provider', 'exclude-package', 'include-package', 'fallback', 'apply'].includes(action)) throw new Error(localUsage);
  const plan = sync.prepareLocal(action, key, value);
  if (!await ui.review(plan)) return false;
  const backup = sync.apply(plan);
  ui.notify(`Eccezioni locali aggiornate; nulla inviato a GitHub. Esegui /reload. Backup: ${backup}`);
  return true;
}

export async function runIgnore(sync, args, ui) {
  const [action = 'list', ...rest] = args;
  if (action === 'list') { ui.notify(sync.ignorePatterns() || 'Nessuna esclusione per file.'); return false; }
  const plan = sync.prepareIgnore(action, rest.join(' '));
  if (!await ui.review(plan)) return false;
  const backup = sync.apply(plan);
  ui.notify(`Esclusioni per file aggiornate solo qui. Backup: ${backup}`); return true;
}

// The CLI uses the same flows as the Pi extension; cancellation and confirmation
// live here rather than in two subtly different implementations.
export function terminalUI(ask, write) {
  const output = message => write(String(message).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ''));
  return {
    notify: output,
    input: title => ask(`${title} (vuoto per annullare): `).then(answer => answer === '' ? undefined : answer),
    async choose(title, choices) {
      output(title + '\n' + choices.map((c, i) => `${i + 1}. ${c.label}`).join('\n'));
      const answer = await ask('Numero (vuoto per annullare): ');
      if (!/^\d+$/.test(answer)) return undefined;
      return choices[Number(answer) - 1]?.value;
    },
    async review(plan) {
      output(formatDiff(plan));
      return ['s', 'si', 'y', 'yes'].includes((await ask('Applicare esattamente queste modifiche? [s/N] ')).trim().toLowerCase());
    },
    async conflict(view) {
      output(formatDiff(view));
      return this.choose('Stessa scelta cambiata in due modi: quale tenere?', [
        { label: 'Tieni la scelta di questo PC', value: 'local' },
        { label: 'Usa la scelta di GitHub', value: 'remote' },
        { label: 'Annulla senza modificare file', value: undefined },
      ]);
    },
  };
}
