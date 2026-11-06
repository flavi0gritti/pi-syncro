import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSync } from '../sync-core.mjs';
export const enc = o => JSON.stringify(o, null, 2) + '\n';
export function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const remote = join(root, 'remote.git'), a = join(root, 'a'), b = join(root, 'b');
  const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  mkdirSync(a); git(root, 'init', '--bare', remote); git(a, 'init', '-b', 'main');
  const identity = dir => { git(dir, 'config', 'user.name', 'Test'); git(dir, 'config', 'user.email', 'test@example.invalid'); git(dir, 'config', 'core.autocrlf', 'false'); };
  identity(a); git(a, 'remote', 'add', 'origin', remote);
  const original = { theme: 'old', packages: ['sync'], enabledModels: ['deepseek/one', 'openai/one'], defaultProvider: 'deepseek', defaultModel: 'one' };
  writeFileSync(join(a, 'settings.json'), enc(original));
  writeFileSync(join(a, 'models-store.json'), enc({ deepseek: { model: 1 }, openai: { model: 2 } }));
  git(a, 'add', '.'); git(a, 'commit', '-m', 'initial'); git(a, 'push', '-u', 'origin', 'main');
  git(root, '-c', 'core.autocrlf=false', 'clone', '-b', 'main', remote, b); identity(b);
  return { root, remote, a, b, git, original, sync: createSync(a) };
}
