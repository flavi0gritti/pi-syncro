import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runLocal, runSync, runIgnore, terminalUI } from '../commands.mjs';
import { MISSING } from '../merge.mjs';

function fake() {
  let calls = [];
  const plan = { direction: 'pull', conflicts: [], changes: ['settings.json'], before: new Map(), target: new Map(), head: 'old', remote: 'new' };
  const sync = {
    localRules: () => ({ excludedProviders: ['deepseek'], overrides: { theme: 'work' } }),
    prepare: () => plan,
    prepareLocal: (...args) => { calls.push(['prepareLocal', ...args]); return plan; },
    apply: () => { calls.push(['apply']); return 'private-backup'; },
    prepareIgnore: (...args) => { calls.push(['prepareIgnore', ...args]); return plan; },
    ignorePatterns: () => '*.local.json',
  };
  const ui = { notify() {}, async choose() { return undefined; }, async input() { return undefined; }, async review() { return false; } };
  return { sync, ui, plan, calls };
}
test('cancel at the local menu writes nothing and creates no template', async () => {
  const f = fake(); assert.equal(await runLocal(f.sync, [], f.ui), false); assert.deepEqual(f.calls, []);
});
test('cancel at the local value input does not prepare or apply a change', async () => {
  const f = fake(); f.ui.choose = async () => 'set';
  const inputs = ['theme', undefined]; f.ui.input = async () => inputs.shift();
  assert.equal(await runLocal(f.sync, [], f.ui), false); assert.deepEqual(f.calls, []);
});
test('confirmed generic false remains boolean false, not a truthy string', async () => {
  const f = fake(); f.ui.review = async () => true;
  await runLocal(f.sync, ['set', 'compaction.enabled', 'false'], f.ui);
  assert.deepEqual(f.calls, [['prepareLocal', 'set', 'compaction.enabled', false], ['apply']]);
});
test('malformed JSON value cannot prepare a change or expose its content', async () => {
  const f = fake();
  await assert.rejects(runLocal(f.sync, ['set', 'theme', 'SECRET_BAD_JSON'], f.ui), e => !e.message.includes('SECRET_BAD_JSON'));
  assert.deepEqual(f.calls, []);
});
test('show is read-only and redacts local sensitive values', async () => {
  const f = fake(); f.sync.localRules = () => ({ overrides: { apiKey: 'PRIVATE' } });
  let output; f.ui.notify = s => output = s;
  await runLocal(f.sync, ['show'], f.ui); assert.doesNotMatch(output, /PRIVATE/); assert.deepEqual(f.calls, []);
});
test('cancel during conflict resolution does not call final review or apply', async () => {
  const f = fake(); f.plan.conflicts = [{id:'x',file:'settings.json',path:['theme'],label:'theme',local:'work',remote:'home',base:MISSING}];
  f.ui.conflict = async () => undefined; f.ui.review = async () => { throw new Error('must not review'); };
  assert.equal(await runSync(f.sync, 'pull', f.ui), false); assert.deepEqual(f.calls, []);
});
test('final review cancellation still prevents apply after choosing a conflict', async () => {
  const f = fake(); f.plan.conflicts = [{id:'x',file:'settings.json',path:['theme'],label:'theme',local:'work',remote:'home',base:MISSING}];
  f.ui.conflict = async () => 'remote'; f.sync.resolve = (plan, choices) => { assert.deepEqual(choices, { x:'remote' }); return { ...plan, conflicts: [] }; };
  assert.equal(await runSync(f.sync, 'pull', f.ui), false); assert.deepEqual(f.calls, []);
});
test('file exclusions require confirmation in the same flow', async () => {
  const f = fake(); await runIgnore(f.sync, ['add', 'keybindings.json'], f.ui);
  assert.deepEqual(f.calls, [['prepareIgnore', 'add', 'keybindings.json']]);
});
test('terminal menu empty/invalid answers cancel; confirmation defaults to no', async () => {
  const answers = ['', '999', 'no']; const ui = terminalUI(async () => answers.shift(), () => {});
  assert.equal(await ui.choose('test', [{label:'one',value:'one'}]), undefined);
  assert.equal(await ui.choose('test', [{label:'one',value:'one'}]), undefined);
  assert.equal(await ui.review({direction:'local',changes:[],before:new Map(),target:new Map()}), false);
});
