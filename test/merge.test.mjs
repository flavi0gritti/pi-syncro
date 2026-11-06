import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeJson, mergeFile, MISSING, packageKey } from '../merge.mjs';
import { projectSettings, sharedSettings, changeRules, parseRules } from '../local-rules.mjs';

function merge(base, local, remote, resolutions = {}) {
  const conflicts = [];
  const value = mergeJson(base, local, remote, { conflicts, resolutions });
  return { value, conflicts };
}
test('old computer receives many remote settings while keeping unrelated local edits', () => {
  const base = { theme: 'old', compaction: { enabled: true, keepRecentTokens: 100 }, quietStartup: false };
  const local = { ...base, compaction: { ...base.compaction, enabled: false } };
  const remote = { theme: 'new', compaction: { ...base.compaction, keepRecentTokens: 200 }, quietStartup: true, outputPad: 1 };
  const result = merge(base, local, remote);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.value, { theme: 'new', compaction: { enabled: false, keepRecentTokens: 200 }, quietStartup: true, outputPad: 1 });
});
test('true scalar conflict resolves only the selected field', () => {
  const base = { theme: 'old', a: 1, b: 1 }, local = { theme: 'local', a: 2, b: 1 }, remote = { theme: 'remote', a: 1, b: 2 };
  const first = merge(base, local, remote);
  assert.equal(first.conflicts.length, 1); assert.deepEqual(first.conflicts[0].path, ['theme']);
  const result = merge(base, local, remote, { [first.conflicts[0].id]: 'remote' });
  assert.deepEqual(result.value, { theme: 'remote', a: 2, b: 2 }); assert.equal(result.conflicts.length, 0);
});
test('remote deletion is not resurrected by an old computer', () => {
  assert.deepEqual(merge({ theme: 'old', obsolete: true }, { theme: 'local', obsolete: true }, { theme: 'old' }).value, { theme: 'local' });
});
test('delete versus modify is a real conflict; missing and null differ', () => {
  const result = merge({ a: 1 }, {}, { a: null });
  assert.equal(result.conflicts[0].local, MISSING);
  assert.deepEqual(merge({ a: 1 }, {}, { a: null }, { [result.conflicts[0].id]: 'remote' }).value, { a: null });
});
test('independent package additions and deletions combine without restoring removed packages', () => {
  const base = { packages: ['npm:one', 'npm:remove'] };
  const local = { packages: ['npm:one', 'npm:remove', 'npm:local'] };
  const remote = { packages: ['npm:one', 'npm:remote'] };
  const result = merge(base, local, remote);
  assert.deepEqual(result.conflicts, []); assert.deepEqual(new Set(result.value.packages), new Set(['npm:one', 'npm:remote', 'npm:local']));
});
test('per-package options merge, but competing versions conflict', () => {
  const base = { packages: [{ source: 'npm:foo@1', extensions: ['a'], skills: [] }] };
  const local = { packages: [{ ...base.packages[0], source: 'npm:foo@2' }] };
  const remote = { packages: [{ ...base.packages[0], source: 'npm:foo@3' }] };
  assert.equal(merge(base, local, remote).conflicts.length, 1);
  assert.equal(packageKey('npm:@scope/foo@2'), 'npm:@scope/foo');
});
test('enabled model additions combine; other ordered arrays do not silently merge', () => {
  const result = merge({ enabledModels: ['a'], defaultTools: ['read'] }, { enabledModels: ['a', 'b'], defaultTools: ['read', 'bash'] }, { enabledModels: ['a', 'c'], defaultTools: ['read', 'edit'] });
  assert.deepEqual(new Set(result.value.enabledModels), new Set(['a', 'b', 'c']));
  assert.deepEqual(result.conflicts.map(c => c.path), [['defaultTools']]);
});
test('equal JSON with a different key order does not conflict', () => {
  const conflicts = [];
  const result = mergeFile('mcp.json', Buffer.from('{"a":1,"b":2}'), Buffer.from('{"b":2,"a":1}'), Buffer.from('{"a":1,"b":3}'), {}, conflicts);
  assert.equal(conflicts.length, 0); assert.deepEqual(JSON.parse(result), { a: 1, b: 3 });
});
test('legacy provider exclusions project locally without leaking to shared settings', () => {
  const common = { defaultProvider: 'deepseek', defaultModel: 'one', enabledModels: ['deepseek/one', 'openai/one'], theme: 'old' };
  const rules = { excludedProviders: ['deepseek'], defaultProvider: 'openai', defaultModel: 'fallback' };
  const local = projectSettings(common, rules);
  assert.equal(local.defaultProvider, 'openai'); assert.equal(local.defaultModel, 'fallback');
  local.theme = 'new';
  assert.deepEqual(sharedSettings(local, common, rules), { ...common, theme: 'new' });
});
test('local boolean, nested and package rules override incoming data, but not the shared copy', () => {
  const common = { theme: 'dark', compaction: { enabled: true }, packages: ['npm:a', 'npm:b'] };
  const rules = { overrides: { theme: 'light', 'compaction.enabled': false }, excludedPackages: ['npm:b'] };
  const local = projectSettings(common, rules);
  assert.deepEqual(local, { theme: 'light', compaction: { enabled: false }, packages: ['npm:a'] });
  assert.deepEqual(sharedSettings(local, common, rules), common);
});
test('absent shared override keys are removed from the outgoing copy', () => {
  assert.deepEqual(sharedSettings({ theme: 'local', a: 1 }, { a: 1 }, { overrides: { theme: 'local' } }), { a: 1 });
});
test('overlapping rules and unsafe paths fail closed', () => {
  assert.throws(() => changeRules({ overrides: { compaction: {} } }, 'set', 'compaction.enabled', false), /sovrapposte/);
  assert.throws(() => changeRules({}, 'set', '__proto__.polluted', true), /non valido/);
  assert.equal({}.polluted, undefined);
});
test('local file comments and URL strings are parsed without truncating strings', () => {
  const r = parseRules(Buffer.from('// comment\n{"overrides":{"httpProxy":"https://example.invalid"}}'));
  assert.equal(r.overrides.httpProxy, 'https://example.invalid');
  assert.throws(() => parseRules(Buffer.from('{ bad SECRET }')), e => !e.message.includes('SECRET'));
});
test('exclusions win over whole-list local overrides and package references normalize versions', () => {
  const rules = { excludedProviders: ['deepseek'], excludedPackages: ['git:github.com/u/tool@old'], overrides: { enabledModels: ['deepseek/one', 'openai/one'], packages: ['git:github.com/u/tool@feature/new', 'npm:safe'] } };
  const result = projectSettings({}, rules);
  assert.deepEqual(result.enabledModels, ['openai/one']); assert.deepEqual(result.packages, ['npm:safe']);
  assert.equal(packageKey('https://github.com/u/tool.git'), packageKey('git:github.com/u/tool@feature/new'));
});
test('JSON pointer paths support model IDs containing slashes and dots', () => {
  const rules = changeRules({}, 'set', '/modelThinkingLevels/openai~1model.v1', 'high');
  const shared = { modelThinkingLevels: { 'openai/model.v1': 'low' } };
  const local = projectSettings(shared, rules);
  assert.equal(local.modelThinkingLevels['openai/model.v1'], 'high'); assert.deepEqual(sharedSettings(local, shared, rules), shared);
});
test('common invalid setting types are rejected before changing files', () => {
  assert.throws(() => changeRules({}, 'set', 'theme', false), /stringa/);
  assert.throws(() => changeRules({}, 'set', 'compaction.enabled', 'false'), /true o false/);
});
