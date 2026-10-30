import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, lstatSync, rmSync, mkdtempSync, openSync, closeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

const equal = (a, b) => a === undefined ? b === undefined : b !== undefined && a.equals(b);
const json = b => b === undefined ? {} : JSON.parse(b.toString('utf8'));
const encode = o => Buffer.from(JSON.stringify(o, null, 2) + '\n');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const secret = p => /(^|\/)(auth\.json|mcp-auth\.json|settings\.local\.json|\.syncignore|\.env(?:\..*)?)$/.test(p) || /(^|\/)(sessions|git|npm|bin|backups|tmp)(\/|$)/.test(p) || /(?:credential|secret|token|private.key)/i.test(p);

export function createSync(dir) {
  function git(args, options = {}) {
    return execFileSync('git', args, { cwd: dir, maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], ...options });
  }
  const text = args => git(args).toString('utf8').trim();
  function ref(name) { try { return text(['rev-parse', '--verify', name]); } catch { return undefined; } }
  const gitDir = () => text(['rev-parse', '--absolute-git-dir']);
  function localRules() {
    const p = join(dir, 'settings.local.json');
    // Whole-line comments only: never strip // from strings such as URLs.
    const rules = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8').replace(/^\s*\/\/.*$/gm, '')) : {};
    if (rules.excludedProviders !== undefined && (!Array.isArray(rules.excludedProviders) || rules.excludedProviders.some(x => typeof x !== 'string'))) throw new Error('excludedProviders deve essere una lista di nomi.');
    return rules;
  }
  function ignored(p) {
    if (secret(p)) return true;
    const file = join(dir, '.syncignore');
    const patterns = existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#')) : [];
    return patterns.some(pattern => {
      const rx = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
      return new RegExp(`^(?:${pattern.includes('/') ? '' : '.*/'}${rx})(?:/.*)?$`).test(p) || new RegExp(`^${rx}(?:/.*)?$`).test(p);
    });
  }
  function tree(commit) {
    const result = new Map();
    if (!commit) return result;
    for (const entry of git(['ls-tree', '-rz', commit]).toString('utf8').split('\0').filter(Boolean)) {
      const [meta, p] = entry.split('\t');
      const [mode, type, oid] = meta.split(' ');
      if (type !== 'blob' || !['100644', '100755'].includes(mode)) throw new Error(`Tipo di file non supportato: ${p}`);
      safePath(p);
      result.set(p, git(['cat-file', 'blob', oid]));
    }
    return result;
  }
  function safePath(p) {
    if (!p || p.includes('\\') || p.startsWith('/') || p.split('/').some(x => x === '..' || x === '.' || x.toLowerCase() === '.git') || p.includes(':')) throw new Error('Percorso non sicuro nel repository.');
    let path = dir;
    const parts = p.split('/');
    if (parts.some(x => !x || /[. ]$|[\x00-\x1f]/.test(x) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(x))) throw new Error('Percorso non portabile o non sicuro nel repository.');
    for (let i = 0; i < parts.length; i++) {
      path = join(path, parts[i]);
      let stat;
      try { stat = lstatSync(path); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (stat.isSymbolicLink()) throw new Error(`Link simbolico non supportato: ${p}`);
      if (i < parts.length - 1 && !stat.isDirectory()) throw new Error(`Conflitto tra file e cartella: ${p}`);
    }
  }
  function working(base) {
    const paths = new Set([...base.keys(), ...git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).toString('utf8').split('\0').filter(Boolean)]);
    const result = new Map();
    for (const p of paths) {
      if (p.startsWith('.git/')) continue;
      safePath(p);
      const full = join(dir, p);
      if (existsSync(full) && lstatSync(full).isFile()) result.set(p, readFileSync(full));
    }
    return result;
  }
  function overlay(p, bytes, rules) {
    if (!bytes || !['settings.json', 'models-store.json'].includes(p) || !rules.excludedProviders?.length) return bytes;
    const o = json(bytes), excluded = rules.excludedProviders;
    if (p === 'models-store.json') for (const name of excluded) delete o[name];
    else {
      const provider = o.defaultProvider;
      if (excluded.includes(provider)) o.defaultProvider = rules.defaultProvider || '';
      if (excluded.includes(o.defaultModel?.includes('/') ? o.defaultModel.split('/')[0] : provider)) o.defaultModel = rules.defaultModel || '';
      if (Array.isArray(o.enabledModels)) o.enabledModels = o.enabledModels.filter(m => !excluded.includes(m.split('/')[0]));
    }
    return encode(o);
  }
  // Restore only fields removed by the local provider filter, never the whole file.
  function canonical(p, bytes, base, rules) {
    // Git stores LF even when Windows checks files out as CRLF.
    if (bytes && !bytes.includes(0) && Buffer.from(bytes.toString('utf8')).equals(bytes)) bytes = Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n'));
    if (equal(bytes, base)) return base;
    if (!bytes || !base || !['settings.json', 'models-store.json'].includes(p) || !rules.excludedProviders?.length) return bytes;
    const current = json(bytes), original = json(base), filtered = json(overlay(p, base, rules));
    if (same(current, filtered)) return base;
    if (p === 'models-store.json') {
      for (const name of rules.excludedProviders) if (!(name in current) && name in original) current[name] = original[name];
    } else {
      for (const key of ['defaultProvider', 'defaultModel']) if (same(current[key], filtered[key]) && !same(original[key], filtered[key])) current[key] = original[key];
      if (Array.isArray(current.enabledModels) && Array.isArray(original.enabledModels)) {
        for (const m of original.enabledModels) if (rules.excludedProviders.includes(m.split('/')[0]) && !current.enabledModels.includes(m)) current.enabledModels.push(m);
      }
    }
    return same(current, original) ? base : encode(current);
  }
  function fingerprint(head, work) {
    const h = createHash('sha256').update(head || '');
    for (const [p, b] of [...work].sort(([a], [b]) => a.localeCompare(b))) h.update(p).update('\0').update(b).update('\0');
    for (const p of ['settings.local.json', '.syncignore']) h.update(existsSync(join(dir, p)) ? readFileSync(join(dir, p)) : '');
    h.update(git(['ls-files', '--stage', '-z']));
    return h.digest('hex');
  }
  function hasInlineSecret(value) {
    if (!value || typeof value !== 'object') return false;
    return Object.entries(value).some(([key, item]) => {
      if (/(?:api[_-]?key|authorization|password|passwd|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|cookie)/i.test(key) && item !== '' && item !== null && item !== undefined && item !== false) return true;
      return hasInlineSecret(item);
    });
  }
  function checkInlineSecrets(files) {
    for (const [p, bytes] of files) {
      if (!p.endsWith('.json') || secret(p)) continue;
      let value;
      try { value = json(bytes); } catch { continue; }
      if (hasInlineSecret(value)) throw new Error(`Possibili credenziali inline in ${p}. Push bloccato: separale dalla configurazione condivisa (nessun valore viene mostrato).`);
    }
  }
  function prepare(direction) {
    if (!['push', 'pull'].includes(direction)) throw new Error('Direzione non valida.');
    if (text(['symbolic-ref', '--short', 'HEAD']) !== 'main') throw new Error('Usa il branch main prima della sincronizzazione.');
    for (const marker of ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD']) if (existsSync(join(gitDir(), marker))) throw new Error('Completa prima l’operazione Git in corso.');
    if (git(['diff', '--cached', '--name-only']).length) throw new Error('Ci sono file nello stage: completali o rimuovili dallo stage prima del sync.');
    git(['fetch', 'origin', '--prune']);
    const head = ref('HEAD'), remote = ref('refs/remotes/origin/main');
    const base = tree(head), upstream = tree(remote), work = working(base), rules = localRules();
    // Removing secrets from the final tree does not remove them from commit history.
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
      if (direction === 'push' && !ancestor(remote, head)) throw new Error('GitHub ha novità: push bloccato, nessun rebase automatico. Controlla /sync diff, poi /sync pull.');
      if (direction === 'pull' && !ancestor(head, remote)) throw new Error('Le storie Git sono divergenti (o hai commit locali). Nessun file modificato: serve risolverle manualmente.');
    }
    if (direction === 'pull' && !remote) throw new Error('Il branch main remoto non esiste.');
    const target = new Map(direction === 'push' ? base : work);
    const conflicts = [];
    const paths = new Set([...base.keys(), ...work.keys(), ...upstream.keys()]);
    for (const p of paths) {
      if (secret(p)) { if (direction === 'push') target.delete(p); continue; }
      if (ignored(p)) continue;
      if (direction === 'push') {
        const bytes = canonical(p, work.get(p), base.get(p), rules);
        if (bytes === undefined) target.delete(p); else target.set(p, bytes);
      } else if (!equal(base.get(p), upstream.get(p))) {
        const local = canonical(p, work.get(p), base.get(p), rules);
        const incoming = upstream.get(p);
        // Conservative conflict handling: never discard an edited file.
        if (!equal(local, base.get(p)) && !equal(local, incoming)) { conflicts.push(p); continue; }
        const bytes = overlay(p, incoming, rules);
        if (bytes === undefined) target.delete(p); else target.set(p, bytes);
      }
    }
    if (conflicts.length) throw new Error(`Modifiche locali e remote sugli stessi file: ${conflicts.join(', ')}. Nessun file modificato. Salva una copia e risolvi prima il conflitto.`);
    if (direction === 'push') checkInlineSecrets(target);
    const before = direction === 'push' ? upstream : work;
    const changes = [...new Set([...before.keys(), ...target.keys()])].sort().filter(p => !equal(before.get(p), target.get(p)));
    if (direction === 'pull') for (const p of changes) {
      const full = join(dir, p);
      if (target.has(p) && existsSync(full) && !lstatSync(full).isFile()) throw new Error(`Conflitto con una cartella locale: ${p}. Nessun file modificato.`);
    }
    return { direction, head, remote, base, work, target, before, changes, stamp: fingerprint(head, work) };
  }
  function packageLabel(item) {
    const source = typeof item === 'string' ? item : item?.source;
    if (typeof source !== 'string') return '[sorgente nascosta]';
    if (/^git:github\.com\/[\w.-]+\/[\w.-]+(?:@[\w./-]+)?$/.test(source) || /^npm:(?:@[\w.-]+\/)?[\w.-]+(?:@[\w.^~*-]+)?$/.test(source)) return source;
    return '[sorgente o percorso nascosto]';
  }
  function jsonPaths(old, next, prefix = '') {
    if (same(old, next)) return [];
    if (old && next && typeof old === 'object' && typeof next === 'object' && !Array.isArray(old) && !Array.isArray(next)) {
      return [...new Set([...Object.keys(old), ...Object.keys(next)])].flatMap(key => jsonPaths(old[key], next[key], prefix ? `${prefix}.${key}` : key));
    }
    return [`  ${old === undefined ? '+' : next === undefined ? '-' : '~'} ${prefix || '(documento)'} [valori nascosti]`];
  }
  function preview(plan) {
    const lines = [plan.direction === 'push' ? 'SU GITHUB CAMBIERÀ (file locali invariati):' : 'SU QUESTO PC CAMBIERÀ:', 'Valori non pubblici nascosti; + aggiunta, - rimozione, ~ modifica.'];
    for (const p of plan.changes) {
      const a = plan.before.get(p), b = plan.target.get(p);
      lines.push(`${a === undefined ? '+' : b === undefined ? '-' : '~'} ${p}${secret(p) ? ' [file privato: rimosso solo da GitHub]' : ''}`);
      if (p === 'settings.json') {
        const old = json(a), next = json(b);
        for (const key of new Set([...Object.keys(old), ...Object.keys(next)])) {
          if (same(old[key], next[key])) continue;
          if (key === 'packages' && (old[key] === undefined || Array.isArray(old[key])) && (next[key] === undefined || Array.isArray(next[key]))) {
            for (const item of old[key] || []) if (!(next[key] || []).some(x => same(x, item))) lines.push('  - packages: ' + packageLabel(item));
            for (const item of next[key] || []) if (!(old[key] || []).some(x => same(x, item))) lines.push('  + packages: ' + packageLabel(item));
          } else if (['theme', 'defaultProvider', 'defaultModel', 'defaultThinkingLevel', 'enabledModels'].includes(key)) lines.push(`  ~ ${key}: ${JSON.stringify(old[key])} → ${JSON.stringify(next[key])}`);
          else lines.push(`  ~ ${key} [valori nascosti]`);
        }
      } else if (!secret(p)) {
        if (p.endsWith('.json')) {
          try { lines.push(...jsonPaths(json(a), json(b))); } catch { lines.push('  JSON non interpretabile: contenuto nascosto.'); }
        }
        lines.push(`  ${a?.length || 0} → ${b?.length || 0} byte (contenuto nascosto per sicurezza)`);
      }
    }
    if (!plan.changes.length) lines.push('Nessuna modifica di contenuto.');
    lines.push('File privati e .syncignore restano locali. Nessun rebase o scarto automatico.');
    return lines.join('\n');
  }
  function backup(plan) {
    const dest = join(gitDir(), 'pi-sync-backups', new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID());
    mkdirSync(dest, { recursive: true, mode: 0o700 });
    for (const [p, b] of plan.work) {
      const full = join(dest, 'files', p); mkdirSync(dirname(full), { recursive: true, mode: 0o700 }); writeFileSync(full, b, { mode: 0o600 });
    }
    writeFileSync(join(dest, 'manifest.json'), JSON.stringify({ head: plan.head, remote: plan.remote, files: [...plan.work.keys()] }, null, 2), { mode: 0o600 });
    return dest;
  }
  function makeTree(files, head) {
    const temp = mkdtempSync(join(tmpdir(), 'pi-sync-index-'));
    const env = { ...process.env, GIT_INDEX_FILE: join(temp, 'index') };
    try {
      git(head ? ['read-tree', head] : ['read-tree', '--empty'], { env });
      const existing = new Set(git(['ls-files', '-z'], { env }).toString().split('\0').filter(Boolean));
      for (const p of existing) if (!files.has(p)) git(['update-index', '--force-remove', '--', p], { env });
      for (const [p, bytes] of files) {
        const oid = git(['hash-object', '-w', '--stdin'], { input: bytes }).toString().trim();
        const mode = existing.has(p) ? git(['ls-files', '--stage', '--', p], { env }).toString().slice(0, 6) : '100644';
        git(['update-index', '--add', '--cacheinfo', mode, oid, p], { env });
      }
      return textWithEnv(['write-tree'], env);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  }
  const textWithEnv = (args, env) => git(args, { env }).toString().trim();
  function apply(plan) {
    const lock = join(gitDir(), 'pi-sync.lock');
    const fd = openSync(lock, 'wx', 0o600);
    try {
      if (text(['symbolic-ref', '--short', 'HEAD']) !== 'main') throw new Error('Il branch è cambiato dopo l’anteprima. Ripeti il comando.');
      if (fingerprint(ref('HEAD'), working(plan.base)) !== plan.stamp) throw new Error('I file sono cambiati dopo l’anteprima. Ripeti il comando per confermare un nuovo diff.');
      const nowRemote = text(['ls-remote', 'origin', 'refs/heads/main']).split(/\s/)[0] || undefined;
      if (nowRemote !== plan.remote) throw new Error('GitHub è cambiato dopo l’anteprima. Ripeti il comando.');
      if (plan.direction === 'pull') for (const p of plan.changes) {
        safePath(p);
        if (plan.target.has(p) && existsSync(join(dir, p)) && !lstatSync(join(dir, p)).isFile()) throw new Error('Un percorso locale è cambiato dopo l’anteprima. Ripeti il comando.');
      }
      const saved = backup(plan);
      if (plan.direction === 'push') {
        const treeId = makeTree(plan.target, plan.head);
        const previousTree = plan.head && text(['rev-parse', `${plan.head}^{tree}`]);
        const commit = treeId === previousTree ? plan.head : text(['commit-tree', treeId, ...(plan.head ? ['-p', plan.head] : []), '-m', `sync: ${new Date().toISOString()}`]);
        // Ordinary push: Git itself rejects a concurrent remote update; never force.
        git(['push', 'origin', `${commit}:refs/heads/main`]);
        try {
          if (commit !== plan.head) git(['update-ref', 'refs/heads/main', commit, ...(plan.head ? [plan.head] : [])]);
          git(['read-tree', commit]); // Index only: never checkout local files.
        } catch {
          throw new Error(`Invio a GitHub riuscito, aggiornamento dei metadati locali fallito. Non ripetere il push alla cieca: controlla lo stato Git. File locali invariati. Backup: ${saved}`);
        }
      } else {
        // Writes are limited to the explicitly previewed paths. No clean/reset/checkout.
        let moved = false;
        try {
          for (const p of plan.changes) {
            safePath(p);
            const full = join(dir, p), bytes = plan.target.get(p);
            if (bytes === undefined) rmSync(full, { force: true });
            else { mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, bytes); }
          }
          git(['update-ref', 'refs/heads/main', plan.remote, ...(plan.head ? [plan.head] : [])]);
          moved = true;
          git(['read-tree', plan.remote]);
        } catch {
          try {
            for (const p of plan.changes) {
              const full = join(dir, p), bytes = plan.work.get(p);
              if (bytes === undefined) rmSync(full, { force: true });
              else { mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, bytes); }
            }
            if (moved) {
              if (plan.head) git(['update-ref', 'refs/heads/main', plan.head, plan.remote]);
              else git(['update-ref', '-d', 'refs/heads/main', plan.remote]);
              git(plan.head ? ['read-tree', plan.head] : ['read-tree', '--empty']);
            }
          } catch { throw new Error(`Pull fallito e ripristino incompleto. Fermati e recupera dal backup: ${saved}`); }
          throw new Error(`Pull fallito: file precedenti ripristinati. Backup: ${saved}`);
        }
      }
      return saved;
    } finally { closeSync(fd); rmSync(lock, { force: true }); }
  }
  return { prepare, preview, apply, git, text, localRules };
}
