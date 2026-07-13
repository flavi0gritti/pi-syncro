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
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

const PI_DIR = join(homedir(), ".pi", "agent");
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
          if (!hasLocalChanges()) {
            ctx.ui.notify("✅ Già in sync, nessuna modifica locale.", "info");
            return;
          }

          // Mostra cosa stiamo per inviare
          const stat = gitQuiet("diff --stat --cached") || gitQuiet("status --short");
          const ok = await ctx.ui.confirm(
            "Push su GitHub",
            `File che verranno inviati:\n\n${stat}\n\nProcedere?`
          );
          if (!ok) { ctx.ui.notify("Push annullato.", "info"); return; }

          ctx.ui.notify("Invio in corso...", "info");
          const now = new Date();
          const ts = now.toISOString().replace("T", " ").slice(0, 19);
          const device = `${platform()}-${homedir().split(/[/\\]/).pop()}`;

          try {
            git("add -A");
            git(`commit -m "sync: ${ts} [${device}]"`);
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

          // Blocca se ci sono modifiche locali
          if (hasLocalChanges()) {
            const discard = await ctx.ui.confirm(
              "⚠️ Modifiche locali non salvate",
              "Ci sono modifiche locali. Il pull le sovrascriverebbe.\n\n" +
              "Fai prima /sync push per salvarle su GitHub,\n" +
              "oppure conferma qui per SCARTARLE e procedere."
            );
            if (!discard) { ctx.ui.notify("Pull annullato.", "info"); return; }
            try { git("checkout -- ."); gitQuiet("clean -fd"); } catch {}
          }

          // Anteprima di cosa sta per arrivare
          const preview = buildPullPreview();
          if (preview && preview.behind > 0) {
            let previewMsg = `📥 ${preview.behind} commit in arrivo.\n\n`;
            const fileSection = formatFileList(preview.files, preview.localEmpty);
            if (fileSection) previewMsg += `${fileSection}\n\n`;
            previewMsg += "Procedere col download?";

            const ok = await ctx.ui.confirm("Conferma pull", previewMsg);
            if (!ok) { ctx.ui.notify("Pull annullato.", "info"); return; }
          } else if (preview && preview.behind === 0) {
            ctx.ui.notify("✅ Già aggiornato. Nessuna modifica dal remote.", "info");
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
            ctx.ui.notify("✅ Configurazione aggiornata da GitHub.\nSe hai nuove estensioni, fai /reload.", "success");
          } catch (err: any) {
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

        // ── default (help) ────────────────────────────────────────────────
        default:
          ctx.ui.notify(
            `/sync push             → salva su GitHub\n` +
            `/sync pull             → scarica da GitHub (con anteprima)\n` +
            `/sync diff             → anteprima: cosa cambierebbe col pull\n` +
            `/sync status           → stato attuale\n` +
            `/sync log              → storico sync\n` +
            `/sync setup <url>      → collega al repo GitHub\n` +
            `/sync remote [url]     → mostra o imposta URL remoto`,
            "info"
          );
      }
    },
  });
}
