import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Use the installed host, just as Pi does; do not substitute a TS transpiler.
const require = createRequire(import.meta.url);
let host;
try { host = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')); }
catch {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const globalRoot = execFileSync(npm, ['root', '-g'], { encoding: 'utf8', shell: process.platform === 'win32' }).trim();
  host = join(globalRoot, '@earendil-works/pi-coding-agent/dist/index.js');
}
const { discoverAndLoadExtensions } = await import(pathToFileURL(host).href);
const root = fileURLToPath(new URL('..', import.meta.url));

test('installed package through real Pi loader: /sync opens native menu and cancellation is clean', async t => {
  const temp = mkdtempSync(join(tmpdir(), 'pi-sync-real-loader-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const loaded = await discoverAndLoadExtensions([root], temp, temp);
  assert.deepEqual(loaded.errors, []);
  const menus = [], notices = [];
  await loaded.extensions[0].commands.get('sync').handler('', {
    hasUI: true, mode: 'tui', ui: {
      select: async (title, labels) => { menus.push({ title, labels }); return undefined; },
      notify: (...args) => notices.push(args),
    },
  });
  assert.equal(menus.length, 1);
  assert.equal(menus[0].labels.length, 7);
  assert.match(menus[0].labels[0], /^Push/);
  assert.deepEqual(notices, []);
});

test('real Pi loader: main menu and nested menus work with an already cached OLD commands.mjs', async t => {
  const temp = mkdtempSync(join(tmpdir(), 'pi-sync-loader-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  cpSync(join(root, 'extensions'), join(temp, 'extensions'), { recursive: true });
  writeFileSync(join(temp, 'package.json'), JSON.stringify({ type: 'module', pi: { extensions: ['./extensions/pisync.ts'] } }));
  // Isolate Git, disk mutations and package installation. Keep the real entrypoint,
  // selector, diff renderer and Pi loader. The old module deliberately has NO selector.
  writeFileSync(join(temp, 'sync-core.mjs'), `export function createSync() { return { text: args => 'git:' + args.join(' ') }; }`);
  writeFileSync(join(temp, 'diff-view.mjs'), `export const buildDiffFiles = () => []; export const redact = x => x;`);
  writeFileSync(join(temp, 'packages.mjs'), `export const runPackages = async (dir, ui) => ui.notify('route:packages');`);
  const commandsFile = join(temp, 'commands.mjs');
  const oldCommands = `
export const runSync = async (sync, direction, ui) => ui.notify('route:' + direction);
export const runLocal = async (sync, args, ui) => { ui.notify('route:local'); await ui.choose('Nested local', [{ label: 'Show', value: 'show' }]); };
export const runIgnore = async (sync, args, ui) => ui.notify('route:ignore');
`;
  writeFileSync(commandsFile, oldCommands);
  assert.equal(require(commandsFile).selectChoice, undefined);
  // Reproduce an on-disk update after Node cached the old native ESM module.
  writeFileSync(commandsFile, oldCommands + '\nexport const selectChoice = () => { throw new Error("must not use native helper"); };');
  for (let reload = 0; reload < 2; reload++) {
    const loaded = await discoverAndLoadExtensions([temp], resolve(temp), join(temp, 'empty-agent'));
    assert.deepEqual(loaded.errors, []);
    const handler = loaded.extensions[0].commands.get('sync').handler;
    assert.equal(typeof handler, 'function');
    for (const [index, expected] of ['route:push', 'route:pull', 'route:local', 'route:packages', 'git:status --short --branch', 'git:log -20 --oneline', 'route:ignore'].entries()) {
      const menus = [], notices = [];
      await handler('  ', { hasUI: true, mode: 'tui', ui: {
        select: async (title, options) => { menus.push({ title, options }); return options[menus.length === 1 ? index : 0]; },
        notify: (message, type) => notices.push({ message, type }),
      } });
      assert.equal(menus[0].title, 'Sync · scegli operazione');
      assert.equal(menus[0].options.length, 7);
      assert.equal(new Set(menus[0].options).size, 7);
      assert.ok(notices.some(n => n.message === expected), JSON.stringify(notices));
      assert.equal(menus.length, index === 2 ? 2 : 1);
      assert.ok(notices.every(n => n.type !== 'error'));
    }
    for (const answer of [undefined, 'unknown']) {
      const notices = [];
      await handler('', { hasUI: true, mode: 'tui', ui: { select: async () => answer, notify: (...a) => notices.push(a) } });
      assert.deepEqual(notices, []);
    }
    const errors = [];
    await handler('', { hasUI: true, mode: 'tui', ui: { select: async () => { throw new Error('menu unavailable'); }, notify: (...a) => errors.push(a) } });
    assert.deepEqual(errors, [['menu unavailable', 'error']]);
    const warnings = [];
    await handler('', { hasUI: false, mode: 'json', ui: { select: async () => assert.fail('must not open'), notify: (...a) => warnings.push(a) } });
    assert.equal(warnings[0][1], 'warning');
    const direct = [];
    await handler('  push  ', { hasUI: true, mode: 'tui', ui: { select: async () => assert.fail('direct route must skip menu'), notify: (...a) => direct.push(a) } });
    assert.deepEqual(direct, [['route:push', 'info']]);
  }
});
