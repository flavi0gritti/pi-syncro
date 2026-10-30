import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createSync } from '../sync-core.mjs';

const dir = join(homedir(), '.pi', 'agent');

export default function (pi: ExtensionAPI) {
  pi.registerCommand('sync', {
    description: 'Sincronizzazione sicura: push, pull, diff [push|pull], status, log, setup, remote, local, ignore',
    handler: async (args, ctx) => {
      const [command = 'help', ...rest] = args.trim().split(/\s+/);
      const sync = createSync(dir);
      try {
        if (['push', 'upload', 'pull', 'download', 'diff', 'preview', 'dry-run'].includes(command)) {
          const dry = ['diff', 'preview', 'dry-run'].includes(command);
          if (dry && rest.length && !['push', 'pull'].includes(rest[0])) throw new Error('Uso: /sync diff [push|pull]');
          const direction = command === 'push' || command === 'upload' || (dry && rest[0] === 'push') ? 'push' : 'pull';
          if (!ctx.hasUI) throw new Error('Serve una UI interattiva per esaminare e confermare il diff.');
          const plan = sync.prepare(direction);
          const report = sync.preview(plan);
          // editor is scrollable: do not hide a long diff inside a small confirmation dialog.
          const reviewed = await ctx.ui.editor(`Anteprima ${direction} — chiudi per continuare`, report);
          if (dry || reviewed === undefined) return;
          if (!(await ctx.ui.confirm(`Conferma ${direction}`, 'Applicare esattamente le modifiche dell’anteprima? Annulla non modifica i file.'))) return;
          const backup = sync.apply(plan);
          ctx.ui.notify(`✅ ${direction} completato. Backup locale: ${backup}\nSe hai scaricato risorse nuove, esegui /reload.`, 'info');
          return;
        }
        if (command === 'setup') {
          const url = rest.join(' ');
          if (!/^(https:\/\/|git@)/.test(url)) throw new Error('Uso: /sync setup https://github.com/utente/repo.git');
          if (!existsSync(join(dir, '.git'))) sync.git(['init', '-b', 'main']);
          let configured = false;
          try { sync.git(['remote', 'get-url', 'origin']); configured = true; } catch { /* new repository */ }
          sync.git(['remote', configured ? 'set-url' : 'add', 'origin', url]);
          ctx.ui.notify('Remote configurato. Controlla /sync diff push oppure /sync diff pull.', 'info');
        } else if (command === 'remote') {
          if (rest.length) throw new Error('Per cambiare remote usa /sync setup <url>.');
          ctx.ui.notify(sync.text(['remote', 'get-url', 'origin']), 'info');
        } else if (['status', 'st'].includes(command)) {
          ctx.ui.notify(sync.text(['status', '--short', '--branch']) || 'Nessuna modifica locale.', 'info');
        } else if (['log', 'history'].includes(command)) {
          ctx.ui.notify(sync.text(['log', '-20', '--oneline']), 'info');
        } else if (command === 'local') {
          const file = join(dir, 'settings.local.json');
          if (rest[0] === 'apply' || rest[0] === 'test') throw new Error('Il filtro locale viene applicato solo ai file in arrivo durante un pull confermato. Nessuna riscrittura automatica.');
          if (!existsSync(file)) writeFileSync(file, JSON.stringify({ excludedProviders: [], defaultProvider: '', defaultModel: '' }, null, 2) + '\n', { mode: 0o600 });
          ctx.ui.notify(`Preferenze locali: ${file}\nProvider esclusi: ${(sync.localRules().excludedProviders || []).join(', ') || 'nessuno'}`, 'info');
        } else if (command === 'ignore') {
          const file = join(dir, '.syncignore');
          const patterns = existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean) : [];
          const pattern = rest.slice(1).join(' ');
          if (['add', 'remove'].includes(rest[0])) {
            if (!pattern || pattern.startsWith('#')) throw new Error('Specifica un pattern valido.');
            const next = rest[0] === 'add' ? [...new Set([...patterns, pattern])] : patterns.filter(p => p !== pattern);
            writeFileSync(file, next.join('\n') + '\n', { mode: 0o600 });
          }
          ctx.ui.notify(existsSync(file) ? readFileSync(file, 'utf8') : 'Nessuna esclusione.', 'info');
        } else {
          ctx.ui.notify('/sync push | pull | diff [push|pull] | status | log\n/sync setup <url> | remote\n/sync local | ignore [add|remove|list] [pattern]\nNessun rebase automatico. I conflitti bloccano l’operazione senza scartare file.', 'info');
        }
      } catch (error) {
        // Do not echo Git stderr: remote URLs or credentials may appear there.
        ctx.ui.notify(error instanceof Error && !('stderr' in error) ? error.message : 'Operazione Git fallita. Nessuno scarto automatico. Controlla connessione, permessi e stato Git.', 'error');
      }
    },
  });
}
