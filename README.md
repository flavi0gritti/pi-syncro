# pi-syncro

Sincronizza `~/.pi/agent` tramite Git, su Windows, macOS e Linux.

```sh
pi install git:github.com/flavi0gritti/pi-syncro
```

## Regola di sicurezza

**Prima leggi, poi confermi, solo dopo si modifica.** Un push non riscrive mai i file locali. Non vengono eseguiti rebase automatici, `git clean`, checkout forzati o scarti delle modifiche.

## Comandi dentro Pi

| Comando | Azione |
| --- | --- |
| `/sync setup <url>` | Collega il repository della configurazione; non scarica né invia file |
| `/sync push` | Anteprima di ciò che cambia su GitHub, poi conferma |
| `/sync pull` | Anteprima di ciò che cambia sul PC, poi conferma |
| `/sync diff push` | Solo anteprima del push |
| `/sync diff pull` (o `/sync diff`) | Solo anteprima del pull |
| `/sync status` | Stato Git locale |
| `/sync log` | Ultimi 20 commit locali |
| `/sync remote` | Mostra il remote |
| `/sync local` | Mostra percorso e provider esclusi; crea un template se manca |
| `/sync ignore [add\|remove\|list] [pattern]` | Gestisce `.syncignore` locale |

L’anteprima si apre in un editor scorrevole. Il testo è un rapporto, **non un piano modificabile**: cambiarlo non cambia le operazioni. Esc annulla; chiudere normalmente porta a una seconda conferma. La versione effettiva approvata viene verificata prima di applicarla: se file, indice, preferenze locali o GitHub sono cambiati, occorre una nuova anteprima.

Sono mostrati aggiunte, modifiche e rimozioni dei file. Per `settings.json`, anche i cambiamenti alle singole impostazioni e ai pacchetti. I valori non pubblici vengono nascosti; negli altri JSON vengono mostrati i percorsi dei campi aggiunti, rimossi o modificati. Per gli altri file si mostra un riepilogo in byte, **non il diff completo del contenuto**, per non stampare credenziali. Nessun invio in modalità non interattiva.

`diff <nome-file>` non è più supportato: usa `diff push` o `diff pull`.

## Cosa succede se i due computer hanno modifiche?

- **Push con novità remote:** si ferma e chiede di controllare prima il pull. Non mescola le versioni di nascosto.
- **Pull con modifiche locali su file diversi:** conserva le modifiche locali e applica quelle remote mostrate.
- **Pull con modifiche locali e remote sullo stesso file:** si ferma senza modificare file. La prima versione è volutamente prudente: niente fusione automatica nemmeno tra due campi dello stesso JSON. Conserva una copia delle modifiche e risolvi manualmente il conflitto prima di riprovare.
- **Storie Git divergenti o commit locali durante il pull:** richiedono una risoluzione Git manuale.
- File già nello stage, operazioni Git incomplete, branch diversi da `main`, link simbolici e submodule bloccano la sincronizzazione.

Il fetch aggiorna metadati e riferimenti remoti Git anche durante un’anteprima; non modifica le impostazioni né il working tree. Git deve essere configurato con nome/email e accesso al remote.

## Preferenze di questo PC

Crea/modifica `~/.pi/agent/settings.local.json`:

```json
{
  "excludedProviders": ["deepseek"],
  "defaultProvider": "openai-codex",
  "defaultModel": "gpt-5.4-mini"
}
```

Sono ammessi commenti `//` su righe separate. JSON errato blocca l’operazione, non viene ignorato.

Il filtro riguarda soltanto i provider in `models-store.json` e i campi `enabledModels`, `defaultProvider`, `defaultModel` in `settings.json`:

- **Push:** ricostruisce questi soli valori dalla base canonica Git in un indice temporaneo. Tema, pacchetti e altre preferenze aggiornate vengono sincronizzati normalmente. I file sul PC restano byte per byte invariati.
- **Pull:** filtra i nuovi valori prima dell’anteprima. La versione canonica completa resta in Git.
- Le API key locali non vengono cancellate o riscritte dal filtro.

Per applicare inizialmente un filtro a una configurazione già locale, adegua quei campi manualmente. `/sync local apply` e `test` non riscrivono più i file: il filtro viene applicato ai file in arrivo con un pull confermato. Non viene creato automaticamente un template durante un pull.

Per escludere file interi, usa `.syncignore`, un pattern per riga (`*`, `?`, percorsi relativi; commenti su righe separate). Ad esempio:

```text
models-store.json
*.local.json
themes/custom-theme.json
```

I file esclusi restano invariati sia localmente sia sul remoto. Per rimuovere dal remoto un file escluso, serve un’operazione Git esplicita.

## Credenziali e backup

`auth.json`, `mcp-auth.json`, `settings.local.json`, `.syncignore`, file `.env*`, percorsi con nomi di credenziali/segreti/token/chiavi private e directory rigenerabili (`sessions`, `git`, `npm`, `bin`, `backups`, `tmp`) sono esclusi automaticamente. Vengono inoltre bloccati i JSON contenenti campi non vuoti come `apiKey`, `Authorization`, `password`, `accessToken`, `refreshToken`, `clientSecret`, `privateKey` o `cookie`, anche nei commit locali non pubblicati. Il controllo è prudente e può bloccare anche riferimenti a variabili d’ambiente in quei campi. **Non è uno scanner completo di segreti**: non inserire credenziali dentro altri file sincronizzati. Usa `.gitignore` e `.syncignore` e controlla i file prima di sincronizzarli.

Se file privati erano già tracciati, il push ne propone la rimozione dalla versione corrente su GitHub, senza cancellare la copia locale. Se commit locali non ancora pubblicati contengono file privati, il push viene bloccato: rimuoverli dall’ultimo albero non basta, bisogna ripulire la cronologia. **Segreti già pubblicati restano nei vecchi commit: revocali e ripulisci la cronologia separatamente.**

Prima di applicare un piano si crea un backup con permessi restrittivi in:

```text
~/.pi/agent/.git/pi-sync-backups/<data-id>/
  manifest.json  # HEAD precedente e lista file
  files/         # copie locali prima dell’operazione
```

Il percorso viene comunicato al termine. Il backup può contenere dati privati: non condividerlo. Per annullare manualmente, chiudi Pi, conserva anche lo stato attuale, poi ripristina i file desiderati da `files/` e usa il manifest per individuare file aggiunti dall’operazione. La cronologia non viene resettata automaticamente: se necessario chiedi assistenza Git. Un push remoto già riuscito non viene annullato da un errore successivo locale.

Un lock impedisce due operazioni di pi-syncro contemporanee. Non protegge contro programmi esterni che scrivono file durante l’applicazione: esegui il sync quando Pi e gli altri programmi non stanno cambiando le impostazioni. Se il processo termina bruscamente, controlla backup e stato Git prima di rimuovere l’eventuale `.git/pi-sync.lock` rimasto.

## CLI

Usa lo stesso motore e le stesse protezioni dell’estensione:

```sh
node ~/.pi/agent/git/github.com/flavi0gritti/pi-syncro/cli.mjs diff push
node ~/.pi/agent/git/github.com/flavi0gritti/pi-syncro/cli.mjs push
```

Su PowerShell usa `~` oppure `$env:USERPROFILE` e il launcher `pisync.ps1`. Comandi CLI: `push`, `pull`, `diff [push|pull]`, `status`, `log`, `setup <url>`, `remote`.

## Test

```sh
npm test
```

I test usano repository Git temporanei locali, non il repository delle impostazioni né GitHub.
