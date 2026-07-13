#!/usr/bin/env node
/**
 * pi-sync — Sync della configurazione pi (~/.pi/agent) con un repo git remoto.
 *
 * Uso:
 *   pisync setup <url>   Configura il remote e fai il pull iniziale
 *   pisync push          Commit + push delle modifiche locali
 *   pisync pull          Pull delle modifiche remote (con rebase)
 *   pisync status        Mostra lo stato (modifiche locali, differenze col remote)
 *   pisync log           Mostra lo storico dei commit
 *   pisync remote        Mostra/imposta il remote
 *
 * I comandi sono gli stessi su macOS, Linux e Windows.
 */

import { execSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { argv, exit, stderr, stdout } from 'node:process';

// ─── Config ──────────────────────────────────────────────────────────────────

const PI_DIR = join(homedir(), '.pi', 'agent');
const BRANCH = 'main';
const LABEL = '[pi-sync]';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(msg) {
  stdout.write(`${LABEL} ${msg}\n`);
}

function warn(msg) {
  stderr.write(`${LABEL} ⚠️  ${msg}\n`);
}

function die(msg) {
  stderr.write(`${LABEL} ❌ ${msg}\n`);
  exit(1);
}

function git(args, opts = {}) {
  try {
    const result = execSync(`git ${args}`, {
      cwd: PI_DIR,
      encoding: 'utf-8',
      stdio: opts.pipe ? 'inherit' : 'pipe',
      ...opts,
    });
    return (result || '').trim();
  } catch (err) {
    if (opts.ignoreError) return '';
    throw err;
  }
}

function ensureGitRepo() {
  if (!existsSync(join(PI_DIR, '.git'))) {
    die(`Nessun repo git in ${PI_DIR}. Esegui prima "pisync setup <url>".`);
  }
}

function hasRemote() {
  try {
    const r = git('remote get-url origin', { ignoreError: true });
    return r.length > 0;
  } catch {
    return false;
  }
}

function ensureRemote() {
  if (!hasRemote()) {
    die('Nessun remote configurato. Esegui "pisync setup <url>".');
  }
}

function hasStagedChanges() {
  try {
    const status = git('status --porcelain');
    return status.length > 0;
  } catch {
    return false;
  }
}

// ─── Platform helpers ────────────────────────────────────────────────────────

const IS_WINDOWS = platform() === 'win32';

function shellPath(p) {
  // Su Windows Git Bash i path vanno normalizzati con forward slash
  return IS_WINDOWS ? p.replace(/\\/g, '/') : p;
}

// ─── Comandi ─────────────────────────────────────────────────────────────────

async function cmdSetup(repoUrl) {
  if (!repoUrl) {
    die('Specifica l\'URL del repo. Uso: pisync setup <url>');
  }

  if (!existsSync(PI_DIR)) {
    die(`Directory ${PI_DIR} non trovata. Installa pi prima.`);
  }

  // Se il repo git esiste già, lo riconfiguriamo
  if (existsSync(join(PI_DIR, '.git'))) {
    log('Repo git già esistente, riconfiguro il remote...');
    try {
      git('remote remove origin', { ignoreError: true });
    } catch { /* ok */ }
    git(`remote add origin ${repoUrl}`);
    git(`fetch origin`);
    log('Remote configurato. Esegui "pisync pull" per scaricare la configurazione.');
    return;
  }

  // Inizializza il repo da zero
  log(`Inizializzo repo git in ${PI_DIR}...`);
  git('init -b main');

  // Crea .gitignore se non esiste
  const giPath = join(PI_DIR, '.gitignore');
  if (!existsSync(giPath)) {
    writeFileSync(giPath, `# secrets
auth.json

# sessions (grandi e sensibili)
sessions/

# rigenerabili con "pi install"
git/
npm/

# binari e temporanei
bin/
backups/
tmp/

# sistema operativo
.DS_Store
**/.DS_Store
Thumbs.db

# stato interno pi
.sync-pending
`);
    log('.gitignore creato.');
  }

  git(`remote add origin ${repoUrl}`);
  git(`fetch origin`);

  log('Setup completato.');
  log(`Ora esegui "pisync push" per caricare la tua configurazione,`);
  log(`oppure "pisync pull" se il repo remoto ha già dei file.`);
}

async function cmdPush() {
  ensureGitRepo();
  ensureRemote();

  if (!hasStagedChanges()) {
    log('Nessuna modifica da sincronizzare.');
    return;
  }

  log('Modifiche rilevate:');
  git('status --short', { pipe: true });

  // Crea il timestamp in formato cross-platform
  const now = new Date();
  const ts = now.toISOString().replace('T', ' ').slice(0, 19);
  const device = `${platform()}-${homedir().split(/[/\\]/).pop()}`;

  git('add -A');
  git(`commit -m "sync: ${ts} [${device}]"`);

  log('Push in corso...');
  git(`push -u origin ${BRANCH}`, { pipe: true });
  log('✅ Configurazione sincronizzata su GitHub.');
}

function cmdPull() {
  ensureGitRepo();
  ensureRemote();

  // Salva lo stato attuale
  const localChanges = hasStagedChanges();

  if (localChanges) {
    log('Ci sono modifiche locali non committate.');
    log('Esegui "pisync push" prima di fare pull, oppure fai stash a mano.');
    git('status --short', { pipe: true });
    warn('Pull annullato per evitare conflitti.');
    return;
  }

  log('Pull da origin...');
  try {
    git(`pull origin ${BRANCH} --rebase`, { pipe: true });
    log('✅ Configurazione aggiornata dal remote.');
  } catch {
    warn('⚠️  Conflitto durante il pull. Risolvi i conflitti a mano, poi:');
    warn('   git add . && git rebase --continue');
  }
}

function cmdStatus() {
  ensureGitRepo();

  log(`Repo: ${PI_DIR}`);

  if (hasRemote()) {
    const remote = git('remote get-url origin');
    log(`Remote: ${remote}`);
    try {
      git('fetch origin --quiet');
      const behind = git(`rev-list HEAD..origin/${BRANCH} --count`);
      const ahead = git(`rev-list origin/${BRANCH}..HEAD --count`);
      if (behind !== '0') log(`📥 Commits da scaricare: ${behind}`);
      if (ahead !== '0') log(`📤 Commits da inviare: ${ahead}`);
      if (behind === '0' && ahead === '0') log('✅ In sync col remote.');
    } catch {
      warn('Impossibile contattare il remote.');
    }
  } else {
    warn('Nessun remote configurato.');
  }

  const changes = git('status --porcelain');
  if (changes) {
    log('\nModifiche locali:');
    git('status --short', { pipe: true });
  } else {
    log('Working tree pulito.');
  }
}

function cmdLog() {
  ensureGitRepo();
  try {
    git('log --oneline -20 --color=always', { pipe: true });
  } catch {
    log('Nessun commit nel repo.');
  }
}

function cmdRemote(url) {
  ensureGitRepo();
  if (url) {
    try {
      git('remote remove origin', { ignoreError: true });
    } catch { /* ok */ }
    git(`remote add origin ${url}`);
    log(`Remote impostato: ${url}`);
  } else {
    if (hasRemote()) {
      log(`Remote: ${git('remote get-url origin')}`);
    } else {
      warn('Nessun remote configurato.');
    }
  }
}

// ─── Help ────────────────────────────────────────────────────────────────────

function cmdHelp() {
  stdout.write(`
${LABEL} Sync della configurazione pi (~/.pi/agent) con GitHub

Uso:  pisync <comando> [opzioni]

Comandi:

  setup <url>   Configura il collegamento al repo GitHub.
                Su un nuovo device, dopo "pi install" esegui questo comando
                e poi "pisync pull" per scaricare la configurazione.

  push          Salva le modifiche locali su GitHub.
                Fa commit di tutti i cambiamenti e li invia al remote.

  pull          Scarica la configurazione da GitHub.
                Disponibile SOLO se non ci sono modifiche locali non committate.
                In caso di modifiche, fai prima "pisync push".

  status        Mostra lo stato attuale: modifiche locali, differenze
                col remote, commit da inviare/scaricare.

  log           Mostra lo storico degli ultimi 20 sync.

  remote [url]  Mostra o imposta l'URL del repo remoto.

Setup primo dispositivo:
  cd ~/.pi/agent
  pisync setup https://github.com/tuo-user/pi-config.git
  pisync push

Setup secondo dispositivo (dopo aver installato pi):
  pisync setup https://github.com/tuo-user/pi-config.git
  pisync pull

Nota: auth.json, sessions/, npm/ e altre directory locali sono escluse
      dal sync tramite .gitignore.
`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

const command = argv[2] || 'help';

switch (command) {
  case 'setup':
    await cmdSetup(argv[3]);
    break;
  case 'push':
  case 'upload':
    await cmdPush();
    break;
  case 'pull':
  case 'download':
    cmdPull();
    break;
  case 'status':
  case 'st':
    cmdStatus();
    break;
  case 'log':
  case 'history':
    cmdLog();
    break;
  case 'remote':
    cmdRemote(argv[3]);
    break;
  case 'help':
  case '--help':
  case '-h':
    cmdHelp();
    break;
  default:
    stderr.write(`${LABEL} Comando sconosciuto: ${command}\n`);
    cmdHelp();
    exit(1);
}
