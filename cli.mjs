#!/usr/bin/env node
import { createSync } from './sync-core.mjs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';

const dir = join(homedir(), '.pi', 'agent');
const sync = createSync(dir);
const [command = 'help', arg] = process.argv.slice(2);
try {
  if (['push', 'pull', 'upload', 'download', 'diff', 'preview', 'dry-run'].includes(command)) {
    const dry = ['diff', 'preview', 'dry-run'].includes(command);
    if (dry && arg && !['push', 'pull'].includes(arg)) throw new Error('Uso: diff [push|pull]');
    const direction = command === 'push' || command === 'upload' || (dry && arg === 'push') ? 'push' : 'pull';
    const plan = sync.prepare(direction);
    console.log(sync.preview(plan));
    if (!dry) {
      if (!process.stdin.isTTY) throw new Error('Serve un terminale interattivo: nessuna conferma automatica.');
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      let answer;
      try { answer = await rl.question('Applicare esattamente queste modifiche? [s/N] '); } finally { rl.close(); }
      if (['s', 'si', 'y', 'yes'].includes(answer.trim().toLowerCase())) console.log('Completato. Backup locale:', sync.apply(plan));
      else console.log('Annullato: nessun file modificato.');
    }
  } else if (command === 'setup') {
    if (!arg || !/^(https:\/\/|git@)/.test(arg)) throw new Error('Uso: node cli.mjs setup https://github.com/utente/repo.git');
    if (!existsSync(join(dir, '.git'))) sync.git(['init', '-b', 'main']);
    let configured = false;
    try { sync.git(['remote', 'get-url', 'origin']); configured = true; } catch { /* first setup */ }
    sync.git(['remote', configured ? 'set-url' : 'add', 'origin', arg]);
    console.log('Remote configurato.');
  } else if (['status', 'st'].includes(command)) console.log(sync.text(['status', '--short', '--branch']));
  else if (['log', 'history'].includes(command)) console.log(sync.text(['log', '-20', '--oneline']));
  else if (command === 'remote') {
    if (arg) throw new Error('Per cambiare remote usa setup <url>.');
    console.log(sync.text(['remote', 'get-url', 'origin']));
  } else console.log('node cli.mjs push | pull | diff [push|pull] | status | log | setup <url> | remote');
} catch (error) {
  console.error(error instanceof Error && !('stderr' in error) ? error.message : 'Operazione Git fallita: controlla connessione, permessi e stato Git.');
  process.exitCode = 1;
}
