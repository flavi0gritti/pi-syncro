import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sdkName = '@earendil-works/pi-coding-agent';

export function findPiSDK() {
  try { return import.meta.resolve(sdkName); } catch { /* Managed extensions may not resolve the host as a Node dependency. */ }
  const roots = [];
  for (const entry of [process.argv[1], process.execPath].filter(Boolean)) {
    let dir = dirname(resolve(entry));
    while (dirname(dir) !== dir) { roots.push(dir); dir = dirname(dir); }
  }
  for (const dir of (process.env.PATH || '').split(delimiter).filter(Boolean)) {
    roots.push(join(dir, 'node_modules', sdkName), join(dir, '..', 'lib', 'node_modules', sdkName));
  }
  for (const root of roots) {
    try {
      const metadata = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      if (metadata.name !== sdkName) continue;
      const entry = join(root, metadata.main || 'dist/index.js');
      if (existsSync(entry)) return pathToFileURL(entry).href;
    } catch { /* Not a Pi package root. */ }
  }
  throw new Error('Pi SDK non trovato.');
}

// Only materialize packages in the accepted, machine-local settings. The SDK
// understands source refs, npm pins, object filters and installation paths.
// In-memory settings prevent writes to settings.json or private sync state.
export async function materializePackages(dir, sdk) {
  if (process.env.PI_OFFLINE === '1') throw new Error('Modalità offline.');
  const settings = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
  const manager = new sdk.DefaultPackageManager({
    cwd: dir, agentDir: dir,
    settingsManager: sdk.SettingsManager.inMemory({ packages: settings.packages || [] }),
  });
  let installed = 0;
  const sources = new Set((settings.packages || []).map(pkg => typeof pkg === 'string' ? pkg : pkg.source));
  for (const source of sources) {
    if (typeof source !== 'string' || !source) throw new Error('Sorgente non valida.');
    if (manager.getInstalledPath(source, 'user')) continue;
    // Same installation method used by `pi install`, without its settings write.
    // Includes Git cloning, npm downloads, pinned versions and dependencies.
    await manager.install(source, { local: false });
    if (!manager.getInstalledPath(source, 'user')) throw new Error('Pacchetto o percorso locale mancante.');
    installed++;
  }
  return { installed, total: sources.size };
}

export function updatePackages(dir, { timeout = 120_000, sdkURL } = {}) {
  return new Promise(resolveResult => {
    const windows = process.platform === 'win32';
    let child;
    try {
      child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--worker', dir, sdkURL || findPiSDK()], {
        cwd: dir, env: { ...process.env, PI_CODING_AGENT_DIR: dir, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', npm_config_fetch_retries: '0', npm_config_fetch_timeout: '30000' },
        shell: false, detached: !windows, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
    } catch { resolveResult(false); return; }
    let settled = false, timedOut = false, summary;
    child.on('message', message => {
      if (Number.isInteger(message?.installed) && Number.isInteger(message?.total) && message.installed >= 0 && message.total >= message.installed) summary = message;
    });
    const finish = ok => {
      if (settled) return;
      settled = true; clearTimeout(timer); resolveResult(ok);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid && windows) {
        // Wait for tree termination before allowing a retry on Windows.
        const fallback = setTimeout(() => { child.kill(); finish(false); }, 5000);
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => { clearTimeout(fallback); child.kill(); finish(false); });
        killer.on('exit', () => { clearTimeout(fallback); finish(false); });
      } else {
        if (child.pid) {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
        }
        finish(false);
      }
    }, timeout);
    child.on('error', () => finish(false));
    child.on('exit', code => finish(!timedOut && code === 0 && summary ? summary : false));
  });
}

export async function runPackages(dir, ui, update = updatePackages) {
  const accepted = await ui.choose(
    'Installare i pacchetti mancanti dichiarati su questo PC? Le estensioni possono eseguire codice: procedi solo se ti fidi delle sorgenti in settings.json.',
    [{ label: 'Installa pacchetti mancanti', value: 'install' }, { label: 'Non ora', value: 'skip' }],
  );
  if (accepted !== 'install') {
    ui.notify('Pacchetti non riconciliati. Prima di ricaricare Pi esegui /sync packages, oppure pi install <sorgente> per ogni pacchetto mancante.');
    return false;
  }
  ui.notify('Riconciliazione pacchetti in corso (massimo 2 minuti)…');
  let ok = false;
  try { ok = await update(dir); } catch { /* Never expose subprocess output or credentials. */ }
  ui.notify(ok
    ? typeof ok === 'object'
      ? ok.installed > 0
        ? `Installati ${ok.installed} pacchetti mancanti (${ok.total} verificati). Riavvia Pi o esegui /reload.`
        : `Nessun pacchetto da installare: tutti i ${ok.total} pacchetti dichiarati sono già presenti. Le sorgenti assenti da settings.json non vengono reinstallate.`
      : 'Pacchetti riconciliati. Riavvia Pi o esegui /reload.'
    : 'Riconciliazione non completata (errore, modalità offline o timeout). Il pull resta valido; i pacchetti possono essere installati solo in parte. Non ricaricare ancora Pi. Riprova con /sync packages oppure usa pi install <sorgente> nel terminale.');
  return ok;
}

if (process.argv[2] === '--worker' && process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const summary = await materializePackages(process.argv[3], await import(process.argv[4]));
    if (process.send) await new Promise((resolve, reject) => process.send(summary, error => error ? reject(error) : resolve()));
  } catch { process.exitCode = 1; }
  finally { if (process.connected) process.disconnect(); }
}
