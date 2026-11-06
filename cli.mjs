#!/usr/bin/env node
import { createSync } from './sync-core.mjs';
import { runPackages } from './packages.mjs';
import { runSync, runLocal, runIgnore, terminalUI, localUsage } from './commands.mjs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';

export async function runCli(argv, { dir, ui } = {}) {
  const configured = process.env.PI_CODING_AGENT_DIR;
  const root = dir || (configured ? resolve(configured.startsWith('~/') ? join(homedir(), configured.slice(2)) : configured) : join(homedir(), '.pi', 'agent'));
  const sync = createSync(root), [command = 'help', ...args] = argv;
  ui ||= terminalUI(async question => {
    if (!process.stdin.isTTY) throw new Error('Serve un terminale interattivo: nessuna conferma automatica.');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try { return await rl.question(question); } finally { rl.close(); }
  }, message => console.log(message));
  // Keep retry hooks scoped to this invocation/root, not a caller's shared UI.
  ui = { ...ui };
  ui.packages ||= () => runPackages(root, ui);
  if (command === 'packages') return runPackages(root, ui);
  if (['diff', 'preview', 'dry-run'].includes(command)) throw new Error('Usa push o pull: il confronto è già incluso, prima della conferma.');
  if (['push', 'pull', 'upload', 'download'].includes(command)) return runSync(sync, command === 'push' || command === 'upload' ? 'push' : 'pull', ui);
  if (command === 'local') return runLocal(sync, args, ui);
  if (command === 'ignore') return runIgnore(sync, args, ui);
  if (command === 'setup') {
    const url = args[0];
    if (!url || !/^(https:\/\/|git@)/.test(url)) throw new Error('Uso: setup https://github.com/utente/repo.git');
    if (!existsSync(join(root, '.git'))) sync.git(['init', '-b', 'main']);
    let configured = false;
    try { sync.git(['remote', 'get-url', 'origin']); configured = true; } catch { /* first setup */ }
    sync.git(['remote', configured ? 'set-url' : 'add', 'origin', url]); ui.notify('Remote configurato.');
  } else if (['status', 'st'].includes(command)) ui.notify(sync.text(['status', '--short', '--branch']));
  else if (['log', 'history'].includes(command)) ui.notify(sync.text(['log', '-20', '--oneline']));
  else if (command === 'remote') {
    if (args.length) throw new Error('Per cambiare remote usa setup <url>.');
    ui.notify(sync.text(['remote', 'get-url', 'origin']).replace(/\/\/[^/@\s]+@/g, '//[nascosto]@'));
  } else ui.notify('node cli.mjs push | pull | packages | status | log | setup <url> | remote | ignore [list|add|remove] [pattern]\n' + localUsage);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await runCli(process.argv.slice(2)); }
  catch (error) {
    console.error(error instanceof Error && !('stderr' in error) ? error.message : 'Operazione Git fallita: controlla connessione, permessi e stato Git.');
    process.exitCode = 1;
  }
}
