import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, enc } from './fixture.mjs';
import { createSync } from '../sync-core.mjs';
import { runSync, runLocal, runIgnore } from '../commands.mjs';
import { runCli } from '../cli.mjs';

const read = dir => JSON.parse(readFileSync(join(dir, 'settings.json')));
const save = (dir, o) => writeFileSync(join(dir, 'settings.json'), enc(o));
const confirmedUI = { notify() {}, async review() { return true; }, async conflict() { throw new Error('Unexpected conflict'); } };

test('several pushes from the personal PC catch up on an old PC; unrelated local edits survive the round trip', async t => {
  const f = fixture(t), personal = createSync(f.b);
  save(f.a, { ...read(f.a), hideThinkingBlock: false });
  const cache = readFileSync(join(f.a, 'models-store.json'));
  for (let i = 1; i <= 4; i++) {
    save(f.b, { ...read(f.b), theme: `theme-${i}`, compaction: { enabled: true, keepRecentTokens: i * 100 }, packages: ['sync', `npm:tool-${i}`] });
    const plan = personal.prepare('push'); assert.equal(plan.conflicts.length, 0); personal.apply(plan);
  }
  const plan = f.sync.prepare('pull'); assert.equal(plan.conflicts.length, 0);
  assert.deepEqual(read(f.a), { ...f.original, hideThinkingBlock: false }); // preview is read-only
  f.sync.apply(plan);
  assert.equal(read(f.a).theme, 'theme-4'); assert.equal(read(f.a).hideThinkingBlock, false);
  assert.deepEqual(read(f.a).packages, ['sync', 'npm:tool-4']);
  assert.deepEqual(readFileSync(join(f.a, 'models-store.json')), cache);
  await runSync(f.sync, 'push', confirmedUI);
  await runSync(personal, 'pull', confirmedUI);
  assert.equal(read(f.b).hideThinkingBlock, false); assert.equal(read(f.b).theme, 'theme-4');
});

test('work-only boolean and package exclusions survive pulls and never replace shared settings', async t => {
  const f = fixture(t), personal = createSync(f.b);
  f.sync.apply(f.sync.prepareLocal('set', 'compaction.enabled', false));
  f.sync.apply(f.sync.prepareLocal('exclude-package', 'sync'));
  save(f.b, { ...read(f.b), theme: 'personal', compaction: { enabled: true, keepRecentTokens: 999 }, packages: ['sync', 'npm:new'] });
  await runSync(personal, 'push', confirmedUI);
  const incoming = f.sync.prepare('pull'); assert.equal(incoming.conflicts.length, 0);
  assert.match(f.sync.preview(incoming), /compaction.enabled/);
  f.sync.apply(incoming);
  assert.deepEqual(read(f.a).compaction, { enabled: false, keepRecentTokens: 999 });
  assert.deepEqual(read(f.a).packages, ['npm:new']);
  const localBytes = readFileSync(join(f.a, 'settings.json'));
  f.sync.apply(f.sync.prepare('push'));
  assert.deepEqual(readFileSync(join(f.a, 'settings.json')), localBytes);
  const shared = JSON.parse(f.git(f.a, 'show', 'HEAD:settings.json'));
  assert.equal(shared.compaction.enabled, true); assert.deepEqual(shared.packages, ['sync', 'npm:new']);
  f.sync.apply(f.sync.prepareLocal('unset', 'compaction.enabled'));
  f.sync.apply(f.sync.prepareLocal('include-package', 'sync'));
  assert.equal(read(f.a).compaction.enabled, true); assert.deepEqual(read(f.a).packages, ['sync', 'npm:new']);
});

test('an override remembers a shared edit not yet pushed and restores it when removed', t => {
  const f = fixture(t); save(f.a, { ...read(f.a), theme: 'unpushed-shared-choice' });
  const plan = f.sync.prepareLocal('set', 'theme', 'only-at-work');
  assert.equal(read(f.a).theme, 'unpushed-shared-choice');
  f.sync.apply(plan); assert.equal(read(f.a).theme, 'only-at-work');
  f.sync.apply(f.sync.prepare('push'));
  assert.equal(JSON.parse(f.git(f.a, 'show', 'HEAD:settings.json')).theme, 'unpushed-shared-choice');
  assert.equal(read(f.a).theme, 'only-at-work');
  f.sync.apply(f.sync.prepareLocal('unset', 'theme'));
  assert.equal(read(f.a).theme, 'unpushed-shared-choice');
});

test('conflicts are choices per field, final cancellation writes nothing, chosen result keeps other edits', async t => {
  const f = fixture(t), personal = createSync(f.b);
  save(f.a, { ...read(f.a), theme: 'work', hideThinkingBlock: true });
  save(f.b, { ...read(f.b), theme: 'home', quietStartup: true });
  await runSync(personal, 'push', confirmedUI);
  const before = readFileSync(join(f.a, 'settings.json')), head = f.git(f.a, 'rev-parse', 'HEAD');
  let prompts = 0;
  const cancel = { notify() {}, async conflict(view, c) { prompts++; assert.deepEqual(c.path, ['theme']); return 'remote'; }, async review(plan) { assert.equal(plan.conflicts.length, 0); return false; } };
  assert.equal(await runSync(f.sync, 'pull', cancel), false); assert.equal(prompts, 1);
  assert.deepEqual(readFileSync(join(f.a, 'settings.json')), before); assert.equal(f.git(f.a, 'rev-parse', 'HEAD'), head);
  await runSync(f.sync, 'pull', { ...confirmedUI, async conflict() { return 'remote'; } });
  assert.equal(read(f.a).theme, 'home'); assert.equal(read(f.a).hideThinkingBlock, true); assert.equal(read(f.a).quietStartup, true);
});

test('local cache changes do not invalidate an approved plan and never overwrite the other cache', t => {
  const f = fixture(t); save(f.a, { ...read(f.a), theme: 'new' });
  const plan = f.sync.prepare('push');
  writeFileSync(join(f.a, 'models-store.json'), 'CHANGED AUTOMATICALLY WHILE REVIEWING');
  f.sync.apply(plan);
  assert.equal(readFileSync(join(f.a, 'models-store.json'), 'utf8'), 'CHANGED AUTOMATICALLY WHILE REVIEWING');
  assert.equal(f.git(f.a, 'ls-tree', '--name-only', 'HEAD', 'models-store.json'), '');
});

test('manual local rule edits require local apply, which keeps the hidden shared value', t => {
  const f = fixture(t);
  f.sync.apply(f.sync.prepareLocal('set', 'theme', 'work'));
  const rules = JSON.parse(readFileSync(join(f.a, 'settings.local.json'))); rules.overrides.theme = 'new-work';
  writeFileSync(join(f.a, 'settings.local.json'), enc(rules));
  assert.throws(() => f.sync.prepare('push'), /local apply/);
  f.sync.apply(f.sync.prepareLocal('apply'));
  assert.equal(read(f.a).theme, 'new-work');
  f.sync.apply(f.sync.prepareLocal('unset', 'theme')); assert.equal(read(f.a).theme, 'old');
});

test('first manual generic override initialization preserves a not-yet-pushed shared value', t => {
  const f = fixture(t); save(f.a, { ...read(f.a), theme: 'not-yet-pushed' });
  writeFileSync(join(f.a, 'settings.local.json'), enc({ overrides: { theme: 'work' } }));
  assert.throws(() => f.sync.prepare('push'), /local apply/);
  f.sync.apply(f.sync.prepareLocal('apply'));
  f.sync.apply(f.sync.prepareLocal('unset', 'theme'));
  assert.equal(read(f.a).theme, 'not-yet-pushed');
});

test('local preview cancellation and a concurrent settings edit cannot silently change rules', async t => {
  const f = fixture(t), before = readFileSync(join(f.a, 'settings.json'));
  assert.equal(await runLocal(f.sync, ['set', 'theme', '"work"'], { ...confirmedUI, async review() { return false; } }), false);
  assert.deepEqual(readFileSync(join(f.a, 'settings.json')), before); assert.equal(existsSync(join(f.a, 'settings.local.json')), false);
  const plan = f.sync.prepareLocal('set', 'theme', 'work');
  save(f.a, { ...read(f.a), theme: 'changed-after-preview' });
  assert.throws(() => f.sync.apply(plan), /nuovo diff/);
  assert.equal(existsSync(join(f.a, 'settings.local.json')), false);
});

test('CLI and menu manage the same local settings and file exclusions without remote writes', async t => {
  const f = fixture(t), remoteBefore = f.git(f.remote, 'rev-parse', 'main');
  const queue = ['set', 'hideThinkingBlock', 'false'];
  const menu = { ...confirmedUI, async choose() { return queue.shift(); }, async input() { return queue.shift(); } };
  await runLocal(f.sync, [], menu);
  assert.equal(read(f.a).hideThinkingBlock, false);
  await runCli(['local', 'exclude-provider', 'deepseek'], { dir: f.a, ui: confirmedUI });
  await runCli(['local', 'fallback', 'defaultProvider', 'openai'], { dir: f.a, ui: confirmedUI });
  await runCli(['local', 'fallback', 'defaultModel', 'one'], { dir: f.a, ui: confirmedUI });
  assert.equal(read(f.a).defaultProvider, 'openai'); assert.deepEqual(read(f.a).enabledModels, ['openai/one']);
  await runCli(['ignore', 'add', 'keybindings.json'], { dir: f.a, ui: confirmedUI });
  assert.match(f.sync.ignorePatterns(), /keybindings.json/);
  await runIgnore(f.sync, ['remove', 'keybindings.json'], confirmedUI);
  assert.doesNotMatch(f.sync.ignorePatterns(), /keybindings.json/);
  assert.equal(f.git(f.remote, 'rev-parse', 'main'), remoteBefore);
});

test('models.json customizations still merge while models-store.json stays local', t => {
  const f = fixture(t);
  writeFileSync(join(f.a, 'models.json'), enc({ providers: { custom: { baseUrl: 'https://example.invalid', models: [] } } }));
  f.sync.apply(f.sync.prepare('push'));
  assert.ok(f.git(f.a, 'show', 'HEAD:models.json').includes('custom'));
  assert.equal(f.git(f.a, 'ls-tree', '--name-only', 'HEAD', 'models-store.json'), '');
});

test('invalid state fails safely and local-only edits need no remote connection', t => {
  const f = fixture(t); f.git(f.a, 'remote', 'remove', 'origin');
  f.sync.apply(f.sync.prepareLocal('set', 'theme', 'work')); assert.equal(read(f.a).theme, 'work');
  writeFileSync(join(f.a, '.git', 'pi-sync-local-state.json'), 'BROKEN PRIVATE DATA');
  assert.throws(() => f.sync.prepareLocal('unset', 'theme'), e => /Stato locale/.test(e.message) && !e.message.includes('PRIVATE'));
});

test('local overrides can be removed even if settings.json is untracked and gitignored', t => {
  const f = fixture(t); f.git(f.a, 'rm', '--cached', 'settings.json');
  writeFileSync(join(f.a, '.gitignore'), 'settings.json\n');
  f.git(f.a, 'add', '.gitignore'); f.git(f.a, 'commit', '-m', 'ignore local settings');
  save(f.a, { ...f.original, theme: 'important-untracked-value' });
  f.sync.apply(f.sync.prepareLocal('set', 'theme', 'work'));
  f.sync.apply(f.sync.prepareLocal('unset', 'theme'));
  assert.equal(read(f.a).theme, 'important-untracked-value');
});

test('automatic changelog version differences stay local and never become conflicts', t => {
  const f = fixture(t);
  save(f.a, { ...f.original, lastChangelogVersion: 'work-version', hideThinkingBlock: true });
  save(f.b, { ...f.original, lastChangelogVersion: 'personal-version', theme: 'new' });
  const personal = createSync(f.b); personal.apply(personal.prepare('push'));
  const plan = f.sync.prepare('pull'); assert.equal(plan.conflicts.length, 0); f.sync.apply(plan);
  assert.equal(read(f.a).lastChangelogVersion, 'work-version'); assert.equal(read(f.a).theme, 'new');
  f.sync.apply(f.sync.prepare('push'));
  assert.equal(JSON.parse(f.git(f.a, 'show', 'HEAD:settings.json')).lastChangelogVersion, undefined);
  assert.equal(read(f.a).lastChangelogVersion, 'work-version');
});

test('failed pull restores saved canonical values as well as settings before retrying', t => {
  const f = fixture(t); f.sync.apply(f.sync.prepareLocal('set', 'theme', 'work'));
  const statePath = join(f.a, '.git', 'pi-sync-local-state.json'), oldState = readFileSync(statePath), before = readFileSync(join(f.a, 'settings.json'));
  const personal = createSync(f.b); save(f.b, { ...read(f.b), theme: 'new-home', quietStartup: true }); personal.apply(personal.prepare('push'));
  const plan = f.sync.prepare('pull'); writeFileSync(join(f.a, '.git', 'index.lock'), 'simulate failure');
  assert.throws(() => f.sync.apply(plan), /backup/i);
  assert.deepEqual(readFileSync(statePath), oldState); assert.deepEqual(readFileSync(join(f.a, 'settings.json')), before);
  rmSync(join(f.a, '.git', 'index.lock'));
  f.sync.apply(f.sync.prepare('pull')); f.sync.apply(f.sync.prepareLocal('unset', 'theme'));
  assert.equal(read(f.a).theme, 'new-home');
});

test('new local-only settings work before any settings.json exists', t => {
  const f = fixture(t); f.git(f.a, 'rm', 'settings.json'); f.git(f.a, 'commit', '-m', 'no settings');
  f.sync.apply(f.sync.prepareLocal('set', 'theme', 'work'));
  assert.equal(read(f.a).theme, 'work');
  f.sync.apply(f.sync.prepareLocal('unset', 'theme'));
  assert.equal(existsSync(join(f.a, 'settings.json')), false);
});

test('nested mcp.json edits merge without touching either PC credentials', t => {
  const f = fixture(t);
  const common = { mcpServers: { first: { url: 'https://one.invalid', enabled: true }, second: { url: 'https://two.invalid', enabled: true } } };
  writeFileSync(join(f.a, 'mcp.json'), enc(common)); f.sync.apply(f.sync.prepare('push'));
  const personal = createSync(f.b); personal.apply(personal.prepare('pull'));
  const work = structuredClone(common); work.mcpServers.first.enabled = false; writeFileSync(join(f.a, 'mcp.json'), enc(work));
  const home = structuredClone(common); home.mcpServers.second.enabled = false; writeFileSync(join(f.b, 'mcp.json'), enc(home));
  personal.apply(personal.prepare('push'));
  const plan = f.sync.prepare('pull'); assert.equal(plan.conflicts.length, 0); f.sync.apply(plan);
  const result = JSON.parse(readFileSync(join(f.a, 'mcp.json')));
  assert.equal(result.mcpServers.first.enabled, false); assert.equal(result.mcpServers.second.enabled, false);
});

test('removing the shared settings file does not remove local-only overrides or recreate a shared file', t => {
  const f = fixture(t); f.sync.apply(f.sync.prepareLocal('set', 'theme', 'work'));
  f.git(f.b, 'rm', 'settings.json'); f.git(f.b, 'commit', '-m', 'remove shared settings'); f.git(f.b, 'push');
  const plan = f.sync.prepare('pull'); assert.equal(plan.conflicts.length, 0); f.sync.apply(plan);
  assert.deepEqual(read(f.a), { theme: 'work' });
  const outgoing = f.sync.prepare('push'); assert.equal(outgoing.target.has('settings.json'), false);
});

test('an external HEAD change cannot silently reuse stale hidden shared values', t => {
  const f = fixture(t); f.sync.apply(f.sync.prepareLocal('set', 'theme', 'work'));
  f.git(f.a, 'commit', '--allow-empty', '-m', 'external head change');
  assert.throws(() => f.sync.prepareLocal('unset', 'theme'), /HEAD è cambiato fuori/);
  assert.equal(read(f.a).theme, 'work');
});
