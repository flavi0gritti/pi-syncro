import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSync } from '../sync-core.mjs';

const enc = o => JSON.stringify(o, null, 2) + '\n';
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const remote = join(root, 'remote.git'), a = join(root, 'a'), b = join(root, 'b');
  const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  mkdirSync(a);
  git(root, 'init', '--bare', remote);
  git(a, 'init', '-b', 'main');
  const identity = dir => { git(dir, 'config', 'user.name', 'Test'); git(dir, 'config', 'user.email', 'test@example.invalid'); git(dir, 'config', 'core.autocrlf', 'false'); };
  identity(a);
  git(a, 'remote', 'add', 'origin', remote);
  const original = { theme: 'old', packages: ['sync'], enabledModels: ['deepseek/one', 'openai/one'], defaultProvider: 'deepseek', defaultModel: 'one' };
  writeFileSync(join(a, 'settings.json'), enc(original));
  writeFileSync(join(a, 'models-store.json'), enc({ deepseek: { model: 1 }, openai: { model: 2 } }));
  git(a, 'add', '.'); git(a, 'commit', '-m', 'initial'); git(a, 'push', '-u', 'origin', 'main');
  git(root, '-c', 'core.autocrlf=false', 'clone', '-b', 'main', remote, b); identity(b);
  return { root, remote, a, b, git, original, sync: createSync(a) };
}
function localOverlay(f) {
  writeFileSync(join(f.a, 'settings.local.json'), enc({ excludedProviders: ['deepseek'], defaultProvider: 'openai', defaultModel: 'one' }));
  writeFileSync(join(f.a, 'settings.json'), enc({ ...f.original, theme: 'system', packages: ['sync', 'git:github.com/test/picker', 'git:github.com/test/cc-tools'], enabledModels: ['openai/one'], defaultProvider: 'openai' }));
  writeFileSync(join(f.a, 'models-store.json'), enc({ openai: { model: 2 } }));
}

test('push keeps local bytes and synchronizes packages/theme while preserving excluded remote providers', t => {
  const f = fixture(t); localOverlay(f);
  const before = readFileSync(join(f.a, 'settings.json'));
  const plan = f.sync.prepare('push'), report = f.sync.preview(plan);
  assert.match(report, /picker/); assert.match(report, /cc-tools/); assert.match(report, /system/);
  assert.deepEqual(readFileSync(join(f.a, 'settings.json')), before); // preview/cancel is read-only
  const backup = f.sync.apply(plan);
  assert.ok(existsSync(join(backup, 'manifest.json')));
  assert.deepEqual(readFileSync(join(f.a, 'settings.json')), before);
  assert.deepEqual(JSON.parse(f.git(f.a, 'show', 'HEAD:settings.json')).packages, ['sync', 'git:github.com/test/picker', 'git:github.com/test/cc-tools']);
  assert.ok(JSON.parse(f.git(f.a, 'show', 'HEAD:settings.json')).enabledModels.includes('deepseek/one'));
  assert.equal(f.git(f.a, 'ls-tree', '--name-only', 'HEAD', 'settings.local.json'), '');
});

test('push with remote updates stops without resetting local files or HEAD', t => {
  const f = fixture(t); localOverlay(f);
  const head = f.git(f.a, 'rev-parse', 'HEAD'), before = readFileSync(join(f.a, 'settings.json'));
  writeFileSync(join(f.b, 'remote.txt'), 'remote'); f.git(f.b, 'add', '.'); f.git(f.b, 'commit', '-m', 'remote'); f.git(f.b, 'push');
  assert.throws(() => f.sync.prepare('push'), /nessun rebase/);
  assert.equal(f.git(f.a, 'rev-parse', 'HEAD'), head);
  assert.deepEqual(readFileSync(join(f.a, 'settings.json')), before);
});

test('pull previews additions/removals, preserves unrelated local changes and secrets', t => {
  const f = fixture(t); localOverlay(f);
  writeFileSync(join(f.a, 'auth.json'), 'SECRET');
  writeFileSync(join(f.b, 'new.txt'), 'new'); f.git(f.b, 'rm', 'models-store.json'); f.git(f.b, 'add', '.'); f.git(f.b, 'commit', '-m', 'remote'); f.git(f.b, 'push');
  const before = readFileSync(join(f.a, 'settings.json'));
  const plan = f.sync.prepare('pull');
  assert.match(f.sync.preview(plan), /\+ new.txt/);
  assert.match(f.sync.preview(plan), /- models-store.json/);
  assert.equal(existsSync(join(f.a, 'new.txt')), false);
  f.sync.apply(plan);
  assert.deepEqual(readFileSync(join(f.a, 'settings.json')), before);
  assert.equal(readFileSync(join(f.a, 'auth.json'), 'utf8'), 'SECRET');
  assert.equal(readFileSync(join(f.a, 'new.txt'), 'utf8'), 'new');
});

test('pull refuses overlapping local/remote edits, without deleting anything', t => {
  const f = fixture(t); localOverlay(f);
  writeFileSync(join(f.b, 'settings.json'), enc({ ...f.original, theme: 'remote' }));
  f.git(f.b, 'add', '.'); f.git(f.b, 'commit', '-m', 'remote'); f.git(f.b, 'push');
  const before = readFileSync(join(f.a, 'settings.json'));
  assert.throws(() => f.sync.prepare('pull'), /stessi file/);
  assert.deepEqual(readFileSync(join(f.a, 'settings.json')), before);
});

test('pull applies provider overlay to incoming settings without exposing private files', t => {
  const f = fixture(t);
  writeFileSync(join(f.a, 'settings.local.json'), enc({ excludedProviders: ['deepseek'], defaultProvider: 'openai', defaultModel: 'one' }));
  writeFileSync(join(f.a, 'settings.json'), enc({ ...f.original, enabledModels: ['openai/one'], defaultProvider: 'openai' }));
  writeFileSync(join(f.b, 'settings.json'), enc({ ...f.original, theme: 'remote', packages: ['sync', 'new'] }));
  writeFileSync(join(f.b, 'auth.json'), 'DO_NOT_PRINT');
  f.git(f.b, 'add', '.'); f.git(f.b, 'commit', '-m', 'remote'); f.git(f.b, 'push');
  const plan = f.sync.prepare('pull'); assert.doesNotMatch(f.sync.preview(plan), /DO_NOT_PRINT/);
  f.sync.apply(plan);
  const result = JSON.parse(readFileSync(join(f.a, 'settings.json')));
  assert.equal(result.theme, 'remote'); assert.equal(result.defaultProvider, 'openai');
  assert.deepEqual(result.enabledModels, ['openai/one']);
  assert.equal(existsSync(join(f.a, 'auth.json')), false);
});

test('file changes after approval invalidate plan', t => {
  const f = fixture(t); const plan = f.sync.prepare('push');
  writeFileSync(join(f.a, 'settings.json'), enc({ theme: 'newer' }));
  assert.throws(() => f.sync.apply(plan), /nuovo diff/);
  assert.equal(JSON.parse(readFileSync(join(f.a, 'settings.json'))).theme, 'newer');
});

test('remote changes after approval invalidate plan', t => {
  const f = fixture(t); const plan = f.sync.prepare('push');
  writeFileSync(join(f.b, 'new.txt'), 'new'); f.git(f.b, 'add', '.'); f.git(f.b, 'commit', '-m', 'race'); f.git(f.b, 'push');
  assert.throws(() => f.sync.apply(plan), /GitHub è cambiato/);
});

test('syncignore preserves local and remote file independently', t => {
  const f = fixture(t);
  writeFileSync(join(f.a, '.syncignore'), 'models-store.json\n');
  writeFileSync(join(f.a, 'models-store.json'), 'LOCAL');
  const plan = f.sync.prepare('push'); f.sync.apply(plan);
  assert.equal(readFileSync(join(f.a, 'models-store.json'), 'utf8'), 'LOCAL');
  assert.notEqual(f.git(f.a, 'show', 'HEAD:models-store.json'), 'LOCAL');
});

test('CRLF checkout is not treated as a conflicting settings edit', t => {
  const f = fixture(t);
  writeFileSync(join(f.a, 'settings.json'), enc(f.original).replace(/\n/g, '\r\n'));
  writeFileSync(join(f.b, 'settings.json'), enc({ ...f.original, theme: 'new' }));
  f.git(f.b, 'add', '.'); f.git(f.b, 'commit', '-m', 'remote'); f.git(f.b, 'push');
  const plan = f.sync.prepare('pull'); f.sync.apply(plan);
  assert.equal(JSON.parse(readFileSync(join(f.a, 'settings.json'))).theme, 'new');
});

test('private untracked files never enter push tree or preview values', t => {
  const f = fixture(t);
  writeFileSync(join(f.a, 'mcp-auth.json'), 'VERY_PRIVATE');
  const plan = f.sync.prepare('push');
  assert.doesNotMatch(f.sync.preview(plan), /VERY_PRIVATE/);
  assert.ok(!plan.target.has('mcp-auth.json'));
  f.sync.apply(plan);
  assert.equal(f.git(f.a, 'ls-tree', '--name-only', 'HEAD', 'mcp-auth.json'), '');
  assert.equal(readFileSync(join(f.a, 'mcp-auth.json'), 'utf8'), 'VERY_PRIVATE');
});

test('inline JSON credentials block push without displaying their values', t => {
  const f = fixture(t);
  writeFileSync(join(f.a, 'mcp.json'), enc({ mcpServers: { test: { headers: { Authorization: 'VERY_PRIVATE' } } } }));
  assert.throws(() => f.sync.prepare('push'), error => /credenziali inline/.test(error.message) && !error.message.includes('VERY_PRIVATE'));
});

test('unpublished private commit blocks push even if a later tree removes it', t => {
  const f = fixture(t);
  writeFileSync(join(f.a, 'auth.json'), 'PRIVATE'); f.git(f.a, 'add', 'auth.json'); f.git(f.a, 'commit', '-m', 'oops');
  f.git(f.a, 'rm', 'auth.json'); f.git(f.a, 'commit', '-m', 'remove');
  assert.throws(() => f.sync.prepare('push'), /cronologia/);
});

test('staged changes block sync without changing the index', t => {
  const f = fixture(t);
  writeFileSync(join(f.a, 'new.txt'), 'local'); f.git(f.a, 'add', 'new.txt');
  const before = f.git(f.a, 'ls-files', '--stage');
  assert.throws(() => f.sync.prepare('push'), /stage/);
  assert.equal(f.git(f.a, 'ls-files', '--stage'), before);
});

test('pull failure restores file bytes and HEAD from before the operation', t => {
  const f = fixture(t);
  writeFileSync(join(f.b, 'settings.json'), enc({ ...f.original, theme: 'remote' }));
  f.git(f.b, 'add', '.'); f.git(f.b, 'commit', '-m', 'remote'); f.git(f.b, 'push');
  const before = readFileSync(join(f.a, 'settings.json')), head = f.git(f.a, 'rev-parse', 'HEAD');
  const plan = f.sync.prepare('pull');
  writeFileSync(join(f.a, '.git', 'index.lock'), 'simulate external Git lock');
  assert.throws(() => f.sync.apply(plan), /Backup|backup/);
  assert.deepEqual(readFileSync(join(f.a, 'settings.json')), before);
  assert.equal(f.git(f.a, 'rev-parse', 'HEAD'), head);
});

test('failed push leaves local files and HEAD intact', t => {
  const f = fixture(t); localOverlay(f); const plan = f.sync.prepare('push');
  const head = f.git(f.a, 'rev-parse', 'HEAD'), before = readFileSync(join(f.a, 'settings.json'));
  const hook = join(f.remote, 'hooks', 'pre-receive');
  writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  chmodSync(hook, 0o755);
  assert.throws(() => f.sync.apply(plan));
  assert.equal(f.git(f.a, 'rev-parse', 'HEAD'), head);
  assert.deepEqual(readFileSync(join(f.a, 'settings.json')), before);
});
