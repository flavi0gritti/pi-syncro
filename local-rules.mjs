import { MISSING, same, object, packageKey } from './merge.mjs';

export const localSettingFields = ['lastChangelogVersion'];
export function stripAutomaticSettings(value) {
  if (value === MISSING) return value;
  if (!object(value)) throw new Error('settings.json deve essere un oggetto.');
  const result = structuredClone(value);
  for (const key of localSettingFields) delete result[key];
  return result;
}

export function settingPath(name) {
  if (typeof name !== 'string' || !name) throw new Error('Specifica il nome dell’impostazione.');
  const parts = name.startsWith('/') ? name.slice(1).split('/').map(s => s.replace(/~1/g, '/').replace(/~0/g, '~')) : name.split('.');
  if (parts.some(p => !p || /[\x00-\x1f\x7f-\x9f]/.test(p) || ['__proto__', 'constructor', 'prototype'].includes(p))) throw new Error('Percorso di impostazione non valido.');
  return parts;
}
const own = (o, k) => object(o) && Object.hasOwn(o, k) ? o[k] : MISSING;
export function getAt(o, parts) { for (const p of parts) o = own(o, p); return o; }
export function putAt(o, parts, value) {
  const [key, ...rest] = parts;
  if (!rest.length) { if (value === MISSING) delete o[key]; else o[key] = structuredClone(value); return; }
  if (!object(o[key])) { if (value === MISSING) return; o[key] = {}; }
  putAt(o[key], rest, value);
  if (value === MISSING && !Object.keys(o[key]).length) delete o[key];
}
export function validateRules(rules) {
  if (!object(rules)) throw new Error('settings.local.json deve essere un oggetto.');
  const allowed = ['excludedProviders', 'defaultProvider', 'defaultModel', 'excludedPackages', 'overrides'];
  if (Object.keys(rules).some(k => !allowed.includes(k))) throw new Error('Campo non supportato in settings.local.json. Usa excludedProviders, defaultProvider, defaultModel, excludedPackages o overrides.');
  for (const k of ['excludedProviders', 'excludedPackages']) {
    if (rules[k] !== undefined && (!Array.isArray(rules[k]) || rules[k].some(s => typeof s !== 'string' || !s.trim() || /[\x00-\x1f\x7f-\x9f]/.test(s)) || new Set(rules[k]).size !== rules[k].length)) throw new Error(`${k} deve essere una lista di nomi unici.`);
  }
  for (const k of ['defaultProvider', 'defaultModel']) if (rules[k] !== undefined && (typeof rules[k] !== 'string' || /[\x00-\x1f\x7f-\x9f]/.test(rules[k]))) throw new Error(`${k} deve essere una stringa senza caratteri di controllo.`);
  if (rules.overrides !== undefined && !object(rules.overrides)) throw new Error('overrides deve essere un oggetto di impostazioni locali.');
  for (const [key, value] of Object.entries(rules.overrides || {})) {
    const parts = settingPath(key), name = parts.join('.');
    if (['theme', 'defaultProvider', 'defaultModel', 'defaultThinkingLevel'].includes(name) && typeof value !== 'string') throw new Error(`${name} richiede una stringa JSON.`);
    if (['hideThinkingBlock', 'showHardwareCursor', 'enableAnalytics', 'compaction.enabled', 'retry.enabled'].includes(name) && typeof value !== 'boolean') throw new Error(`${name} richiede true o false.`);
    if (name === 'enabledModels' && (!Array.isArray(value) || value.some(x => typeof x !== 'string'))) throw new Error('enabledModels richiede una lista di stringhe.');
    if (name === 'packages') { if (!Array.isArray(value)) throw new Error('packages richiede una lista.'); value.forEach(packageKey); }
  }
  const paths = Object.keys(rules.overrides || {}).map(settingPath);
  for (let i = 0; i < paths.length; i++) for (let j = i + 1; j < paths.length; j++) {
    const a = paths[i], b = paths[j];
    if (a.slice(0, Math.min(a.length, b.length)).every((s, k) => s === b[k])) throw new Error('Eccezioni sovrapposte: usa una sola regola per ogni impostazione.');
  }
  return rules;
}
export function parseRules(bytes) {
  if (bytes === undefined) return {};
  try { return validateRules(JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '').replace(/^\s*\/\/.*$/gm, ''))); }
  catch (e) { if (e instanceof SyntaxError) throw new Error('JSON non valido in settings.local.json; nessun file modificato.'); throw e; }
}
export function projectSettings(shared, rules) {
  if (shared === MISSING) return MISSING;
  const result = structuredClone(shared);
  if (!object(result)) throw new Error('settings.json deve essere un oggetto.');
  for (const [key, value] of Object.entries(rules.overrides || {})) putAt(result, settingPath(key), value);
  // Explicit exclusions win even over a local whole-list override.
  const excluded = rules.excludedProviders || [], provider = result.defaultProvider;
  if (excluded.includes(provider)) result.defaultProvider = rules.defaultProvider || '';
  if (excluded.includes(result.defaultModel?.includes('/') ? result.defaultModel.split('/')[0] : provider)) result.defaultModel = rules.defaultModel || '';
  if (Array.isArray(result.enabledModels)) result.enabledModels = result.enabledModels.filter(m => !excluded.includes(m.split('/')[0]));
  const blocked = new Set((rules.excludedPackages || []).map(packageKey));
  if (Array.isArray(result.packages)) result.packages = result.packages.filter(p => !blocked.has(packageKey(p)));
  return result;
}
function restoreHidden(current, reference, hidden, keyOf = x => x) {
  const result = current.filter(x => !hidden(x));
  for (let i = 0; i < reference.length; i++) {
    const item = reference[i]; if (!hidden(item)) continue;
    const next = reference.slice(i + 1).find(x => !hidden(x) && result.some(r => keyOf(r) === keyOf(x)));
    const at = next === undefined ? result.length : result.findIndex(x => keyOf(x) === keyOf(next));
    result.splice(at, 0, structuredClone(item));
  }
  return result;
}
// The saved shared values are needed when an override hides an unpushed edit.
// Without this small private state, removing an override could restore an obsolete HEAD.
export function sharedSettings(local, reference, rules) {
  if (local === MISSING) return MISSING;
  if (!object(local)) throw new Error('settings.json deve essere un oggetto.');
  const result = structuredClone(local), common = reference === MISSING ? {} : reference;
  const projected = projectSettings(common, rules);
  for (const key of Object.keys(rules.overrides || {})) putAt(result, settingPath(key), getAt(common, settingPath(key)));
  for (const key of ['defaultProvider', 'defaultModel']) {
    if (same(result[key], projected[key]) && !same(common[key], projected[key])) {
      if (Object.hasOwn(common, key)) result[key] = common[key]; else delete result[key];
    }
  }
  if (!Object.keys(rules.overrides || {}).some(k => settingPath(k)[0] === 'enabledModels') && Array.isArray(result.enabledModels) && Array.isArray(common.enabledModels)) {
    result.enabledModels = restoreHidden(result.enabledModels, common.enabledModels, m => (rules.excludedProviders || []).includes(m.split('/')[0]));
  }
  if (!Object.keys(rules.overrides || {}).some(k => settingPath(k)[0] === 'packages') && Array.isArray(result.packages) && Array.isArray(common.packages)) {
    const blocked = new Set((rules.excludedPackages || []).map(packageKey));
    result.packages = restoreHidden(result.packages, common.packages, p => blocked.has(packageKey(p)), packageKey);
  }
  return result;
}
export function changeRules(rules, action, key, value) {
  const next = structuredClone(rules);
  if (action === 'set') {
    settingPath(key); if (value === undefined) throw new Error('Specifica un valore JSON (per esempio false, 42 o "dark").');
    next.overrides = { ...next.overrides, [key]: value };
  } else if (action === 'unset') { settingPath(key); if (next.overrides) delete next.overrides[key]; }
  else if (action === 'fallback') {
    if (!['defaultProvider', 'defaultModel'].includes(key) || typeof value !== 'string') throw new Error('fallback richiede defaultProvider o defaultModel e un valore JSON stringa.');
    next[key] = value;
  } else if (['exclude-provider', 'include-provider', 'exclude-package', 'include-package'].includes(action)) {
    if (typeof key !== 'string' || !key.trim()) throw new Error('Specifica il provider o la sorgente del pacchetto.');
    const field = action.endsWith('provider') ? 'excludedProviders' : 'excludedPackages';
    const list = next[field] || [];
    const id = field === 'excludedPackages' ? packageKey : x => x;
    next[field] = action.startsWith('exclude') ? list.some(x => id(x) === id(key)) ? list : [...list, key] : list.filter(x => id(x) !== id(key));
  } else if (action !== 'apply') throw new Error('Azione local non valida.');
  return validateRules(next);
}
export function rulesNotes(rules) {
  return [
    ...(rules.excludedProviders || []).map(p => `Provider escluso solo qui: ${p}`),
    ...(rules.excludedPackages || []).map(p => `Pacchetto disattivato solo qui: ${p}`),
    ...Object.keys(rules.overrides || {}).map(k => `Impostazione forzata solo qui: ${k}`),
    ...['defaultProvider', 'defaultModel'].filter(k => rules[k]).map(k => `Fallback locale: ${k}`),
  ];
}
