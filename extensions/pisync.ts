import { getAgentDir, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { createSync } from '../sync-core.mjs';
import { buildDiffFiles, redact } from '../diff-view.mjs';
import { runSync, runLocal, runIgnore } from '../commands.mjs';
import { runPackages } from '../packages.mjs';
import { createDiffScreen } from './diff-screen.js';

// Pi owns keyboard navigation, focus, rendering, and cancellation; keep the
// extension-side adapter limited to mapping the selected unique label to a value.
export async function selectChoice<T>(select: (title: string, labels: string[]) => Promise<string | undefined>, title: string, choices: readonly { label: string; value: T }[]): Promise<T | undefined> {
  if (choices.length === 0) return undefined;
  const labels = choices.map(({ label }) => String(label)
    .replace(/[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim());
  if (labels.some(label => !label)) throw new Error('Etichetta vuota nel menu.');
  if (new Set(labels).size !== labels.length) throw new Error('Etichette duplicate nel menu.');
  const selected = await select(String(title), labels);
  if (selected === undefined) return undefined;
  const index = labels.indexOf(selected);
  return index < 0 ? undefined : choices[index].value;
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand('sync', {
    description: 'Push e pull con confronto, conflitti per impostazione ed eccezioni locali guidate',
    handler: async (args, ctx) => {
      let [command, ...rest] = args.trim().split(/\s+/);
      if (!command) {
        if (!ctx.hasUI || ctx.mode !== 'tui') {
          ctx.ui.notify('Il menu /sync richiede la UI interattiva di Pi.', 'warning');
          return;
        }
        try {
          const selectedCommand = await selectChoice((title, labels) => ctx.ui.select(title, labels), 'Sync · scegli operazione', [
            { label: 'Push · invia le modifiche a GitHub', value: 'push' },
            { label: 'Pull · ricevi le modifiche da GitHub', value: 'pull' },
            { label: 'Eccezioni locali · configura questo PC', value: 'local' },
            { label: 'Pacchetti · gestisci installazioni', value: 'packages' },
            { label: 'Stato · mostra modifiche locali', value: 'status' },
            { label: 'Cronologia · ultimi commit', value: 'log' },
            { label: 'Esclusioni file · mostra o modifica', value: 'ignore' },
          ]);
          if (!selectedCommand) return;
          command = selectedCommand;
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error');
          return;
        }
      }
      const dir = getAgentDir(), sync = createSync(dir);
      const ui = {
        packages: () => runPackages(dir, ui),
        notify: (message: string) => ctx.ui.notify(message, 'info'),
        input: (title: string) => ctx.ui.input(title),
        async choose(title: string, choices: { label: string; value: any }[]) {
          return selectChoice((menuTitle, labels) => ctx.ui.select(menuTitle, labels), title, choices);
        },
        async review(plan: any) {
          const files = buildDiffFiles(plan);
          return ctx.ui.custom<boolean>((tui, theme, keybindings, done) => createDiffScreen(tui, theme, keybindings, done, files, plan.direction, { heading: plan.heading, notes: (plan.notes || []).map((s: string) => redact(s)) }));
        },
        async conflict(view: any) {
          const files = buildDiffFiles(view);
          const proceed = await ctx.ui.custom<boolean>((tui, theme, keybindings, done) => createDiffScreen(tui, theme, keybindings, done, files, view.direction, { heading: view.heading, notes: view.notes, footer: 'Invio: scegli quale tenere     Esc: annulla tutto' }));
          if (!proceed) return undefined;
          return ui.choose('Quale scelta vuoi tenere?', [
            { label: 'Tieni la scelta di questo PC', value: 'local' },
            { label: 'Usa la scelta di GitHub', value: 'remote' },
            { label: 'Annulla senza modificare file', value: undefined },
          ]);
        },
      };
      try {
        if (['diff', 'preview', 'dry-run'].includes(command)) throw new Error('Usa /sync push o /sync pull: il confronto è già incluso, prima della conferma.');
        if (['push', 'upload', 'pull', 'download', 'local', 'packages'].includes(command)) {
          if (!ctx.hasUI || ctx.mode !== 'tui') throw new Error('Serve la UI interattiva di Pi per esaminare e confermare il confronto.');
          if (command === 'packages') await runPackages(dir, ui);
          else if (command === 'local') await runLocal(sync, rest, ui);
          else await runSync(sync, command === 'push' || command === 'upload' ? 'push' : 'pull', ui);
          return;
        }
        if (command === 'setup') {
          const url = rest.join(' ');
          if (!/^(https:\/\/|git@)/.test(url)) throw new Error('Uso: /sync setup https://github.com/utente/repo.git');
          if (!existsSync(join(dir, '.git'))) sync.git(['init', '-b', 'main']);
          let configured = false;
          try { sync.git(['remote', 'get-url', 'origin']); configured = true; } catch { /* new repository */ }
          sync.git(['remote', configured ? 'set-url' : 'add', 'origin', url]);
          ctx.ui.notify('Remote configurato. Usa /sync push oppure /sync pull per confrontare e confermare.', 'info');
        } else if (command === 'remote') {
          if (rest.length) throw new Error('Per cambiare remote usa /sync setup <url>.');
          ctx.ui.notify(sync.text(['remote', 'get-url', 'origin']).replace(/\/\/[^/@\s]+@/g, '//[nascosto]@'), 'info');
        } else if (['status', 'st'].includes(command)) {
          ctx.ui.notify(sync.text(['status', '--short', '--branch']) || 'Nessuna modifica locale.', 'info');
        } else if (['log', 'history'].includes(command)) {
          ctx.ui.notify(sync.text(['log', '-20', '--oneline']), 'info');
        } else if (command === 'ignore') {
          if (!ctx.hasUI || ctx.mode !== 'tui') throw new Error('Serve la UI interattiva di Pi per gestire le esclusioni.');
          await runIgnore(sync, rest, ui);
        } else {
          ctx.ui.notify('/sync push | pull | packages | status | log\n/sync setup <url> | remote\n/sync local → menu guidato delle eccezioni\n/sync ignore [add|remove|list] [pattern]\nNessun rebase o scarto automatico. Solo i veri conflitti richiedono una scelta.', 'info');
        }
      } catch (error) {
        ctx.ui.notify(error instanceof Error && !('stderr' in error) ? error.message : 'Operazione Git fallita. Nessuno scarto automatico. Controlla connessione, permessi e stato Git.', 'error');
      }
    },
  });
}
