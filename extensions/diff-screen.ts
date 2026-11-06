import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { sideBySideRows } from '../diff-view.mjs';

// Injected by ctx.ui.custom; no terminal or global theme state is created here.
export function createDiffScreen(tui: any, theme: any, keybindings: any, done: (result: boolean) => void, files: any[], direction: string, options: { heading?: string; notes?: string[]; footer?: string } = {}) {
  let offset = 0;
  let page = 10;
  let cachedWidth = -1;
  let content: string[] = [];
  const clean = (s: string) => s.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
  function cell(row: any, width: number, side: 'old' | 'next'): string[] {
    if (!row) return [' '.repeat(width)];
    const marker = row.kind === 'del' ? '-' : row.kind === 'add' ? '+' : ' ';
    const number = side === 'old' ? row.oldLine : row.newLine;
    const prefix = `${String(number ?? '').padStart(4)}${marker} `;
    const lines = wrapTextWithAnsi(clean(row.text), Math.max(1, width - prefix.length));
    return lines.map((line: string, index: number) => {
      const text = truncateToWidth((index ? ' '.repeat(prefix.length) : prefix) + line, width);
      const padded = text + ' '.repeat(Math.max(0, width - visibleWidth(text)));
      if (row.kind === 'del') return theme.bg('toolErrorBg', theme.fg('toolDiffRemoved', padded));
      if (row.kind === 'add') return theme.bg('toolSuccessBg', theme.fg('toolDiffAdded', padded));
      return theme.fg('dim', padded);
    });
  }
  function layout(width: number) {
    const result: string[] = [];
    for (const note of options.notes || []) result.push(...wrapTextWithAnsi(clean(note), width).map(line => theme.fg('muted', line)));
    if (!files.length) result.push('Nessuna differenza di contenuto.');
    for (const file of files) {
      const added = file.rows.filter((r: any) => r.kind === 'add').length;
      const removed = file.rows.filter((r: any) => r.kind === 'del').length;
      result.push('', theme.fg('accent', `${clean(file.path)}  +${added} -${removed}`));
      if (width >= 100) {
        const half = Math.floor((width - 3) / 2);
        const right = width - half - 3;
        const label = direction === 'push' ? 'GitHub' : 'Questo PC';
        const nextLabel = direction === 'push' ? 'Da inviare' : direction === 'conflict' ? 'GitHub' : direction === 'local' ? 'Con le nuove eccezioni' : 'Da scaricare';
        result.push(theme.fg('muted', label.padEnd(half) + ' │ ' + nextLabel));
        for (const pair of sideBySideRows(file.rows)) {
          if (pair.old?.kind === 'hunk') { result.push(theme.fg('dim', '…')); continue; }
          const left = cell(pair.old, half, 'old'), next = cell(pair.next, right, 'next');
          for (let i = 0; i < Math.max(left.length, next.length); i++) result.push((left[i] ?? ' '.repeat(half)) + theme.fg('border', ' │ ') + (next[i] ?? ' '.repeat(right)));
        }
      } else {
        for (const row of file.rows) {
          if (row.kind === 'hunk') result.push(theme.fg('dim', '…'));
          else result.push(...cell(row, width, row.kind === 'add' ? 'next' : 'old'));
        }
      }
    }
    return result;
  }
  return {
    render(width: number): string[] {
      width = Math.max(1, width);
      if (width !== cachedWidth) { content = layout(width); cachedWidth = width; }
      page = Math.max(1, (tui.terminal.rows || 24) - 7);
      offset = Math.min(offset, Math.max(0, content.length - page));
      const heading = options.heading || (direction === 'push' ? 'GitHub → versione da inviare' : direction === 'local' ? 'Eccezioni di questo PC — non inviate a GitHub' : 'Questo PC → versione da scaricare');
      return [
        theme.fg('accent', clean(heading)),
        ...content.slice(offset, offset + page),
        theme.fg('muted', `${Math.min(offset + page, content.length)}/${content.length} righe · ↑↓ PgUp/PgDn Home/End`),
        theme.fg('accent', clean(options.footer || `Invio: conferma ${direction === 'local' ? 'eccezioni' : direction}     Esc: annulla`)),
      ].map(line => truncateToWidth(line, width));
    },
    handleInput(data: string) {
      if (keybindings.matches(data, 'tui.select.cancel')) { done(false); return; }
      if (keybindings.matches(data, 'tui.select.confirm')) { done(true); return; }
      if (matchesKey(data, Key.pageDown)) offset += page;
      else if (matchesKey(data, Key.pageUp)) offset -= page;
      else if (matchesKey(data, Key.home)) offset = 0;
      else if (matchesKey(data, Key.end)) offset = content.length;
      else if (keybindings.matches(data, 'tui.select.down')) offset++;
      else if (keybindings.matches(data, 'tui.select.up')) offset--;
      else return;
      offset = Math.max(0, Math.min(offset, Math.max(0, content.length - page)));
      tui.requestRender();
    },
    invalidate() { cachedWidth = -1; },
  };
}
