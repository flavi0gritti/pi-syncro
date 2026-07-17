/**
 * pi-syncro — Sync della configurazione pi (~/.pi/agent) con GitHub
 *
 * Comandi disponibili in pi:
 *   /sync push             Salva la configurazione locale su GitHub
 *   /sync pull             Scarica la configurazione (con anteprima e conferma)
 *   /sync diff             Anteprima: cosa cambierebbe col pull (dry-run)
 *   /sync status           Mostra lo stato del sync
 *   /sync log              Storico degli ultimi sync
 *   /sync setup <url>      Collega al repo GitHub
 *   /sync remote [url]     Mostra/imposta il remote
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, copyFileSync, rmSync, readdirSync, statSync, lstatSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { join, relative, dirname, basename } from "node:path";

const PI_DIR = join(homedir(), ".pi", "agent");
const SYNCIGNORE = join(PI_DIR, ".syncignore");
const SETTINGS_LOCAL = join(PI_DIR, "settings.local.json");
const BACKUP_DIR = join(tmpdir(), "pi-sync-backup");
const BRANCH = "main";

// ─── Git helpers ─────────────────────────────────────────────────────────────

function git(args: string): string {
  const result = execSync(`git ${args}`, { cwd: PI_DIR, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
  return (result || "").trim();
}

function gitQuiet(args: string): string {
  try { return git(args); } catch { return ""; }
}

function gitStream(args: string): string {
  try {
    return execSync(`git ${args}`, { cwd: PI_DIR, encoding: "utf-8", stdio: "pipe" }).trim();
  } catch {
    return "";
  }
}

function hasRemote(): boolean {
  return gitQuiet("remote get-url origin").length > 0;
}

function hasLocalChanges(): boolean {
  return gitQuiet("status --porcelain").length > 0;
}

function fetchRemote(): boolean {
  try { git("fetch origin --quiet"); return true; } catch { return false; }
}

// ─── .syncignore ────────────────────────────────────────────────────────────

/** Legge i pattern da .syncignore (uno per riga, # = commento) */
function loadSyncIgnore(): string[] {
  if (!existsSync(SYNCIGNORE)) return [];
  try {
    const raw = readFileSync(SYNCIGNORE, "utf-8");
    return raw
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"));
  } catch {
    return [];
  }
}

/**
 * Espande un pattern .syncignore nella lista di file concreti dentro ~/.pi/agent.
 * Supporta:
 *   - nome file esatto: "models-store.json"
 *   - path relativo: "subdir/file.txt"
 *   - wildcard shell-style: "*.local.json", "backups/*"
 */
function expandPattern(pattern: string): string[] {
  const results: string[] = [];

  // Se il pattern non contiene wildcard, è un path esatto
  if (!pattern.includes("*") && !pattern.includes("?") && !pattern.includes("[")) {
    const full = join(PI_DIR, pattern);
    if (existsSync(full)) results.push(full);
    return results;
  }

  // Per wildcard semplici, usiamo find (disponibile su macOS/Linux/WSL)
  try {
    // separiamo directory base dal pattern glob
    const sep = pattern.includes("/") ? "/" : "";
    const baseDir = sep ? join(PI_DIR, dirname(pattern)) : PI_DIR;
    const glob = sep ? basename(pattern) : pattern;

    if (!existsSync(baseDir)) return [];

    // Usiamo un approccio ricorsivo semplice per wildcard * e ?
    const regex = new RegExp(
      "^" +
        glob
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*/g, ".*")
          .replace(/\?/g, ".") +
        "$"
    );

    function walk(dir: string) {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const entry of entries) {
        // Salta file nascosti (tranne quelli esplicitamente matchati)
        if (entry.startsWith(".") && !pattern.startsWith(".")) continue;
        const full = join(dir, entry);
        let stat: ReturnType<typeof lstatSync>;
        try {
          stat = lstatSync(full);
        } catch {
          continue;
        }
        if (stat.isDirectory()) {
          walk(full);
        } else if (regex.test(entry)) {
          results.push(full);
        }
      }
    }

    walk(baseDir);
  } catch {
    // fallback: prova come path esatto
  }

  return results;
}

/** Restituisce la lista di file locali che matchano .syncignore */
function getIgnoredFiles(): string[] {
  const patterns = loadSyncIgnore();
  if (patterns.length === 0) return [];

  const files = new Set<string>();
  for (const p of patterns) {
    for (const f of expandPattern(p)) {
      files.add(f);
    }
  }
  return Array.from(files);
}

/** Crea backup dei file ignorati in una directory temporanea */
function backupIgnoredFiles(): string[] {
  const files = getIgnoredFiles();
  if (files.length === 0) return [];

  const backedUp: string[] = [];
  try {
    rmSync(BACKUP_DIR, { recursive: true, force: true });
    mkdirSync(BACKUP_DIR, { recursive: true });

    for (const f of files) {
      const rel = relative(PI_DIR, f);
      const dest = join(BACKUP_DIR, rel);
      try {
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(f, dest);
        backedUp.push(f);
      } catch {
        // file inesistente o non accessibile — lo saltiamo
      }
    }
  } catch {
    // se il backup fallisce, torniamo lista vuota (nessun ripristino)
    return [];
  }
  return backedUp;
}

/** Ripristina i file dal backup temporaneo */
function restoreIgnoredFiles(): void {
  if (!existsSync(BACKUP_DIR)) return;
  try {
    function walkRestore(dir: string) {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const entry of entries) {
        const src = join(dir, entry);
        const rel = relative(BACKUP_DIR, src);
        const dest = join(PI_DIR, rel);
        try {
          const st = statSync(src);
          if (st.isDirectory()) {
            mkdirSync(dest, { recursive: true });
            walkRestore(src);
          } else {
            mkdirSync(dirname(dest), { recursive: true });
            copyFileSync(src, dest);
          }
        } catch {
          // skip file problematici
        }
      }
    }
    walkRestore(BACKUP_DIR);
  } finally {
    try { rmSync(BACKUP_DIR, { recursive: true, force: true }); } catch { /* cleanup best-effort */ }
  }
}

// ─── settings.local.json ────────────────────────────────────────────────────

interface LocalSettings {
  excludedProviders?: string[];
  defaultProvider?: string;
  defaultModel?: string;
}

/** Template per il file settings.local.json (con commenti //) */
const LOCAL_SETTINGS_TEMPLATE = `// settings.local.json — configurazione locale per questa macchina
// Questo file NON viene sincronizzato. Modificalo per adattare pi
// alla macchina corrente (es. escludere provider non approvati).
//
// Ogni volta che fai /sync pull, queste regole vengono applicate
// automaticamente ai file sincronizzati.
//
// Tutti i campi sono opzionali.
{
  // Provider da rimuovere su questa macchina (es. ["deepseek"])
  "excludedProviders": [],

  // Provider e modello predefiniti su questa macchina
  // (sovrascrive settings.json se il valore sincronizzato è tra gli esclusi)
  "defaultProvider": "",
  "defaultModel": ""
}
`;

/** Legge settings.local.json strippando i commenti // */
function loadLocalSettings(): LocalSettings | null {
  if (!existsSync(SETTINGS_LOCAL)) return null;
  try {
    const raw = readFileSync(SETTINGS_LOCAL, "utf-8");
    // Rimuovi commenti // e righe vuote
    const cleaned = raw
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, "").trim())
      .filter((line) => line.length > 0)
      .join("\n");
    return JSON.parse(cleaned) as LocalSettings;
  } catch {
    return null;
  }
}

/**
 * Applica le regole di settings.local.json ai file sincronizzati.
 * Restituisce l'elenco delle modifiche fatte (array di stringhe).
 */
function applyLocalSettings(): string[] {
  const local = loadLocalSettings();
  if (!local) return [];

  const changes: string[] = [];
  const excluded = local.excludedProviders || [];

  // 1. Rimuovi provider esclusi da models-store.json
  const storePath = join(PI_DIR, "models-store.json");
  if (excluded.length > 0 && existsSync(storePath)) {
    try {
      const store = JSON.parse(readFileSync(storePath, "utf-8"));
      for (const prov of excluded) {
        if (store[prov]) {
          delete store[prov];
          changes.push(`Rimosso provider "${prov}" da models-store.json`);
        }
      }
      writeFileSync(storePath, JSON.stringify(store, null, 2) + "\n");
    } catch { /* file corrotto, ignora */ }
  }

  // 2. Correggi settings.json
  const settingsPath = join(PI_DIR, "settings.json");
  if (existsSync(settingsPath)) {
    try {
      const s = JSON.parse(readFileSync(settingsPath, "utf-8"));

      // defaultProvider: correggi se è tra gli esclusi o se non impostato
      if (excluded.includes(s.defaultProvider) || (!s.defaultProvider && local.defaultProvider)) {
        s.defaultProvider = local.defaultProvider || "";
        changes.push(`defaultProvider → "${s.defaultProvider}"`);
      }

      // defaultModel: correggi se il provider è tra gli esclusi
      if (s.defaultModel) {
        const [prov] = s.defaultModel.split("/");
        if (excluded.includes(prov)) {
          s.defaultModel = local.defaultModel || "";
          changes.push(`defaultModel → "${s.defaultModel}"`);
        }
      } else if (local.defaultModel) {
        s.defaultModel = local.defaultModel;
        changes.push(`defaultModel → "${s.defaultModel}"`);
      }

      // enabledModels: rimuovi quelli dei provider esclusi
      if (s.enabledModels && excluded.length > 0) {
        const before = s.enabledModels.length;
        s.enabledModels = s.enabledModels.filter((m: string) => {
          const [prov] = m.split("/");
          return !excluded.includes(prov);
        });
        const removed = before - s.enabledModels.length;
        if (removed > 0) changes.push(`Rimossi ${removed} modelli da enabledModels`);
      }

      writeFileSync(settingsPath, JSON.stringify(s, null, 2) + "\n");
    } catch { /* file corrotto, ignora */ }
  }

  // 3. Pulisci auth.json dai provider esclusi (sicurezza)
  const authPath = join(PI_DIR, "auth.json");
  if (excluded.length > 0 && existsSync(authPath)) {
    try {
      const auth = JSON.parse(readFileSync(authPath, "utf-8"));
      for (const prov of excluded) {
        if (auth[prov]) {
          delete auth[prov];
          changes.push(`Rimossa api key "${prov}" da auth.json`);
        }
      }
      writeFileSync(authPath, JSON.stringify(auth, null, 2) + "\n");
    } catch { /* ok */ }
  }

  return changes;
}

/** Crea il file settings.local.json template se non esiste */
function ensureLocalSettingsTemplate(): boolean {
  if (existsSync(SETTINGS_LOCAL)) return false;
  try {
    writeFileSync(SETTINGS_LOCAL, LOCAL_SETTINGS_TEMPLATE, "utf-8");
    return true;
  } catch {
    return false;
  }
}

// ─── Preview per il pull ────────────────────────────────────────────────────

interface FileChange {
  path: string;
  added: number;
  deleted: number;
  isNew: boolean;
}

interface PullPreview {
  behind: number;
  ahead: number;
  files: FileChange[];   // elenco file con +/- invece di --stat grezzo
  commitList: string;     // log oneline dei commit in arrivo
  localEmpty: boolean;
}

function hasLocalCommits(): boolean {
  return gitQuiet("rev-parse HEAD").length > 0;
}

/**
 * Parsa l'output di git diff --numstat:
 *   riga: "added\tdeleted\tpath"
 *   per file binari: "-\t-\tpath"
 * isNew viene deciso dal chiamante in base al contesto (repo vuoto o no).
 */
function parseNumStat(raw: string): FileChange[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const parts = line.split("\t");
      if (parts.length < 3) return null;
      const added = parts[0] === "-" ? 0 : parseInt(parts[0]) || 0;
      const deleted = parts[1] === "-" ? 0 : parseInt(parts[1]) || 0;
      return { path: parts.slice(2).join("\t"), added, deleted, isNew: false };
    })
    .filter((f): f is FileChange => f !== null);
}

function buildPullPreview(): PullPreview | null {
  if (!hasRemote()) return null;
  if (!fetchRemote()) return null;

  const localEmpty = !hasLocalCommits();

  const behind = localEmpty
    ? parseInt(gitQuiet(`rev-list origin/${BRANCH} --count`)) || 0
    : parseInt(gitQuiet(`rev-list HEAD..origin/${BRANCH} --count`)) || 0;
  const ahead = localEmpty
    ? 0
    : parseInt(gitQuiet(`rev-list origin/${BRANCH}..HEAD --count`)) || 0;

  let files: FileChange[];
  if (localEmpty) {
    // Repo vuoto: diff origin/main vs working tree.
    // added===0 significa che il file non esiste in locale (da creare)
    const numstat = gitQuiet(`diff --numstat origin/${BRANCH} -- .`);
    files = parseNumStat(numstat);
    for (const f of files) {
      f.isNew = f.added === 0; // file assente in locale → da creare
    }
  } else {
    // Repo con commit: diff locale vs remote.
    // deleted===0 significa che il file è nuovo nel remote
    const numstat = gitQuiet(`diff --numstat HEAD...origin/${BRANCH}`);
    files = parseNumStat(numstat);
    for (const f of files) {
      f.isNew = f.deleted === 0; // file aggiunto nel remote
    }
  }

  const commitList = localEmpty
    ? gitQuiet(`log --oneline origin/${BRANCH} -20`)
    : gitQuiet(`log --oneline HEAD..origin/${BRANCH} -20`);

  return { behind, ahead, files, commitList, localEmpty };
}

/** Costruisce un messaggio leggibile con l'elenco dei file */
function formatFileList(files: FileChange[], _localEmpty: boolean): string {
  if (files.length === 0) return "";

  const newFiles = files.filter((f) => f.isNew);
  const changedFiles = files.filter((f) => !f.isNew);

  let out = "";

  if (newFiles.length > 0) {
    out += `🆕 File da creare (${newFiles.length}):\n`;
    for (const f of newFiles) {
      out += `   ✨ ${f.path}\n`;
    }
  }
  if (changedFiles.length > 0) {
    if (out) out += "\n";
    out += `✏️  File da aggiornare (${changedFiles.length}):\n`;
    for (const f of changedFiles) {
      out += `   ${f.path}  +${f.added} −${f.deleted}\n`;
    }
  }

  return out;
}

/** Restituisce il diff dettagliato per un singolo file */
function fileDetailDiff(filePath: string): string {
  const localEmpty = !hasLocalCommits();
  if (localEmpty) {
    return gitQuiet(`diff origin/${BRANCH} -- "${filePath}"`);
  } else {
    return gitQuiet(`diff HEAD...origin/${BRANCH} -- "${filePath}"`);
  }
}

// ─── Estensione ──────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.registerCommand("sync", {
    description: "Sync configurazione pi con GitHub: push, pull, diff, status, log, setup, remote",
    handler: async (args, ctx) => {
      const [sub, ...rest] = args.trim().split(/\s+/);
      const extra = rest.join(" ");

      // setup e help non richiedono il repo git
      const needsRepo = sub !== "setup" && sub !== "help";
      if (needsRepo && !existsSync(join(PI_DIR, ".git"))) {
        ctx.ui.notify(
          "Repo git non trovato.\nEsegui /sync setup <url> per configurare il collegamento a GitHub.",
          "error"
        );
        return;
      }

      switch (sub) {

        // ── push ──────────────────────────────────────────────────────────
        case "push":
        case "upload": {
          if (!hasRemote()) {
            ctx.ui.notify("Nessun remote configurato. /sync setup <url>", "error");
            return;
          }

          // Controlla se ci sono commit locali non ancora inviati
          let ahead = "0";
          try {
            git("fetch origin --quiet");
            ahead = gitQuiet(`rev-list origin/${BRANCH}..HEAD --count`) || "0";
          } catch { /* offline */ }

          if (!hasLocalChanges() && ahead === "0") {
            ctx.ui.notify("✅ Già in sync, nessuna modifica locale.", "info");
            return;
          }

          // Se ci sono modifiche nel working tree, le committa
          if (hasLocalChanges()) {
            const stat = gitQuiet("diff --stat --cached") || gitQuiet("status --short");
            const ok = await ctx.ui.confirm(
              "Push su GitHub",
              `File che verranno inviati:\n\n${stat}\n\nProcedere?`
            );
            if (!ok) { ctx.ui.notify("Push annullato.", "info"); return; }

            ctx.ui.notify("Invio in corso...", "info");

            // Applica settings.local.json prima del commit (così i provider
            // esclusi non finiscono nel repo)
            const localChanges = applyLocalSettings();

            // Backup dei file in .syncignore
            backupIgnoredFiles();

            const now = new Date();
            const ts = now.toISOString().replace("T", " ").slice(0, 19);
            const device = `${platform()}-${homedir().split(/[/\\]/).pop()}`;

            git("add -A");

            // Escludi i file in .syncignore dallo stage
            const ignored = getIgnoredFiles();
            for (const f of ignored) {
              const rel = relative(PI_DIR, f);
              try { git(`reset -- "${rel}"`); } catch { /* ignora errori */ }
            }

            // Commit solo se c'è qualcosa in stage
            const staged = gitQuiet("diff --cached --name-only");
            if (staged) {
              git(`commit -m "sync: ${ts} [${device}]"`);
            } else {
              ctx.ui.notify("✅ Nessuna modifica da sincronizzare (file in .syncignore esclusi).", "info");
              restoreIgnoredFiles();
              return;
            }

            // Ripristina i file ignorati nel working tree
            restoreIgnoredFiles();
          } else if (ahead !== "0") {
            ctx.ui.notify(`${ahead} commit locale(i) non ancora inviato(i) — riprendo il push...`, "info");
          }

          try {
            // 🔄 Integra eventuali modifiche arrivate dal remote (altro dispositivo)
            try {
              git("fetch origin --quiet");
              const behind = gitQuiet(`rev-list HEAD..origin/${BRANCH} --count`) || "0";
              if (behind !== "0") {
                ctx.ui.notify(`${behind} commit in arrivo — integro con rebase...`, "info");
                git(`pull origin ${BRANCH} --rebase`);
              }
            } catch {
              ctx.ui.notify(
                "⚠️ Conflitto col remote!\n" +
                "Risolvi nel terminale:\n" +
                "  cd ~/.pi/agent\n" +
                "  Risolvi i conflitti\n" +
                "  git add . && git rebase --continue\n" +
                "Poi riprova /sync push.",
                "error"
              );
              return;
            }

            const pushOut = git(`push -u origin ${BRANCH}`);
            ctx.ui.notify("✅ Configurazione sincronizzata su GitHub.", "success");
          } catch (err: any) {
            ctx.ui.notify(`❌ Push fallito: ${err.message}`, "error");
          }
          break;
        }

        // ── diff (anteprima pull) ─────────────────────────────────────────
        case "diff":
        case "preview":
        case "dry-run": {
          if (!hasRemote()) {
            ctx.ui.notify("Nessun remote configurato. /sync setup <url>", "error");
            return;
          }

          // /sync diff <file> → dettaglio di un singolo file
          if (extra) {
            const detail = fileDetailDiff(extra);
            if (!detail) {
              ctx.ui.notify(`Nessuna differenza per: ${extra}`, "info");
            } else {
              ctx.ui.notify(`📝 Diff di ${extra}:\n\n${detail}`, "info");
            }
            return;
          }

          ctx.ui.notify("🔍 Contatto il remote...", "info");
          const preview = buildPullPreview();

          if (!preview) {
            ctx.ui.notify("⚠️ Impossibile contattare il remote. Controlla la connessione.", "error");
            return;
          }

          if (preview.behind === 0) {
            ctx.ui.notify("✅ Già aggiornato. Nessuna modifica in arrivo dal remote.", "info");
            return;
          }

          // Se ci sono file, offri la selezione interattiva per il dettaglio
          if (preview.files.length > 0 && ctx.hasUI) {
            let msg = `📥 ${preview.behind} commit in arrivo dal remote`;
            if (preview.ahead > 0) msg += `  |  📤 ${preview.ahead} commit locali da inviare`;

            const fileSection = formatFileList(preview.files, preview.localEmpty);
            if (fileSection) msg += `\n\n${fileSection}`;

            msg += "\n───────────────\nPer applicare: /sync pull\nPer dettaglio: /sync diff <file>";

            // Proponi una selezione rapida dei file modificati
            const choices = [
              { value: "__pull__", label: "⬇️  Applica subito (/sync pull)" },
              ...preview.files
                .filter((f) => !f.isNew)
                .map((f) => ({
                  value: f.path,
                  label: `🔍 ${f.path}  +${f.added} −${f.deleted}`,
                })),
            ];

            if (choices.length > 1) {
              const pick = await ctx.ui.select(
                `Vuoi esplorare un file? (${preview.files.length} file in attesa)`,
                choices
              );
              if (pick && pick !== "__pull__") {
                const detail = fileDetailDiff(pick);
                ctx.ui.notify(`📝 Diff di ${pick}:\n\n${detail}`, "info");
                return;
              }
            } else {
              ctx.ui.notify(msg, "info");
            }
          } else {
            ctx.ui.notify("✅ Già aggiornato. Nessuna modifica in arrivo dal remote.", "info");
          }
          break;
        }

        // ── pull ──────────────────────────────────────────────────────────
        case "pull":
        case "download": {
          if (!hasRemote()) {
            ctx.ui.notify("Nessun remote configurato. /sync setup <url>", "error");
            return;
          }

          // Backup dei file in .syncignore prima del pull
          const ignoredBeforePull = backupIgnoredFiles();
          const hasIgnoredBeforePull = ignoredBeforePull.length > 0;

          // Blocca se ci sono modifiche locali (esclusi i file in .syncignore)
          if (hasLocalChanges()) {
            // Se le uniche modifiche sono nei file ignorati, procedi
            const changes = gitQuiet("status --porcelain");
            const ignoredRels = new Set(ignoredBeforePull.map((f) => relative(PI_DIR, f)));
            const nonIgnoredChanges = changes
              .split("\n")
              .filter((line) => {
                const trimmed = line.trim();
                if (!trimmed) return false;
                // git status --porcelain format: "XY path" (primi 2 char sono status)
                const filePath = trimmed.substring(3).trim();
                return !ignoredRels.has(filePath);
              })
              .join("\n")
              .trim();

            if (nonIgnoredChanges) {
              const discard = await ctx.ui.confirm(
                "⚠️ Modifiche locali non salvate",
                "Ci sono modifiche locali. Il pull le sovrascriverebbe.\n\n" +
                "Fai prima /sync push per salvarle su GitHub,\n" +
                "oppure conferma qui per SCARTARLE e procedere."
              );
              if (!discard) {
                restoreIgnoredFiles();
                ctx.ui.notify("Pull annullato.", "info");
                return;
              }
              try { git("checkout -- ."); gitQuiet("clean -fd"); } catch {}
            }
          }

          // Anteprima di cosa sta per arrivare
          const preview = buildPullPreview();
          if (preview && preview.behind > 0) {
            // Filtra i file in .syncignore dall'anteprima
            const ignoredSet = new Set(getIgnoredFiles().map((f) => relative(PI_DIR, f)));
            const filteredFiles = preview.files.filter((f) => !ignoredSet.has(f.path));
            const filteredCount = preview.files.length - filteredFiles.length;

            let previewMsg = `📥 ${preview.behind} commit in arrivo.`;
            if (filteredCount > 0) {
              previewMsg += `\n🔒 ${filteredCount} file in .syncignore (non verranno toccati)`;
            }
            previewMsg += "\n\n";
            const fileSection = formatFileList(filteredFiles, preview.localEmpty);
            if (fileSection) previewMsg += `${fileSection}\n\n`;
            else if (filteredCount > 0) previewMsg += "(tutti i file in arrivo sono in .syncignore — non verranno applicati)\n\n";
            previewMsg += "Procedere col download?";

            const ok = await ctx.ui.confirm("Conferma pull", previewMsg);
            if (!ok) {
              restoreIgnoredFiles();
              ctx.ui.notify("Pull annullato.", "info");
              return;
            }
          } else if (preview && preview.behind === 0) {
            ctx.ui.notify("✅ Già aggiornato. Nessuna modifica dal remote.", "info");
            restoreIgnoredFiles();
            return;
          }

          ctx.ui.notify("Download in corso...", "info");
          try {
            const isEmpty = !hasLocalCommits();
            if (isEmpty) {
              // Repo vuoto: fetch + checkout forzato (sovrascrive file locali)
              // -f = force, --no-guess evita warning su branch non tracciati
              git(`fetch origin ${BRANCH}`);
              git(`checkout -f -b ${BRANCH} origin/${BRANCH} --no-guess`);
            } else {
              const pullOut = git(`pull origin ${BRANCH} --rebase`);
            }

            // Ripristina i file ignorati dopo il pull
            if (hasIgnoredBeforePull) {
              restoreIgnoredFiles();
            }

            // Applica settings.local.json
            const localChanges = applyLocalSettings();

            // Crea il template se non esiste
            const templateCreated = ensureLocalSettingsTemplate();

            let msg = "✅ Configurazione aggiornata da GitHub.";
            if (hasIgnoredBeforePull) msg += "\n🔒 File in .syncignore preservati.";
            if (localChanges.length > 0) {
              msg += "\n🛡️  settings.local.json:";
              for (const c of localChanges) msg += `\n   ${c}`;
            }
            if (templateCreated) {
              msg += "\n\n📝 Creato settings.local.json template in ~/.pi/agent/settings.local.json";
              msg += "\n   Aprilo e configuralo per questa macchina, poi fai /reload.";
            }
            msg += "\nSe hai nuove estensioni, fai /reload.";
            ctx.ui.notify(msg, "success");
          } catch (err: any) {
            // In caso di errore, ripristina comunque i file ignorati
            if (hasIgnoredBeforePull) restoreIgnoredFiles();
            ctx.ui.notify(
              `⚠️ Conflitto durante il pull.\n\n` +
              `Risolvi nel terminale:\n` +
              `  cd ~/.pi/agent\n` +
              `  Risolvi i conflitti nei file\n` +
              `  git add . && git rebase --continue`,
              "error"
            );
          }
          break;
        }

        // ── status ────────────────────────────────────────────────────────
        case "status":
        case "st": {
          const remote = hasRemote() ? git("remote get-url origin") : "nessuno";
          let msg = `📂 ~/.pi/agent\n🔗 ${remote}`;

          if (hasRemote()) {
            if (fetchRemote()) {
              const localEmpty = !hasLocalCommits();
              const behind = localEmpty
                ? gitQuiet(`rev-list origin/${BRANCH} --count`) || "0"
                : gitQuiet(`rev-list HEAD..origin/${BRANCH} --count`) || "0";
              const ahead = localEmpty
                ? "0"
                : gitQuiet(`rev-list origin/${BRANCH}..HEAD --count`) || "0";
              if (behind !== "0") msg += `\n📥 Da scaricare: ${behind} commit`;
              if (ahead  !== "0") msg += `\n📤 Da inviare:   ${ahead} commit`;
              if (behind === "0" && ahead === "0") msg += "\n✅ In sync";
            } else {
              msg += "\n⚠️ Offline — impossibile contattare il remote";
            }
          } else {
            msg += "\n⚠️ Nessun remote. Esegui /sync setup <url>";
          }

          const changes = gitQuiet("status --porcelain");
          if (changes) {
            msg += `\n\n📝 Modifiche locali:\n${gitQuiet("status --short")}`;
          } else {
            msg += "\n📝 Working tree pulito";
          }

          ctx.ui.notify(msg, "info");
          break;
        }

        // ── log ───────────────────────────────────────────────────────────
        case "log":
        case "history": {
          try {
            const log = git("log --oneline -20 --format=%C(auto)%h %ad %s --date=short");
            ctx.ui.notify(`📜 Storico sync:\n${log}`, "info");
          } catch {
            ctx.ui.notify("Nessun commit nel repo.", "info");
          }
          break;
        }

        // ── setup ─────────────────────────────────────────────────────────
        case "setup": {
          if (!extra) {
            ctx.ui.notify(
              "Uso: /sync setup <url>\n\n" +
              "Esempio: /sync setup https://github.com/flavi0gritti/pi-config.git\n\n" +
              "Il repo deve esistere già su GitHub (pubblico o privato).",
              "error"
            );
            return;
          }

          if (existsSync(join(PI_DIR, ".git"))) {
            try { git("remote remove origin"); } catch {}
            git(`remote add origin ${extra}`);
            git("fetch origin");
            ctx.ui.notify(
              `✅ Remote aggiornato: ${extra}\n\n` +
              `Ora:\n` +
              `  /sync pull  → per scaricare la config esistente\n` +
              `  /sync push  → per caricare la tua config attuale`,
              "success"
            );
          } else {
            git("init -b main");
            git(`remote add origin ${extra}`);
            git("fetch origin");
            ctx.ui.notify(
              `✅ Repo inizializzato e collegato a ${extra}\n\n` +
              `Ora:\n` +
              `  /sync pull  → per scaricare la config esistente\n` +
              `  /sync push  → per caricare la tua config attuale`,
              "success"
            );
          }
          break;
        }

        // ── remote ────────────────────────────────────────────────────────
        case "remote": {
          if (extra) {
            try { git("remote remove origin"); } catch {}
            git(`remote add origin ${extra}`);
            ctx.ui.notify(`✅ Remote impostato: ${extra}`, "success");
          } else if (hasRemote()) {
            ctx.ui.notify(`🔗 Remote: ${git("remote get-url origin")}`, "info");
          } else {
            ctx.ui.notify("⚠️ Nessun remote. /sync setup <url>", "info");
          }
          break;
        }

        // ── local ───────────────────────────────────────────────────────
        case "local": {
          if (!extra) {
            if (existsSync(SETTINGS_LOCAL)) {
              const raw = readFileSync(SETTINGS_LOCAL, "utf-8");
              const local = loadLocalSettings();
              let msg = `🛡️  settings.local.json attuale:\n\n${raw}\n`;
              if (local) {
                const excluded = local.excludedProviders || [];
                const dp = local.defaultProvider || "(non impostato)";
                const dm = local.defaultModel || "(non impostato)";
                msg += `\n── Riepilogo ──\n`;
                msg += `Provider esclusi: ${excluded.length > 0 ? excluded.join(", ") : "(nessuno)"}\n`;
                msg += `Default provider: ${dp}\n`;
                msg += `Default model:    ${dm}\n`;
              }
              ctx.ui.notify(msg, "info");
            } else {
              const created = ensureLocalSettingsTemplate();
              if (created) {
                ctx.ui.notify(
                  "📝 Creato settings.local.json template in:\n" +
                  "   ~/.pi/agent/settings.local.json\n\n" +
                  "Aprilo e configuralo per questa macchina.\n" +
                  "Poi fai /reload per applicare.",
                  "success"
                );
              }
            }
            return;
          }

          const [action, ...restParts] = extra.trim().split(/\s+/);

          if (action === "edit" || action === "open") {
            if (!existsSync(SETTINGS_LOCAL)) ensureLocalSettingsTemplate();
            ctx.ui.notify(
              `📝 Apri ~/.pi/agent/settings.local.json nel tuo editor.\n` +
              `Dopo averlo modificato, fai /reload.`,
              "info"
            );
          } else if (action === "apply" || action === "test") {
            const changes = applyLocalSettings();
            if (changes.length === 0) {
              ctx.ui.notify("✅ settings.local.json applicato — nessuna modifica necessaria.", "info");
            } else {
              let msg = "🛡️  settings.local.json applicato:\n";
              for (const c of changes) msg += `   ${c}\n`;
              msg += "\n✅ Configurazione adattata a questa macchina.";
              ctx.ui.notify(msg, "success");
            }
          } else {
            ctx.ui.notify(
              "/sync local            → mostra settings.local.json attuale\n" +
              "/sync local edit       → crea/apri il file per modificarlo\n" +
              "/sync local apply      → ri-applica le regole subito (test)",
              "info"
            );
          }
          break;
        }

        // ── ignore ───────────────────────────────────────────────────────
        case "ignore": {
          if (!extra) {
            const patterns = loadSyncIgnore();
            if (patterns.length === 0) {
              ctx.ui.notify(
                "📛 Nessun pattern in .syncignore.\n\n" +
                "Usa /sync ignore add <pattern> per aggiungere un file da ignorare.\n" +
                "I pattern supportano wildcard * e ?\n\n" +
                "Esempi:\n" +
                "  /sync ignore add models-store.json\n" +
                "  /sync ignore add '*.local.json'\n" +
                "  /sync ignore remove models-store.json\n" +
                "  /sync ignore list",
                "info"
              );
            } else {
              const files = getIgnoredFiles();
              let msg = `📛 Pattern in .syncignore:\n`;
              for (const p of patterns) {
                msg += `   ${p}\n`;
              }
              if (files.length > 0) {
                msg += `\n📁 File attualmente ignorati (${files.length}):\n`;
                for (const f of files) {
                  msg += `   ${relative(PI_DIR, f)}\n`;
                }
              }
              msg += "\n/sync ignore add <pattern>  → aggiungi\n";
              msg += "/sync ignore remove <pattern> → rimuovi";
              ctx.ui.notify(msg, "info");
            }
            return;
          }

          const [action, ...patternParts] = extra.trim().split(/\s+/);
          const pattern = patternParts.join(" ");

          if (action === "add" || action === "+") {
            if (!pattern) {
              ctx.ui.notify("Uso: /sync ignore add <pattern>", "error");
              return;
            }
            const current = loadSyncIgnore();
            if (current.includes(pattern)) {
              ctx.ui.notify(`📛 Pattern "${pattern}" già presente in .syncignore.`, "info");
              return;
            }
            const updated = [...current, pattern];
            try {
              writeFileSync(SYNCIGNORE, updated.join("\n") + "\n", "utf-8");
              ctx.ui.notify(
                `✅ Pattern "${pattern}" aggiunto a .syncignore.\n` +
                `🔒 I file che matchano questo pattern non verranno sincronizzati.\n` +
                `⚠️  Ricorda: .syncignore è locale a questa macchina (non viene sincronizzato).`,
                "success"
              );
            } catch (err: any) {
              ctx.ui.notify(`❌ Errore: ${err.message}`, "error");
            }
          } else if (action === "remove" || action === "rm" || action === "-") {
            if (!pattern) {
              ctx.ui.notify("Uso: /sync ignore remove <pattern>", "error");
              return;
            }
            const current = loadSyncIgnore();
            const idx = current.indexOf(pattern);
            if (idx === -1) {
              ctx.ui.notify(`📛 Pattern "${pattern}" non trovato in .syncignore.`, "info");
              return;
            }
            const updated = current.filter((_, i) => i !== idx);
            try {
              if (updated.length === 0) {
                unlinkSync(SYNCIGNORE);
              } else {
                writeFileSync(SYNCIGNORE, updated.join("\n") + "\n", "utf-8");
              }
              ctx.ui.notify(`✅ Pattern "${pattern}" rimosso da .syncignore.`, "success");
            } catch (err: any) {
              ctx.ui.notify(`❌ Errore: ${err.message}`, "error");
            }
          } else if (action === "list" || action === "ls") {
            const patterns = loadSyncIgnore();
            const files = getIgnoredFiles();
            let msg = "";
            if (patterns.length === 0) {
              msg = "📛 Nessun pattern in .syncignore.";
            } else {
              msg = `📛 Pattern in .syncignore (${patterns.length}):\n`;
              for (const p of patterns) {
                msg += `   ${p}\n`;
              }
              if (files.length > 0) {
                msg += `\n📁 File ignorati (${files.length}):\n`;
                for (const f of files) {
                  msg += `   ${relative(PI_DIR, f)}\n`;
                }
              }
            }
            ctx.ui.notify(msg, "info");
          } else {
            ctx.ui.notify(
              "Uso: /sync ignore [add|remove|list] <pattern>\n\n" +
              "  add <pattern>     → aggiungi pattern a .syncignore\n" +
              "  remove <pattern>  → rimuovi pattern da .syncignore\n" +
              "  list              → mostra pattern e file ignorati",
              "error"
            );
          }
          break;
        }

        // ── default (help) ────────────────────────────────────────────────
        default:
          ctx.ui.notify(
            `/sync push             → salva su GitHub\n` +
            `/sync pull             → scarica da GitHub (con anteprima)\n` +
            `/sync diff             → anteprima: cosa cambierebbe col pull\n` +
            `/sync status           → stato attuale\n` +
            `/sync log              → storico sync\n` +
            `/sync setup <url>      → collega al repo GitHub\n` +
            `/sync remote [url]     → mostra o imposta URL remoto\n` +
            `/sync ignore           → gestisci file esclusi dal sync\n` +
            `/sync local            → configura impostazioni locali (per-macchina)\n\n` +
            `💡 Vuoi escludere DeepSeek solo su questa macchina?\n` +
            `   /sync local edit    → apri settings.local.json e imposta\n` +
            `   "excludedProviders": ["deepseek"]`,
            "info"
          );
      }
    },
  });
}
