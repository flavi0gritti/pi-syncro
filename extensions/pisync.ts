/**
 * pi-sync — Sync della configurazione pi (~/.pi/agent) con GitHub
 *
 * Comandi disponibili in pi:
 *   /sync push           Salva la configurazione locale su GitHub
 *   /sync pull           Scarica la configurazione da GitHub
 *   /sync status         Mostra lo stato del sync
 *   /sync log            Storico degli ultimi sync
 *   /sync setup <url>    Collega al repo GitHub
 *   /sync remote [url]   Mostra/imposta il remote
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

const PI_DIR = join(homedir(), ".pi", "agent");
const BRANCH = "main";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function git(args: string): string {
  const result = execSync(`git ${args}`, { cwd: PI_DIR, encoding: "utf-8" });
  return (result || "").trim();
}

function gitQuiet(args: string): string {
  try {
    return git(args);
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



// ─── Extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // /sync push
  pi.registerCommand("sync", {
    description: "Sync della configurazione pi con GitHub: push, pull, status, log, setup, remote",
    handler: async (args, ctx) => {
      const [sub, ...rest] = args.trim().split(/\s+/);
      const extra = rest.join(" ");

      if (!existsSync(join(PI_DIR, ".git"))) {
        ctx.ui.notify(
          "Repo git non trovato. Esegui /sync setup <url> per configurare il collegamento a GitHub.",
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
            ctx.ui.notify("Nessuna modifica da sincronizzare.", "info");
            return;
          }

          ctx.ui.notify("Modifiche rilevate, sincronizzazione in corso...", "info");

          const now = new Date();
          const ts = now.toISOString().replace("T", " ").slice(0, 19);
          const device = `${platform()}-${homedir().split(/[/\\]/).pop()}`;

          try {
            git("add -A");
            git(`commit -m "sync: ${ts} [${device}]"`);
            git(`push -u origin ${BRANCH}`);
            ctx.ui.notify("✅ Configurazione sincronizzata su GitHub.", "success");
          } catch (err: any) {
            ctx.ui.notify(`❌ Errore: ${err.message}`, "error");
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
          if (hasLocalChanges()) {
            const discard = await ctx.ui.confirm(
              "Modifiche locali",
              "Ci sono modifiche locali non committate. Il pull sovrascriverà i cambiamenti.\n\nPrima fai /sync push per salvarli, oppure conferma per scartarli."
            );
            if (!discard) {
              ctx.ui.notify("Pull annullato.", "info");
              return;
            }
            // Reset local changes
            try { git("checkout -- ."); } catch {}
          }

          ctx.ui.notify("Download da GitHub in corso...", "info");
          try {
            git(`pull origin ${BRANCH} --rebase`);
            ctx.ui.notify("✅ Configurazione aggiornata da GitHub.", "success");
          } catch (err: any) {
            ctx.ui.notify(`⚠️ Conflitto: ${err.message}\nRisolvi con "git add . && git rebase --continue" nel terminale.`, "error");
          }
          break;
        }

        // ── status ────────────────────────────────────────────────────────
        case "status":
        case "st": {
          const remote = hasRemote() ? git("remote get-url origin") : "nessuno";
          let msg = `📂 Repo: ~/.pi/agent\n🔗 Remote: ${remote}`;

          if (hasRemote()) {
            try {
              git("fetch origin --quiet");
              const behind = gitQuiet(`rev-list HEAD..origin/${BRANCH} --count`) || "0";
              const ahead = gitQuiet(`rev-list origin/${BRANCH}..HEAD --count`) || "0";
              if (behind !== "0") msg += `\n📥 Da scaricare: ${behind} commit`;
              if (ahead !== "0") msg += `\n📤 Da inviare: ${ahead} commit`;
              if (behind === "0" && ahead === "0") msg += "\n✅ In sync";
            } catch {
              msg += "\n⚠️ Impossibile contattare il remote";
            }
          }

          const changes = gitQuiet("status --porcelain");
          if (changes) {
            const short = gitQuiet("status --short");
            msg += `\n\nModifiche locali:\n${short}`;
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
            const log = git("log --oneline -20");
            ctx.ui.notify(`📜 Storico sync:\n${log}`, "info");
          } catch {
            ctx.ui.notify("Nessun commit nel repo.", "info");
          }
          break;
        }

        // ── setup ─────────────────────────────────────────────────────────
        case "setup": {
          if (!extra) {
            ctx.ui.notify("Uso: /sync setup https://github.com/user/repo.git", "error");
            return;
          }

          if (existsSync(join(PI_DIR, ".git"))) {
            // Riconfigura
            try { git("remote remove origin"); } catch {}
            git(`remote add origin ${extra}`);
            git("fetch origin");
            ctx.ui.notify(
              `Remote configurato: ${extra}\nOra esegui /sync pull per scaricare la configurazione, o /sync push per caricarla.`,
              "success"
            );
          } else {
            // Nuova inizializzazione
            git("init -b main");
            git(`remote add origin ${extra}`);
            git("fetch origin");
            ctx.ui.notify(
              `Repo inizializzato e collegato a ${extra}\nOra /sync push per caricare o /sync pull per scaricare.`,
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
            ctx.ui.notify(`Remote impostato: ${extra}`, "success");
          } else if (hasRemote()) {
            ctx.ui.notify(`Remote: ${git("remote get-url origin")}`, "info");
          } else {
            ctx.ui.notify("Nessun remote configurato. /sync setup <url>", "info");
          }
          break;
        }

        // ── default ───────────────────────────────────────────────────────
        default:
          ctx.ui.notify(
            "Uso: /sync <push|pull|status|log|setup <url>|remote [url]>\n\n" +
              "  push    → salva su GitHub\n" +
              "  pull    → scarica da GitHub\n" +
              "  status  → stato attuale\n" +
              "  log     → storico sync\n" +
              "  setup   → collega repo\n" +
              "  remote  → mostra/imposta URL",
            "info"
          );
      }
    },
  });
}
