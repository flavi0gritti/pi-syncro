import { isDeepStrictEqual } from 'node:util';

export const MISSING = Symbol('missing');
export const same = (a, b) => isDeepStrictEqual(a, b);
export const object = v => v !== MISSING && v !== null && typeof v === 'object' && !Array.isArray(v);
export const encode = o => Buffer.from(JSON.stringify(o, null, 2) + '\n');
export const parse = b => b === undefined ? MISSING : JSON.parse(b.toString('utf8').replace(/^\uFEFF/, ''));
const own = (o, k) => Object.hasOwn(o, k) ? o[k] : MISSING;
const pointer = path => '/' + path.map(p => p.replace(/~/g, '~0').replace(/\//g, '~1')).join('/');

export function packageKey(item) {
  const source = typeof item === 'string' ? item : item?.source;
  if (typeof source !== 'string') throw new Error('Pacchetto senza source valido.');
  if (source.startsWith('npm:')) return source.replace(/(@[^/@]+)$/, '');
  if (source.startsWith('git:') || /^https:\/\//.test(source)) {
    let key = source.replace(/^git:/, '').replace(/^https:\/\//, '');
    const ref = key.indexOf('@', key.indexOf('/') + 1);
    if (ref !== -1) key = key.slice(0, ref);
    return key.replace(/\.git$/, '');
  }
  return source;
}

// JSON merge is recursive. Only packages/enabledModels are membership lists;
// ordered arrays (tools, argv, key bindings, etc.) remain atomic to avoid guesses.
export function mergeJson(base, local, remote, { file = 'settings.json', resolutions = {}, conflicts = [], path = [] } = {}) {
  const options = next => ({ file, resolutions, conflicts, path: next });
  if (same(local, remote) || same(base, remote)) return local;
  if (same(base, local)) return remote;
  if (object(local) && object(remote) && (object(base) || base === MISSING)) {
    const original = base === MISSING ? {} : base;
    return Object.fromEntries([...new Set([...Object.keys(original), ...Object.keys(local), ...Object.keys(remote)])].flatMap(key => {
      const value = mergeJson(own(original, key), own(local, key), own(remote, key), options([...path, key]));
      return value === MISSING ? [] : [[key, value]];
    }));
  }
  if (file === 'settings.json' && path.length === 1 && ['packages', 'enabledModels'].includes(path[0]) && [base, local, remote].every(Array.isArray)) {
    const keyOf = path[0] === 'packages' ? packageKey : item => {
      if (typeof item !== 'string') throw new Error('enabledModels deve contenere stringhe.');
      return item;
    };
    const index = list => {
      const map = new Map();
      for (const item of list) { const key = keyOf(item); if (map.has(key)) throw new Error(`Voci duplicate in ${path[0]}.`); map.set(key, item); }
      return map;
    };
    const b = index(base), l = index(local), r = index(remote);
    return [...new Set([...r.keys(), ...l.keys(), ...b.keys()])].flatMap(key => {
      const value = mergeJson(b.has(key) ? b.get(key) : MISSING, l.has(key) ? l.get(key) : MISSING, r.has(key) ? r.get(key) : MISSING, options([...path, key]));
      return value === MISSING ? [] : [value];
    });
  }
  const id = JSON.stringify([file, ...path]);
  if (resolutions[id] === 'local') return local;
  if (resolutions[id] === 'remote') return remote;
  conflicts.push({ id, file, path, label: `${file}:${pointer(path)}`, base, local, remote });
  return local; // Provisional only: apply refuses plans with unresolved conflicts.
}

// Pull must not silently keep a package removed only on this machine while it
// is still declared remotely. Persistent opt-outs belong in excludedPackages.
// Keep explicit conflict choices and locally added packages intact.
export function restoreRemotePackages(merged, remote, { resolutions = {}, conflicts = [] } = {}) {
  const result = { value: merged, restored: [] };
  if (!object(merged) || !object(remote) || !Array.isArray(remote.packages)) return result;
  if (merged.packages !== undefined && !Array.isArray(merged.packages)) return result;
  const blocked = path => resolutions[JSON.stringify(['settings.json', ...path])] === 'local'
    || conflicts.some(c => c.id === JSON.stringify(['settings.json', ...path]));
  if (blocked([]) || blocked(['packages'])) return result;
  const present = new Set((merged.packages || []).map(packageKey));
  for (const pkg of remote.packages) {
    const key = packageKey(pkg);
    if (present.has(key) || blocked(['packages', key])) continue;
    if (!result.restored.length) result.value = structuredClone(merged);
    (result.value.packages ||= []).push(structuredClone(pkg));
    result.restored.push(key); present.add(key);
  }
  return result;
}

export function normalized(bytes) {
  if (bytes && !bytes.includes(0) && Buffer.from(bytes.toString('utf8')).equals(bytes)) return Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n'));
  return bytes;
}
export function mergeFile(file, base, local, remote, resolutions, conflicts) {
  const equal = (a, b) => a === undefined ? b === undefined : b !== undefined && a.equals(b);
  base = normalized(base); local = normalized(local); remote = normalized(remote);
  if (equal(local, remote) || equal(base, remote)) return local;
  if (equal(base, local)) return remote;
  if (file.endsWith('.json')) {
    let b, l, r;
    try { b = parse(base); l = parse(local); r = parse(remote); }
    catch { throw new Error(`JSON non valido in ${file}; nessun file modificato.`); }
    const value = mergeJson(b, l, r, { file, resolutions, conflicts });
    return value === MISSING ? undefined : encode(value);
  }
  const id = JSON.stringify([file]);
  if (resolutions[id] === 'local') return local;
  if (resolutions[id] === 'remote') return remote;
  conflicts.push({ id, file, path: [], label: file, base: MISSING, local: local === undefined ? MISSING : '[file locale: contenuto nascosto]', remote: remote === undefined ? MISSING : '[file GitHub: contenuto nascosto]' });
  return local;
}
