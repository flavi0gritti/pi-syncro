import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, enc } from './fixture.mjs';
import { restoreRemotePackages, MISSING } from '../merge.mjs';
import { runSync } from '../commands.mjs';
import { materializePackages, runPackages } from '../packages.mjs';

const source = 'git:github.com/example/missing';
function sharedPackage(f) {
  writeFileSync(join(f.a, 'settings.json'), enc({ ...f.original, packages: ['sync', source] }));
  f.git(f.a, 'add', 'settings.json'); f.git(f.a, 'commit', '-m', 'shared package'); f.git(f.a, 'push');
  writeFileSync(join(f.a, 'settings.json'), enc(f.original));
}

test('unchanged remote package removed locally is restored by pull, then installed after confirmation', async t => {
  const f = fixture(t); sharedPackage(f);
  const installed = new Set(['sync']), calls = [];
  const sdk = {
    SettingsManager: { inMemory: x => x },
    DefaultPackageManager: class {
      getInstalledPath(s) { return installed.has(s) ? f.a : undefined; }
      async install(s) { calls.push(s); installed.add(s); }
    },
  };
  const ui = {
    notify() {}, choose: async () => 'install',
    review: async plan => {
      assert.equal(plan.conflicts.length, 0);
      assert.ok(plan.changes.includes('settings.json'));
      assert.deepEqual(JSON.parse(plan.target.get('settings.json')).packages, ['sync', source]);
      // Preview has not changed settings or installed anything.
      assert.deepEqual(JSON.parse(readFileSync(join(f.a, 'settings.json'))).packages, ['sync']);
      assert.deepEqual(calls, []);
      return true;
    },
  };
  ui.packages = () => runPackages(f.a, ui, dir => materializePackages(dir, sdk));
  assert.equal(await runSync(f.sync, 'pull', ui), true);
  assert.deepEqual(JSON.parse(readFileSync(join(f.a, 'settings.json'))).packages, ['sync', source]);
  assert.deepEqual(calls, [source]);
  assert.equal(f.sync.prepare('pull').changes.includes('settings.json'), false);
});

test('explicit machine exclusion still hides a remote package and push does not delete it remotely', t => {
  const f = fixture(t); sharedPackage(f);
  // Establish the exclusion through the supported, confirmed local flow.
  f.sync.apply(f.sync.prepareLocal('exclude-package', source));
  const pull = f.sync.prepare('pull');
  assert.deepEqual(JSON.parse(pull.target.get('settings.json')).packages, ['sync']);
  f.sync.apply(pull);
  const push = f.sync.prepare('push');
  assert.deepEqual(JSON.parse(push.target.get('settings.json')).packages, ['sync', source]);
});

test('remote restoration respects conflict choices, local extras and remote removals', () => {
  const remote = { packages: [source] };
  const local = { packages: ['npm:local-extra'] };
  assert.deepEqual(restoreRemotePackages(local, remote).value.packages, ['npm:local-extra', source]);
  assert.deepEqual(local.packages, ['npm:local-extra']);
  const id = JSON.stringify(['settings.json', 'packages', 'github.com/example/missing']);
  assert.deepEqual(restoreRemotePackages(local, remote, { resolutions: { [id]: 'local' } }).value, local);
  assert.deepEqual(restoreRemotePackages(local, remote, { conflicts: [{ id }] }).value, local);
  assert.deepEqual(restoreRemotePackages({ packages: [] }, { packages: [] }).value.packages, []);
  assert.equal(restoreRemotePackages(MISSING, remote).value, MISSING);
});
