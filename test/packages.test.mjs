import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runPackages, materializePackages, updatePackages } from '../packages.mjs';
import { runSync } from '../commands.mjs';

function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-packages-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  return dir;
}
function ui(choice = 'install') {
  const messages = [];
  return { messages, choose: async () => choice, notify: s => messages.push(s) };
}
test('declining package installation never starts a process', async () => {
  let called = false; const view = ui(undefined); view.choose = async () => undefined;
  assert.equal(await runPackages('/unused', view, async () => { called = true; }), false);
  assert.equal(called, false); assert.match(view.messages.join('\n'), /sync packages/);
});
test('installer errors preserve successful pull and never reveal output', async () => {
  const view = ui();
  assert.equal(await runPackages('/unused', view, async () => { throw new Error('PRIVATE'); }), false);
  assert.doesNotMatch(view.messages.join('\n'), /PRIVATE/);
  assert.match(view.messages.join('\n'), /pull resta valido/);
});
test('materialization uses accepted global packages including pins and object filters without writing settings', async t => {
  const dir = temp(t);
  const packages = ['git:github.com/example/tool@v1', { source: 'npm:@example/tool@1.2.3', extensions: [] }];
  const bytes = JSON.stringify({ packages, theme: 'dark' });
  writeFileSync(join(dir, 'settings.json'), bytes);
  let resolved = false;
  const sdk = {
    SettingsManager: { inMemory: settings => { assert.deepEqual(settings, { packages }); return settings; } },
    DefaultPackageManager: class {
      constructor(options) { assert.equal(options.agentDir, dir); assert.equal(options.cwd, dir); }
      async resolve(onMissing) { assert.equal(await onMissing(packages[0]), 'install'); resolved = true; }
      getInstalledPath(source, scope) { assert.equal(scope, 'user'); assert.ok(packages.some(p => (p.source || p) === source)); return dir; }
    },
  };
  await materializePackages(dir, sdk);
  assert.ok(resolved); assert.equal(readFileSync(join(dir, 'settings.json'), 'utf8'), bytes);
});
test('missing local paths are not reported as installed', async t => {
  const dir = temp(t); writeFileSync(join(dir, 'settings.json'), JSON.stringify({ packages: ['./missing'] }));
  const sdk = { SettingsManager: { inMemory: x => x }, DefaultPackageManager: class { async resolve() {} getInstalledPath() { return undefined; } } };
  await assert.rejects(materializePackages(dir, sdk), /mancante/);
});
test('worker completes without shell and timeout returns a retryable failure', async t => {
  const dir = temp(t); writeFileSync(join(dir, 'settings.json'), '{"packages":[]}');
  const sdkFile = join(dir, 'sdk.mjs');
  writeFileSync(sdkFile, 'export const SettingsManager = {inMemory: x=>x}; export class DefaultPackageManager {async resolve() {}}');
  assert.equal(await updatePackages(dir, { sdkURL: pathToFileURL(sdkFile).href, timeout: 5000 }), true);
  writeFileSync(sdkFile, 'export const SettingsManager = {inMemory: x=>x}; export class DefaultPackageManager {async resolve() {await new Promise(r=>setTimeout(r,60000))}}');
  assert.equal(await updatePackages(dir, { sdkURL: pathToFileURL(sdkFile).href, timeout: 300 }), false);
  // Windows taskkill is asynchronous; avoid removing a running worker's directory immediately.
  await new Promise(r => setTimeout(r, 500));
});
test('pull reconciles after apply and on no-op, never on push or cancellation', async () => {
  const plan = { conflicts: [], changes: ['settings.json'], head: 'a', remote: 'b' };
  const calls = [];
  const sync = { prepare: () => plan, apply: () => { calls.push('apply'); return 'backup'; } };
  const view = { notify() {}, review: async () => true, packages: async () => calls.push('packages') };
  await runSync(sync, 'pull', view); assert.deepEqual(calls.splice(0), ['apply', 'packages']);
  await runSync(sync, 'push', view); assert.deepEqual(calls.splice(0), ['apply']);
  view.review = async () => false;
  await runSync(sync, 'pull', view); assert.deepEqual(calls, []);
  plan.changes = []; plan.remote = plan.head;
  await runSync(sync, 'pull', view); assert.deepEqual(calls, ['packages']);
});
