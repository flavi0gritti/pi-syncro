import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, lstatSync, rmSync, renameSync, chmodSync, mkdtempSync, openSync, closeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { formatDiff } from './diff-view.mjs';
import { MISSING, same, parse, encode, normalized, mergeFile, object } from './merge.mjs';
import { parseRules, validateRules, projectSettings, sharedSettings, changeRules, rulesNotes, stripAutomaticSettings, localSettingFields } from './local-rules.mjs';

const equal = (a, b) => a === undefined ? b === undefined : b !== undefined && a.equals(b);
const secret = p => /(^|\/)(auth\.json|mcp-auth\.json|settings\.local\.json|\.syncignore|\.env(?:\..*)?)$/i.test(p) || /(^|\/)(sessions|git|npm|bin|backups|tmp)(\/|$)/i.test(p) || /(?:credential|secret|token|private.key)/i.test(p);
const automatic = p => p === 'models-store.json';
const privateFile = p => secret(p) || automatic(p);
const bytes = p => existsSync(p) ? readFileSync(p) : undefined;

export function createSync(dir) {
  function git(args, options = {}) {
    return execFileSync('git', args, { cwd: dir, maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], ...options });
  }
  const text = args => git(args).toString('utf8').trim();
  function ref(name) { try { return text(['rev-parse', '--verify', name]); } catch { return undefined; } }
  let repositoryDir;
  const gitDir = () => repositoryDir ||= text(['rev-parse', '--absolute-git-dir']);
  const statePath = () => join(gitDir(), 'pi-sync-local-state.json');
  const localRules = () => parseRules(bytes(join(dir, 'settings.local.json')));
  function state(expectedHead) {
    const data = bytes(statePath());
    if (!data) return undefined;
    try {
      const s = JSON.parse(data.toString());
      if (s.version !== 1 || !object(s.rules) || (s.shared !== null && !object(s.shared))) throw new Error();
      validateRules(s.rules);
      if (s.head !== undefined && (typeof s.head !== 'string' || !/^[0-9a-f]{40,64}$/.test(s.head))) throw new Error();
      if (s.head !== undefined && s.head !== expectedHead) throw new Error('external-head');
      return s;
    } catch (error) {
      if (error.message === 'external-head') throw new Error('HEAD è cambiato fuori da pi-syncro rispetto allo stato privato. Fermati e confronta stato/backup e Git prima di continuare: non cancellare lo stato locale.');
      throw new Error('Stato locale di pi-syncro non valido. Recuperalo dal backup prima di continuare.');
    }
  }
  function ignored(p) {
    if (privateFile(p)) return true;
    const patterns = (bytes(join(dir, '.syncignore'))?.toString() || '').split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#'));
    return patterns.some(pattern => {
      const rx = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
      return new RegExp(`^(?:${pattern.includes('/') ? '' : '.*/'}${rx})(?:/.*)?$`).test(p) || new RegExp(`^${rx}(?:/.*)?$`).test(p);
    });
  }
  function safePath(p) {
    if (!p || p.includes('\\') || p.startsWith('/') || p.includes(':')) throw new Error('Percorso non sicuro nel repository.');
    let path = dir;
    const parts = p.split('/');
    if (parts.some(x => !x || x === '.' || x === '..' || x.toLowerCase() === '.git' || /[. ]$|[\x00-\x1f]/.test(x) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(x))) throw new Error('Percorso non portabile o non sicuro nel repository.');
    for (let i = 0; i < parts.length; i++) {
      path = join(path, parts[i]);
      let stat;
      try { stat = lstatSync(path); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (stat.isSymbolicLink()) throw new Error(`Link simbolico non supportato: ${p}`);
      if (i < parts.length - 1 && !stat.isDirectory()) throw new Error(`Conflitto tra file e cartella: ${p}`);
    }
  }
  const trees = new Map();
  function tree(commit) {
    if (!commit) return new Map();
    if (trees.has(commit)) return new Map(trees.get(commit));
    const result = new Map();
    for (const entry of git(['ls-tree', '-rz', commit]).toString('utf8').split('\0').filter(Boolean)) {
      const [meta, p] = entry.split('\t'), [mode, type, oid] = meta.split(' ');
      if (type !== 'blob' || !['100644', '100755'].includes(mode)) throw new Error(`Tipo di file non supportato: ${p}`);
      safePath(p); result.set(p, git(['cat-file', 'blob', oid]));
    }
    trees.set(commit, result); return new Map(result);
  }
  function working(base) {
    const paths = new Set([...base.keys(), ...git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).toString().split('\0').filter(Boolean)]);
    const result = new Map();
    for (const p of paths) {
      safePath(p);
      const full = join(dir, p);
      if (existsSync(full) && lstatSync(full).isFile()) result.set(p, readFileSync(full));
    }
    return result;
  }
  function canonicalSettings(current, base, rules, saved) {
    let reference, local, original;
    try { original = parse(base); local = parse(current); reference = saved ? saved.shared === null ? MISSING : saved.shared : original; }
    catch { throw new Error('JSON non valido in settings.json; nessun file modificato.'); }
    const shared = stripAutomaticSettings(sharedSettings(local, reference, rules));
    if (same(shared, original)) return base;
    if (original === MISSING && reference === MISSING && object(shared) && !Object.keys(shared).length) return undefined;
    return shared === MISSING ? undefined : encode(shared);
  }
  function commonBytes(data) {
    if (data === undefined) return undefined;
    let original;
    try { original = parse(data); } catch { throw new Error('JSON non valido in settings.json; nessun file modificato.'); }
    const common = stripAutomaticSettings(original);
    return same(common, original) ? data : encode(common);
  }
  function project(shared, rules, current) {
    const existing = parse(current);
    const hasMetadata = object(existing) && localSettingFields.some(k => Object.hasOwn(existing, k));
    if (shared === undefined && !Object.keys(rules.overrides || {}).length && !hasMetadata) return undefined;
    const projected = projectSettings(shared === undefined ? {} : parse(shared), rules);
    for (const key of localSettingFields) {
      if (Object.hasOwn(rules.overrides || {}, key)) continue;
      if (object(existing) && Object.hasOwn(existing, key)) projected[key] = existing[key]; else delete projected[key];
    }
    if (same(projected, existing)) return current;
    const keys = [...new Set([...(object(existing) ? Object.keys(existing) : []), ...Object.keys(projected)])];
    return encode(Object.fromEntries(keys.filter(k => Object.hasOwn(projected, k)).map(k => [k, projected[k]])));
  }
  function fingerprint(head, work) {
    const h = createHash('sha256').update(head || '');
    // Caches may change while the user reads the preview; they are never written by sync.
    for (const [p, b] of [...work].sort(([a], [b]) => a.localeCompare(b))) if (p !== 'settings.json' && !ignored(p)) h.update(p).update('\0').update(b).update('\0');
    for (const p of [join(dir, 'settings.json'), join(dir, 'settings.local.json'), join(dir, '.syncignore'), statePath()]) h.update(p).update('\0').update(bytes(p) || '').update('\0');
    h.update(git(['ls-files', '--stage', '-z'])); return h.digest('hex');
  }
  function hasInlineSecret(value) {
    if (typeof value === 'string' && /https?:\/\/[^/\s]*@/i.test(value)) return true;
    if (!value || typeof value !== 'object') return false;
    return Object.entries(value).some(([key, item]) => {
      if (/(?:api[_-]?key|authorization|password|passwd|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|cookie)/i.test(key) && item !== '' && item !== null && item !== undefined && item !== false) return true;
      if (/(?:token|secret)$/i.test(key) && typeof item === 'string' && item) return true;
      return hasInlineSecret(item);
    });
  }
  function checkInlineSecrets(files) {
    for (const [p, b] of files) {
      if (!p.endsWith('.json') || privateFile(p)) continue;
      let value; try { value = parse(b); } catch { continue; }
      if (hasInlineSecret(value)) throw new Error(`Possibili credenziali inline in ${p}. Push bloccato: separale dalla configurazione condivisa (nessun valore viene mostrato).`);
    }
  }
  function ready() {
    if (text(['symbolic-ref', '--short', 'HEAD']) !== 'main') throw new Error('Usa il branch main prima della sincronizzazione.');
    for (const marker of ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD']) if (existsSync(join(gitDir(), marker))) throw new Error('Completa prima l’operazione Git in corso.');
    if (git(['diff', '--cached', '--name-only']).length) throw new Error('Ci sono file nello stage: completali o rimuovili dallo stage prima del sync.');
  }
  function build(snapshot, resolutions = {}) {
    const { direction, head, remote, base, upstream, work, rules, saved } = snapshot;
    const target = new Map(direction === 'push' ? base : work), conflicts = [];
    let shared;
    for (const p of new Set([...base.keys(), ...work.keys(), ...upstream.keys()])) {
      if (privateFile(p)) { if (direction === 'push') target.delete(p); continue; }
      if (ignored(p)) continue;
      const local = p === 'settings.json' ? canonicalSettings(work.get(p), base.get(p), rules, saved) : normalized(work.get(p));
      let value = direction === 'push' ? local : mergeFile(p, p === 'settings.json' ? commonBytes(base.get(p)) : base.get(p), local, p === 'settings.json' ? commonBytes(upstream.get(p)) : upstream.get(p), resolutions, conflicts);
      if (p === 'settings.json') {
        shared = value;
        if (direction === 'pull') value = project(value, rules, work.get(p));
      }
      // Do not reformat untouched local files during a pull.
      if (direction === 'pull' && p !== 'settings.json' && equal(normalized(work.get(p)), value)) value = work.get(p);
      if (value === undefined) target.delete(p); else target.set(p, value);
    }
    const before = direction === 'push' ? upstream : work;
    const changes = [...new Set([...before.keys(), ...target.keys()])].sort().filter(p => !equal(before.get(p), target.get(p)));
    // A deliberately ignored settings.json must not be read or projected into private state.
    const sharedValue = parse(shared);
    const managesSettings = !ignored('settings.json') && [base, work, upstream].some(files => files.has('settings.json'));
    const newState = !managesSettings ? undefined : encode({ version: 1, rules, shared: sharedValue === MISSING ? null : sharedValue });
    const plan = { ...snapshot, target, before, changes, conflicts, resolutions, newState, privatePaths: changes.filter(privateFile), notes: [...rulesNotes(rules), ...(changes.includes('models-store.json') ? ['models-store.json resta sul PC: viene rimossa solo la vecchia copia condivisa.'] : [])] };
    if (direction === 'push' && !conflicts.length) checkInlineSecrets(target);
    validateWrites(plan); return plan;
  }
  function validateWrites(plan) {
    if (plan.direction === 'push') return;
    for (const p of plan.changes) {
      safePath(p);
      if (plan.target.has(p) && existsSync(join(dir, p)) && !lstatSync(join(dir, p)).isFile()) throw new Error(`Conflitto con una cartella locale: ${p}. Nessun file modificato.`);
    }
  }
  function prepare(direction) {
    if (!['push', 'pull'].includes(direction)) throw new Error('Direzione non valida.');
    ready(); git(['fetch', 'origin', '--prune']);
    const head = ref('HEAD'), remote = ref('refs/remotes/origin/main');
    const base = tree(head), upstream = tree(remote), work = working(base), rules = localRules(), saved = state(head);
    if (saved && !same(saved.rules, rules)) throw new Error('settings.local.json è cambiato a mano. Usa local apply per confrontare e applicare le nuove eccezioni.');
    if (!saved && (Object.keys(rules.overrides || {}).length || rules.excludedPackages?.length)) throw new Error('Inizializza le nuove eccezioni con local apply: serve a conservare i valori condivisi prima di nasconderli.');
    if (direction === 'push' && head) {
      const commits = text(['rev-list', head, ...(remote ? [`^${remote}`] : [])]).split('\n').filter(Boolean);
      for (const commit of commits) {
        const paths = git(['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', '-z', commit]).toString().split('\0').filter(Boolean);
        if (paths.some(secret)) throw new Error('Un commit locale non pubblicato contiene file privati. Push bloccato: rimuovili anche dalla cronologia prima di riprovare.');
        checkInlineSecrets(tree(commit));
      }
    }
    if (head && remote && head !== remote) {
      const ancestor = (a, b) => { try { git(['merge-base', '--is-ancestor', a, b]); return true; } catch { return false; } };
      if (direction === 'push' && !ancestor(remote, head)) throw new Error('GitHub ha novità: push bloccato, nessun rebase automatico. Usa /sync pull per confrontare e confermare le novità.');
      if (direction === 'pull' && !ancestor(head, remote)) throw new Error('Le storie Git sono divergenti (o hai commit locali). Nessun file modificato: serve risolverle manualmente.');
    }
    if (direction === 'pull' && !remote) throw new Error('Il branch main remoto non esiste.');
    const snapshot = { direction, head, remote, base, upstream, work, rules, saved, stamp: fingerprint(head, work) };
    return build(snapshot);
  }
  function resolve(plan, resolutions) {
    const valid = new Set(plan.conflicts.map(c => c.id));
    for (const [id, side] of Object.entries(resolutions)) if (!valid.has(id) || !['local', 'remote'].includes(side)) throw new Error('Scelta di conflitto non valida.');
    return build(plan, { ...plan.resolutions, ...resolutions });
  }
  function prepareLocal(action, key, value) {
    ready();
    const head = ref('HEAD'), base = tree(head), work = working(base), saved = state(head), rules = localRules();
    safePath('settings.local.json'); safePath('settings.json');
    const physicalSettings = bytes(join(dir, 'settings.json'));
    if (physicalSettings) work.set('settings.json', physicalSettings);
    // Before the first state file only the legacy provider filter could have been applied.
    const previousRules = saved?.rules || { ...rules, overrides: {}, excludedPackages: [] };
    const shared = canonicalSettings(work.get('settings.json'), base.get('settings.json'), previousRules, saved);
    const nextRules = changeRules(rules, action, key, value);
    const target = new Map(work), before = new Map(work);
    const ruleBytes = bytes(join(dir, 'settings.local.json'));
    if (ruleBytes) before.set('settings.local.json', ruleBytes);
    target.set('settings.local.json', encode(nextRules));
    const nextSettings = project(shared, nextRules, work.get('settings.json'));
    if (nextSettings === undefined) target.delete('settings.json'); else target.set('settings.json', nextSettings);
    const changes = [...new Set([...before.keys(), ...target.keys()])].sort().filter(p => !equal(before.get(p), target.get(p)));
    const plan = { direction: 'local', head, base, work, before, target, changes, conflicts: [], rules: nextRules, notes: rulesNotes(nextRules), stamp: fingerprint(head, work), newState: encode({ version: 1, rules: nextRules, shared: shared === undefined ? null : parse(shared) }) };
    validateWrites(plan); return plan;
  }
  function prepareIgnore(action, pattern) {
    ready(); safePath('.syncignore');
    if (!['add', 'remove'].includes(action) || !pattern || /[\r\n\x00-\x1f]/.test(pattern) || pattern.startsWith('#')) throw new Error('Uso: ignore add|remove <pattern>.');
    const head = ref('HEAD'), base = tree(head), work = working(base), before = new Map(work), target = new Map(work);
    const original = bytes(join(dir, '.syncignore'));
    if (original) before.set('.syncignore', original);
    const patterns = (original?.toString() || '').split(/\r?\n/).filter(Boolean);
    const next = action === 'add' ? [...new Set([...patterns, pattern])] : patterns.filter(p => p !== pattern);
    target.set('.syncignore', Buffer.from(next.join('\n') + '\n'));
    return { direction: 'local', head, base, work, before, target, changes: equal(original, target.get('.syncignore')) ? [] : ['.syncignore'], conflicts: [], notes: ['Esclusioni per file: solo questo PC.'], stamp: fingerprint(head, work) };
  }
  function atomic(path, data) {
    const temp = `${path}.pi-sync-${randomUUID()}.tmp`;
    const mode = existsSync(path) ? lstatSync(path).mode & 0o777 : 0o600;
    try { writeFileSync(temp, data, { flag: 'wx', mode }); chmodSync(temp, mode); renameSync(temp, path); }
    finally { rmSync(temp, { force: true }); }
  }
  function saveState(plan) {
    if (!plan.newState) return;
    const data = JSON.parse(plan.newState.toString()), head = ref('HEAD');
    if (head) data.head = head;
    atomic(statePath(), encode(data));
  }
  function backup(plan) {
    const dest = join(gitDir(), 'pi-sync-backups', new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID());
    mkdirSync(dest, { recursive: true, mode: 0o700 });
    for (const [p, b] of plan.before) {
      // Push before means GitHub, but backup must contain the actual local files.
      if (plan.direction === 'push') break;
      const full = join(dest, 'files', p); mkdirSync(dirname(full), { recursive: true, mode: 0o700 }); writeFileSync(full, b, { mode: 0o600 });
    }
    if (plan.direction === 'push') for (const [p, b] of plan.work) {
      const full = join(dest, 'files', p); mkdirSync(dirname(full), { recursive: true, mode: 0o700 }); writeFileSync(full, b, { mode: 0o600 });
    }
    const oldState = bytes(statePath()); if (oldState) writeFileSync(join(dest, 'local-state.before.json'), oldState, { mode: 0o600 });
    const oldRules = bytes(join(dir, 'settings.local.json')); if (oldRules) writeFileSync(join(dest, 'settings.local.before.json'), oldRules, { mode: 0o600 });
    writeFileSync(join(dest, 'manifest.json'), JSON.stringify({ head: plan.head, remote: plan.remote, files: [...(plan.direction === 'push' ? plan.work : plan.before).keys()] }, null, 2), { mode: 0o600 });
    return dest;
  }
  function makeTree(files, head) {
    const temp = mkdtempSync(join(tmpdir(), 'pi-sync-index-')), env = { ...process.env, GIT_INDEX_FILE: join(temp, 'index') };
    try {
      git(head ? ['read-tree', head] : ['read-tree', '--empty'], { env });
      const existing = new Set(git(['ls-files', '-z'], { env }).toString().split('\0').filter(Boolean));
      for (const p of existing) if (!files.has(p)) git(['update-index', '--force-remove', '--', p], { env });
      for (const [p, data] of files) {
        const oid = git(['hash-object', '-w', '--stdin'], { input: data }).toString().trim();
        const mode = existing.has(p) ? git(['ls-files', '--stage', '--', p], { env }).toString().slice(0, 6) : '100644';
        git(['update-index', '--add', '--cacheinfo', mode, oid, p], { env });
      }
      return git(['write-tree'], { env }).toString().trim();
    } finally { rmSync(temp, { recursive: true, force: true }); }
  }
  function apply(plan) {
    if (plan.conflicts.length) throw new Error('Ci sono conflitti non risolti: scegli locale o GitHub prima di confermare.');
    const lock = join(gitDir(), 'pi-sync.lock'), fd = openSync(lock, 'wx', 0o600);
    try {
      ready();
      if (fingerprint(ref('HEAD'), working(plan.base)) !== plan.stamp) throw new Error('I file sono cambiati dopo l’anteprima. Ripeti il comando per confermare un nuovo diff.');
      if (plan.direction !== 'local') {
        const nowRemote = text(['ls-remote', 'origin', 'refs/heads/main']).split(/\s/)[0] || undefined;
        if (nowRemote !== plan.remote) throw new Error('GitHub è cambiato dopo l’anteprima. Ripeti il comando.');
      }
      validateWrites(plan);
      const saved = backup(plan), previousState = bytes(statePath());
      if (plan.direction === 'push') {
        const treeId = makeTree(plan.target, plan.head), previousTree = plan.head && text(['rev-parse', `${plan.head}^{tree}`]);
        const commit = treeId === previousTree ? plan.head : text(['commit-tree', treeId, ...(plan.head ? ['-p', plan.head] : []), '-m', `sync: ${new Date().toISOString()}`]);
        git(['push', 'origin', `${commit}:refs/heads/main`]);
        try {
          if (commit !== plan.head) git(['update-ref', 'refs/heads/main', commit, ...(plan.head ? [plan.head] : [])]);
          git(['read-tree', commit]);
          saveState(plan);
        } catch { throw new Error(`Invio a GitHub riuscito, aggiornamento dei metadati locali fallito. File locali invariati. Controlla lo stato Git prima di riprovare. Backup: ${saved}`); }
      } else {
        let moved = false;
        try {
          for (const p of plan.changes) {
            safePath(p); const full = join(dir, p), data = plan.target.get(p);
            if (data === undefined) rmSync(full, { force: true });
            else { mkdirSync(dirname(full), { recursive: true }); atomic(full, data); }
          }
          if (plan.direction === 'pull') {
            git(['update-ref', 'refs/heads/main', plan.remote, ...(plan.head ? [plan.head] : [])]); moved = true;
            git(['read-tree', plan.remote]);
          }
          saveState(plan);
        } catch {
          try {
            for (const p of plan.changes) {
              const full = join(dir, p), data = plan.before.get(p);
              if (data === undefined) rmSync(full, { force: true });
              else { mkdirSync(dirname(full), { recursive: true }); atomic(full, data); }
            }
            if (moved) {
              if (plan.head) git(['update-ref', 'refs/heads/main', plan.head, plan.remote]);
              else git(['update-ref', '-d', 'refs/heads/main', plan.remote]);
              git(plan.head ? ['read-tree', plan.head] : ['read-tree', '--empty']);
            }
            if (previousState) atomic(statePath(), previousState); else rmSync(statePath(), { force: true });
          } catch { throw new Error(`Operazione fallita e ripristino incompleto. Recupera dal backup: ${saved}`); }
          throw new Error(`Operazione fallita: file precedenti ripristinati. Backup: ${saved}`);
        }
      }
      return saved;
    } finally { closeSync(fd); rmSync(lock, { force: true }); }
  }
  return { prepare, resolve, prepareLocal, prepareIgnore, ignorePatterns: () => bytes(join(dir, '.syncignore'))?.toString() || '', preview: plan => formatDiff(plan), apply, git, text, localRules };
}
