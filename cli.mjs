#!/usr/bin/env node
/**
 * pi-syncro CLI — Sync della configurazione pi (~/.pi/agent) con GitHub.
 * Funziona su macOS, Linux e Windows (con Node.js e git).
 *
 * Uso:
 *   pisync push             Salva le modifiche locali su GitHub
 *   pisync pull             Scarica da GitHub (con anteprima e conferma)
 *   pisync diff             Anteprima: cosa cambierebbe col pull
 *   pisync status           Stato attuale
 *   pisync log              Storico sync
 *   pisync setup <url>      Collega al repo GitHub
 *   pisync remote [url]     Mostra/imposta il remote
 */

import { execSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { argv, exit, stderr, stdin, stdout } from 'node:process';

// ─── Config ──────────────────────────────────────────────────────────────────

const PI_DIR = join(homedir(), '.pi', 'agent');
const BRANCH = 'main';
const LABEL = '\x1b[36m[pi-sync]\x1b[0m';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const colors = { red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', reset: '\x1b[0m', dim: '\x1b[2m' };

function log(msg)   { stdout.write(`${LABEL} ${msg}\n`); }
function ok(msg)    { stdout.write(`${LABEL} ${colors.green}${msg}${colors.reset}\n`); }
function warn(msg)  { stderr.write(`${LABEL} ⚠️  ${msg}\n`); }
function die(msg)   { stderr.write(`${LABEL} ❌ ${msg}\n`); exit(1); }

function git(args, opts = {}) {
  try {
    const result = execSync(`git ${args}`, { cwd: PI_DIR, encoding: 'utf-8', stdio: opts.pipe ? 'inherit' : 'pipe', ...opts });
    return (result || '').trim();
  } catch (err) {
    if (opts.ignoreError) return '';
    throw err;
  }
}

function ensureRepo()   { if (!existsSync(join(PI_DIR, '.git'))) die('Repo git non trovato. "pisync setup <url>" prima.'); }
function hasRemote()    { return git('remote get-url origin', { ignoreError: true }).length > 0; }
function ensureRemote() { if (!hasRemote()) die('Nessun remote. "pisync setup <url>".'); }
function hasChanges()   { return git('status --porcelain', { ignoreError: true }).length > 0; }
function hasLocalCommits() { return git('rev-parse HEAD', { ignoreError: true }).length > 0; }

async function confirm(question) {
  if (!stdin.isTTY) return false;
  const rl = createInterface({ input: stdin, output: stderr });
  return new Promise(resolve => {
    rl.question(`${LABEL} ${question} [s/N] `, (ans) => {
      rl.close();
      resolve(ans.toLowerCase() === 's' || ans.toLowerCase() === 'si' || ans.toLowerCase() === 'y' || ans.toLowerCase() === 'yes');
    });
  });
}

const IS_WINDOWS = platform() === 'win32';

// ─── Comandi ─────────────────────────────────────────────────────────────────

function cmdSetup(repoUrl) {
  if (!repoUrl) die('Uso: pisync setup <url>\nEsempio: pisync setup https://github.com/user/pi-config.git');

  if (!existsSync(PI_DIR)) die(`Directory ${PI_DIR} non trovata. Installa pi prima.`);

  if (existsSync(join(PI_DIR, '.git'))) {
    log('Repo git già esistente, riconfiguro il remote...');
    try { git('remote remove origin', { ignoreError: true }); } catch {}
    git(`remote add origin ${repoUrl}`);
    git('fetch origin');
    log('Remote configurato.');
    log('Ora: pisync pull (per scaricare) o pisync push (per caricare).');
    return;
  }

  log(`Inizializzo repo in ${PI_DIR}...`);
  git('init -b main');

  const giPath = join(PI_DIR, '.gitignore');
  if (!existsSync(giPath)) {
    writeFileSync(giPath, `# secrets\nauth.json\n# sessions\nsessions/\n# rigenerabili\ngit/\nnpm/\n# temporanei\nbin/\nbackups/\ntmp/\n# OS\n.DS_Store\n**/.DS_Store\nThumbs.db\n# interno\n.sync-pending\n`);
    log('.gitignore creato.');
  }

  git(`remote add origin ${repoUrl}`);
  git('fetch origin --quiet');
  ok('Setup completato. Ora pisync push o pisync pull.');
}

async function cmdPush() {
  ensureRepo(); ensureRemote();
  if (!hasChanges()) { ok('Nessuna modifica da sincronizzare.'); return; }

  log('Modifiche in partenza:');
  stdout.write(colors.dim + git('status --short') + colors.reset + '\n\n');

  const proceed = await confirm('Inviare queste modifiche?');
  if (!proceed) { warn('Push annullato.'); return; }

  const now = new Date();
  const ts = now.toISOString().replace('T', ' ').slice(0, 19);
  const device = `${platform()}-${homedir().split(/[/\\]/).pop()}`;

  git('add -A');
  git(`commit -m "sync: ${ts} [${device}]"`);
  log('Push in corso...');
  git(`push -u origin ${BRANCH}`, { pipe: true });
  ok('Configurazione sincronizzata su GitHub.');
}

function cmdDiff() {
  ensureRepo(); ensureRemote();
  log('Contatto il remote...');
  try { git('fetch origin --quiet'); } catch { warn('Impossibile contattare il remote.'); return; }

  const localEmpty = !hasLocalCommits();
  const behind = localEmpty
    ? git(`rev-list origin/${BRANCH} --count`, { ignoreError: true }) || '0'
    : git(`rev-list HEAD..origin/${BRANCH} --count`, { ignoreError: true }) || '0';
  const ahead  = localEmpty
    ? '0'
    : git(`rev-list origin/${BRANCH}..HEAD --count`, { ignoreError: true }) || '0';

  if (behind === '0') { ok('Già aggiornato. Nessuna modifica dal remote.'); return; }

  stdout.write(`\n${colors.green}📥 ${behind} commit in arrivo${colors.reset}`);
  if (ahead !== '0') stdout.write(`  ${colors.yellow}📤 ${ahead} commit in partenza${colors.reset}`);
  stdout.write('\n\n');

  const commits = localEmpty
    ? git(`log --oneline origin/${BRANCH} -20`, { ignoreError: true })
    : git(`log --oneline HEAD..origin/${BRANCH} -20`, { ignoreError: true });
  if (commits) stdout.write(colors.dim + 'Commit in arrivo:\n' + commits + colors.reset + '\n\n');

  const stat = localEmpty
    ? git(`diff --stat $(git hash-object -t tree /dev/null) origin/${BRANCH}`, { ignoreError: true })
    : git(`diff --stat HEAD...origin/${BRANCH}`, { ignoreError: true });
  if (stat) stdout.write(colors.dim + 'File che cambieranno:\n' + stat + colors.reset + '\n\n');

  log('Per applicare: pisync pull');
}

async function cmdPull() {
  ensureRepo(); ensureRemote();

  if (hasChanges()) {
    warn('Ci sono modifiche locali non committate.');
    stdout.write(colors.dim + git('status --short') + colors.reset + '\n');
    const proceed = await confirm('Scartarle e procedere col pull? (fai prima push per salvarle)');
    if (!proceed) { warn('Pull annullato.'); return; }
    try { git('checkout -- .'); } catch {}
  }

  // Anteprima
  try { git('fetch origin --quiet'); } catch { warn('Offline?'); }
  const localEmpty = !hasLocalCommits();
  const behind = localEmpty
    ? git(`rev-list origin/${BRANCH} --count`, { ignoreError: true }) || '0'
    : git(`rev-list HEAD..origin/${BRANCH} --count`, { ignoreError: true }) || '0';

  if (behind === '0') { ok('Già aggiornato.'); return; }

  const commits = localEmpty
    ? git(`log --oneline origin/${BRANCH} -20`, { ignoreError: true })
    : git(`log --oneline HEAD..origin/${BRANCH} -20`, { ignoreError: true });
  const stat = localEmpty
    ? git(`diff --stat $(git hash-object -t tree /dev/null) origin/${BRANCH}`, { ignoreError: true })
    : git(`diff --stat HEAD...origin/${BRANCH}`, { ignoreError: true });
  if (commits) stdout.write(colors.dim + commits + colors.reset + '\n\n');
  if (stat) stdout.write(colors.dim + stat + colors.reset + '\n\n');

  const proceed = await confirm(`${behind} commit in arrivo. Scaricare?`);
  if (!proceed) { warn('Pull annullato.'); return; }

  log('Download in corso...');
  try {
    if (localEmpty) {
      git(`fetch origin ${BRANCH}`);
      git(`checkout -b ${BRANCH} origin/${BRANCH}`);
    } else {
      git(`pull origin ${BRANCH} --rebase`, { pipe: true });
    }
    ok('Configurazione aggiornata da GitHub.');
  } catch {
    warn('Conflitto! Risolvi con: cd ~/.pi/agent && git add . && git rebase --continue');
  }
}

function cmdStatus() {
  ensureRepo();
  log(`Repo: ${PI_DIR}`);

  if (hasRemote()) {
    log(`Remote: ${git('remote get-url origin')}`);
    try {
      git('fetch origin --quiet');
      const localEmpty = !hasLocalCommits();
      const behind = localEmpty
        ? git(`rev-list origin/${BRANCH} --count`, { ignoreError: true }) || '0'
        : git(`rev-list HEAD..origin/${BRANCH} --count`, { ignoreError: true }) || '0';
      const ahead = localEmpty
        ? '0'
        : git(`rev-list origin/${BRANCH}..HEAD --count`, { ignoreError: true }) || '0';
      if (behind !== '0') log(`📥 ${behind} commit da scaricare`);
      if (ahead  !== '0') log(`📤 ${ahead} commit da inviare`);
      if (behind === '0' && ahead === '0') ok('In sync col remote.');
    } catch { warn('Offline.'); }
  } else { warn('Nessun remote configurato.'); }

  const changes = git('status --porcelain', { ignoreError: true });
  if (changes) { log('\nModifiche locali:'); stdout.write(colors.dim + git('status --short') + colors.reset + '\n'); }
  else log('Working tree pulito.');
}

function cmdLog() {
  ensureRepo();
  try { stdout.write(git('log --oneline -20 --format=%h %ad %s --date=short') + '\n'); }
  catch { log('Nessun commit.'); }
}

function cmdRemote(url) {
  ensureRepo();
  if (url) { try { git('remote remove origin', { ignoreError: true }); } catch {} git(`remote add origin ${url}`); ok(`Remote: ${url}`); }
  else if (hasRemote()) log(`Remote: ${git('remote get-url origin')}`);
  else warn('Nessun remote. pisync setup <url>');
}

function cmdHelp() {
  stdout.write(`
${LABEL} Sync configurazione pi con GitHub

  pisync push             Salva su GitHub
  pisync pull             Scarica da GitHub (con anteprima e conferma)
  pisync diff             Vedi cosa cambierebbe col pull (dry-run)
  pisync status           Stato attuale
  pisync log              Storico sync
  pisync setup <url>      Collega al repo GitHub
  pisync remote [url]     Mostra/imposta remote

Primo dispositivo:
  pisync setup https://github.com/user/pi-config.git
  pisync push

Altro dispositivo:
  pi install git:github.com/flavi0gritti/pi-syncro
  pisync setup https://github.com/user/pi-config.git
  pisync pull

`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

const cmd = argv[2] || 'help';

(async () => {
  switch (cmd) {
    case 'setup':    cmdSetup(argv[3]); break;
    case 'push':     case 'upload':    await cmdPush(); break;
    case 'pull':     case 'download':  await cmdPull(); break;
    case 'diff':     case 'preview':   case 'dry-run': cmdDiff(); break;
    case 'status':   case 'st':        cmdStatus(); break;
    case 'log':      case 'history':   cmdLog(); break;
    case 'remote':                      cmdRemote(argv[3]); break;
    case 'help':     case '--help':     case '-h': cmdHelp(); break;
    default: stderr.write(`${LABEL} Comando sconosciuto: ${cmd}\n`); cmdHelp(); exit(1);
  }
})();
