import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MISSING, encode } from './merge.mjs';

const sensitive = /api[_-]?key|authorization|password|passwd|token|secret|credential|private[_-]?key|cookie/i;
export function redact(value, key = '') {
  if (sensitive.test(key)) return '[nascosto]';
  if (Array.isArray(value)) return value.map(item => redact(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)]));
  if (typeof value === 'string') return value.replace(/https?:\/\/[^\s]+/g, '[URL nascosto]');
  return value;
}
function printable(path, bytes, privateFile, localText = false) {
  if (bytes === undefined) return '';
  if (privateFile) return '[file privato o automatico: resta locale; contenuto nascosto]\n';
  if (localText) return redact(bytes.toString('utf8')).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
  if (path.endsWith('.json')) {
    try { return JSON.stringify(redact(JSON.parse(bytes.toString('utf8'))), null, 2) + '\n'; } catch { /* fail closed */ }
  }
  return `[contenuto non JSON nascosto: ${bytes.length} byte]\n`;
}

// Only the reviewed remote tree and the actual outgoing tree are compared.
// JSON is pretty-printed for readability; credentials and other file content stay hidden.
export function buildDiffFiles(plan) {
  const temp = mkdtempSync(join(tmpdir(), 'pi-sync-diff-'));
  try {
    return plan.changes.map(path => {
      const oldBytes = plan.before.get(path), newBytes = plan.target.get(path);
      const privateFile = plan.direction !== 'local' && (plan.privatePaths?.includes(path) || /auth|secret|credential|token|\.env|\.local\.|syncignore/i.test(path));
      const localText = plan.direction === 'local' && path === '.syncignore';
      const oldText = printable(path, oldBytes, privateFile, localText), newText = printable(path, newBytes, privateFile, localText);
      const oldPath = join(temp, 'old'), newPath = join(temp, 'new');
      writeFileSync(oldPath, oldText, { mode: 0o600 }); writeFileSync(newPath, newText, { mode: 0o600 });
      let patch;
      try {
        patch = execFileSync('git', ['-c', 'core.autocrlf=false', 'diff', '--no-index', '--no-ext-diff', '--no-textconv', '--no-color', '--unified=2', '--', oldPath, newPath], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
      } catch (error) { if (error.status !== 1) throw error; patch = error.stdout; }
      const rows = [];
      let oldLine = 0, newLine = 0, inHunk = false;
      for (const line of patch.split('\n')) {
        const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); inHunk = true; rows.push({ kind: 'hunk', text: '…' }); continue; }
        if (!inHunk) continue;
        if (line.startsWith('-')) rows.push({ kind: 'del', text: line.slice(1), oldLine: oldLine++ });
        else if (line.startsWith('+')) rows.push({ kind: 'add', text: line.slice(1), newLine: newLine++ });
        else if (line.startsWith(' ')) rows.push({ kind: 'context', text: line.slice(1), oldLine: oldLine++, newLine: newLine++ });
      }
      if (!rows.some(r => r.kind === 'add' || r.kind === 'del')) {
        if (oldBytes !== undefined) rows.push({ kind: 'del', text: '[versione precedente: differenza di formato o contenuto nascosto]' });
        if (newBytes !== undefined) rows.push({ kind: 'add', text: '[nuova versione: differenza di formato o contenuto nascosto]' });
      }
      return { path, rows };
    });
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

export function formatDiff(plan, files = buildDiffFiles(plan)) {
  const lines = [plan.heading || (plan.direction === 'push' ? 'GitHub → versione da inviare' : plan.direction === 'local' ? 'Eccezioni di questo PC — non inviate a GitHub' : 'Questo PC → versione da scaricare')];
  if (plan.notes?.length) lines.push('', ...plan.notes.map(note => `  ${redact(note)}`));
  for (const file of files) {
    lines.push('', `${!plan.before.has(file.path) ? '+ ' : !plan.target.has(file.path) ? '- ' : ''}${file.path}`);
    for (const row of file.rows) lines.push(`${row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '} ${row.text}`);
  }
  if (!files.length) lines.push('Nessuna differenza.');
  return lines.join('\n');
}

export function conflictView(conflict) {
  const path = conflict.file.endsWith('.json') ? conflict.file : conflict.file + ' (scelta).json';
  const key = conflict.path.join('.') || 'documento';
  const side = value => value === MISSING ? new Map() : new Map([[path, encode({ [key]: redact(value, key) })]]);
  return { direction: 'conflict', heading: `Conflitto: ${conflict.label}`, before: side(conflict.local), target: side(conflict.remote), changes: [path], notes: ['Sinistra: scelta di questo PC. Destra: scelta di GitHub. Nessun file viene modificato in questa schermata.'] };
}

// Group adjacent removed/added lines into the old/new columns of the same block.
export function sideBySideRows(rows) {
  const result = [];
  for (let i = 0; i < rows.length;) {
    if (rows[i].kind === 'add' || rows[i].kind === 'del') {
      const old = [], next = [];
      while (i < rows.length && ['add', 'del'].includes(rows[i].kind)) {
        const row = rows[i++]; (row.kind === 'del' ? old : next).push(row);
      }
      for (let j = 0; j < Math.max(old.length, next.length); j++) result.push({ old: old[j], next: next[j] });
    } else {
      const row = rows[i++]; result.push({ old: row, next: row });
    }
  }
  return result;
}
