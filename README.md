# pi-syncro

Una configurazione Pi condivisa su GitHub, con eccezioni private per ogni computer.

```sh
pi install git:github.com/flavi0gritti/pi-syncro
```

Richiede Node >= 22.19, Git configurato con nome/email e accesso al repository. La directory è quella di Pi (`~/.pi/agent`, oppure `PI_CODING_AGENT_DIR`).

## Le tre scatole

1. **Scelte condivise:** tema, pacchetti, modello preferito, modelli abilitati, keybindings, configurazioni MCP, `models.json`, risorse.
2. **Eccezioni di questo PC:** `settings.local.json` e `.syncignore`. Non viaggiano su GitHub e vengono rispettate durante il pull.
3. **Dati locali:** credenziali, sessioni, directory rigenerabili, `models-store.json` e `lastChangelogVersion`. Non diventano conflitti tra computer.

`models-store.json` è il catalogo dinamico di Pi; `models.json` contiene invece personalizzazioni da condividere. Se il vecchio catalogo era tracciato, il prossimo push ne mostra la rimozione **solo da GitHub**. Il file rimane su ciascun computer, anche quando un pull ne riceve la rimozione.

## Push e pull: prima il confronto, poi la conferma

- `/sync push`: **GitHub → versione realmente da inviare**. Non riscrive i file locali.
- `/sync pull`: **questo PC → versione risultante**, dopo aver conservato le modifiche locali e applicato le eccezioni di questa macchina.
- Vecchio e nuovo affiancati; nei terminali stretti una colonna. Solo righe rosse `-` e verdi `+`, nessuno stato `~`.
- Le eccezioni mantenute attive su questo PC sono indicate nel confronto.
- Frecce, PgUp/PgDn e Home/End scorrono; le righe lunghe vanno a capo.
- **Invio conferma e procede, Esc annulla senza modificare file.** Nessun editor o secondo dialogo per un confronto normale.

I JSON sono formattati per leggibilità: i numeri di riga si riferiscono a questa rappresentazione. Campi sensibili e URL vengono mascherati; i file privati non mostrano contenuti. Per file non JSON si mostrano descrizioni in byte, non il testo. Differenze di solo formato o di valori mascherati hanno segnaposto `-` e `+`. Non inserire segreti in campi arbitrari: il mascheramento non è uno scanner completo.

I comandi `diff`, `preview` e `dry-run` sono rimossi: il confronto è incluso in push e pull. La schermata grafica richiede la modalità interattiva TUI; la CLI offre gli stessi flussi in testo.

## Quando un computer resta indietro

Il pull confronta **l’ultima versione condivisa accettata (HEAD), le modifiche attuali del PC e GitHub**. Essere rimasti indietro di molti push non è un conflitto.

- Un’impostazione cambiata solo su GitHub viene aggiornata.
- Una cambiata solo su questo PC viene conservata.
- Modifiche a campi diversi dello stesso JSON si uniscono nel piano mostrato, anche dentro oggetti annidati (`compaction.enabled`, server MCP, ecc.).
- Se entrambi hanno cambiato la **stessa scelta** in modi diversi, viene mostrato il confronto locale/GitHub e puoi scegliere quale tenere, oppure annullare tutto. Solo dopo aver risolto i conflitti arriva il confronto finale da confermare.
- `packages` ed `enabledModels` si uniscono per voce: aggiunte indipendenti si conservano, una rimozione non viene resuscitata dal PC vecchio. Per i pacchetti si riconosce la sorgente anche con versioni/ref diverse; opzioni o versioni incompatibili chiedono una scelta.
- Gli altri array sono ordinati: se modificati in due modi diversi chiedono una scelta, senza indovinarne l’ordine.
- Modifica contro cancellazione è un vero conflitto. I file non JSON si risolvono per file intero.

Il pull sposta HEAD alla versione remota accettata; le scelte locali conservate restano disponibili per un successivo push. Non vengono committate automaticamente durante il pull.

Un push con novità remote si ferma e chiede prima un pull: **nessun rebase nascosto**. Storie Git divergenti/commit locali incompatibili richiedono ancora assistenza Git manuale; questa versione non riscrive la cronologia. File nello stage, operazioni Git incomplete, branch diversi da `main`, symlink e submodule bloccano il sync.

## Eccezioni di questo PC, da terminale

Dentro Pi:

```text
/sync local
```

Apre il menu per vedere le eccezioni, forzare/rimuovere impostazioni locali, escludere/riabilitare provider e pacchetti, impostare i valori di riserva o applicare un file modificato a mano. **Ogni modifica mostra prima il confronto e richiede conferma.** Dopo aver confermato, le eccezioni sono materializzate in `settings.json`; esegui `/reload` per ricaricare Pi.

Sono disponibili anche comandi diretti:

```text
/sync local show
/sync local set hideThinkingBlock false
/sync local set compaction.enabled false
/sync local set theme "light"
/sync local unset theme
/sync local exclude-provider deepseek
/sync local include-provider deepseek
/sync local exclude-package git:github.com/utente/pacchetto
/sync local include-package git:github.com/utente/pacchetto
/sync local fallback defaultProvider openai-codex
/sync local fallback defaultModel il-tuo-modello
/sync local apply
```

`set` richiede un valore **JSON**: booleani senza virgolette, stringhe con virgolette, array/oggetti validi. I percorsi usano punti; per chiavi che contengono punti o slash è disponibile JSON Pointer, ad esempio `/modelThinkingLevels/openai~1model.v1`.

Lo stesso menu e gli stessi comandi sono disponibili fuori da Pi:

```sh
node /percorso/pi-syncro/cli.mjs local
node /percorso/pi-syncro/cli.mjs local set compaction.enabled false
node /percorso/pi-syncro/cli.mjs local set theme '"light"'
node /percorso/pi-syncro/cli.mjs local exclude-provider deepseek
```

Le virgolette da shell dipendono dal terminale: il menu guidato evita problemi di escaping. La CLI rifiuta conferme automatiche senza terminale interattivo. `local show` è di sola lettura e non crea file. La modifica delle eccezioni funziona anche offline, dopo aver inizializzato il repository.

### Formato del file locale

Il vecchio formato resta supportato:

```json
{
  "excludedProviders": ["deepseek"],
  "defaultProvider": "openai-codex",
  "defaultModel": "modello-di-riserva",
  "excludedPackages": ["git:github.com/utente/pacchetto"],
  "overrides": {
    "hideThinkingBlock": false,
    "compaction.enabled": false
  }
}
```

- `excludedProviders` filtra `enabledModels` e adatta i default se puntano a un provider escluso. I campi radice `defaultProvider` e `defaultModel` sono **fallback**, non sostituzioni globali.
- `excludedPackages` toglie quei pacchetti dall’elenco caricato su questo PC, senza disinstallarne le cartelle o rimuoverli dalla configurazione comune.
- `overrides` forza una scelta di `settings.json` soltanto qui; il push conserva invece il valore condiviso. Per forzare sempre modello/provider, usa ad esempio `overrides.defaultModel` e `overrides.defaultProvider`.
- Le esclusioni di provider/pacchetti prevalgono anche su override locali dell’intera lista.
- Escludere un provider **non è un logout né un blocco di rete**: non vengono cancellate le credenziali e non si modificano i cataloghi. È una preferenza di selezione/default di Pi, non un controllo di sicurezza aziendale.

Commenti `//` ammessi su righe separate. Il menu riscrive il JSON dopo la conferma, quindi non conserva i commenti. JSON errato, percorsi non sicuri o override sovrapposti vengono rifiutati. Vengono verificati anche i tipi di alcune impostazioni comuni; per le altre resta necessario rispettare il formato previsto da Pi.

Se modifichi a mano il file, usa `local apply`: confronta vecchie e nuove eccezioni conservando i valori condivisi. Le nuove regole non vengono mai assorbite silenziosamente da un push. Gli override generici creati a mano prima del primo stato locale richiedono anch’essi `local apply`; il vecchio filtro provider viene riconosciuto automaticamente.

### Il piccolo stato privato

Pi-syncro conserva in `.git/pi-sync-local-state.json` i valori condivisi nascosti dalle eccezioni. Serve per ripristinare la scelta corretta quando togli un’eccezione, anche se era una modifica non ancora inviata. Non viene caricato su GitHub ed è legato al commit locale accettato: se HEAD cambia con comandi Git esterni, il tool si ferma per non riutilizzare valori nascosti ormai vecchi. **Non cancellarlo per risolvere un conflitto**: recuperalo dal backup se danneggiato. Un file non valido blocca l’operazione invece di indovinare.

### Escludere file interi

```text
/sync ignore list
/sync ignore add models.json
/sync ignore remove models.json
```

Stessi comandi nella CLI (`node cli.mjs ignore ...`). Gestiscono `.syncignore`: un pattern relativo per riga, `*` e `?`, commenti su righe separate. Le modifiche richiedono confronto e conferma. I file esclusi rimangono invariati sia sul PC sia sul remoto. Le esclusioni automatiche di credenziali/cataloghi hanno precedenza: non si possono riabilitare per errore con un pattern.

## Altri comandi

`/sync setup <url>` collega il repository senza inviare/scaricare impostazioni; `/sync remote` mostra il remote, `/sync status` lo stato Git locale, `/sync log` gli ultimi commit. Equivalenti nella CLI. Su Windows è disponibile anche `pisync.ps1`.

## Protezioni e limiti

- Fetch aggiorna solo metadati/riferimenti Git prima del confronto. Annullare non cambia impostazioni, stato locale o HEAD.
- Prima di applicare si ricontrollano HEAD, indice, file condivisi, regole locali, stato privato e remoto. Se sono cambiati serve un nuovo confronto. Un aggiornamento di `models-store.json` non invalida il piano.
- Nessun `git clean`, reset forzato, force-push o checkout dei file locali durante un push.
- Credenziali (`auth.json`, `mcp-auth.json`, `.env*`, nomi di segreti/token/chiavi private), sessioni e directory rigenerabili sono escluse. JSON con campi sensibili non vuoti o URL con credenziali vengono bloccati in uscita, anche nei commit locali ancora da pubblicare. Il controllo è prudente, non completo: può bloccare anche riferimenti a variabili d’ambiente nei campi sensibili.
- File privati già tracciati vengono rimossi solo dalla versione corrente condivisa, dopo conferma. **I segreti nei vecchi commit restano lì: revocali e ripulisci la cronologia separatamente.**
- Un lock `.git/pi-sync.lock` impedisce due applicazioni contemporanee di pi-syncro. Non blocca altri programmi: evita modifiche concorrenti mentre confermi/applichi. Dopo un crash controlla backup e stato prima di rimuovere un lock rimasto.

Prima delle scritture viene creato un backup in `.git/pi-sync-backups/<data-id>/`, con `files/`, `manifest.json`, ed eventuali copie precedenti di regole e stato privato. Il percorso viene comunicato alla fine o in caso di errore di ripristino. Il backup contiene dati privati: non condividerlo. Conserva anche lo stato attuale prima di recuperare manualmente i file. Non esiste ancora un comando di rollback completo della cronologia. Un push remoto riuscito non può essere annullato automaticamente da un errore successivo locale.

## Test

```sh
npm ci --ignore-scripts --legacy-peer-deps
npm test
```

I test usano repository temporanei locali: non la tua configurazione né GitHub. Coprono il ciclo tra due computer, molti push seguiti da un pull vecchio, merge per campo e per pacchetto, veri conflitti, eccezioni legacy/generiche, rimozione di eccezioni, menu/CLI, annullamenti, cache, credenziali, anteprime scadute, errori e backup. La workflow CI è predisposta per Linux, Windows e macOS con Node 22 e 24; i controlli grafici richiedono inoltre il runtime Pi.
