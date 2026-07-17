# pi-syncro

Sync della configurazione di [pi coding agent](https://github.com/earendil-works/pi) tra dispositivi (macOS, Linux, Windows) tramite GitHub.

## Installazione (qualsiasi OS)

```bash
pi install git:github.com/flavi0gritti/pi-syncro
```

Funziona ovunque: macOS, Linux, Windows (PowerShell, CMD, Git Bash, WSL).

## Utilizzo dentro pi

Una volta installato, hai i comandi `/sync`:

| Comando | Descrizione |
|---------|-------------|
| `/sync setup <url>` | Collega la config al repo GitHub |
| `/sync push` | Carica la config su GitHub |
| `/sync pull` | Scarica la config da GitHub (con anteprima e conferma) |
| `/sync diff` | **Anteprima:** cosa cambierebbe col pull, senza applicare |
| `/sync status` | Stato: modifiche locali, differenze col remote |
| `/sync log` | Storico degli ultimi 20 sync |
| `/sync remote [url]` | Mostra o imposta l'URL del remote |

## CLI standalone (terminale, senza pi)

```bash
# macOS / Linux / Git Bash / WSL
pisync push | pull | diff | status | log | setup | remote

# Windows PowerShell
.\pisync.ps1 push | pull | diff | status | log | setup | remote
```

Il comando `pisync` funziona aggiungendo la cartella del pacchetto al PATH:

**macOS / Linux:**
```bash
echo 'export PATH="$HOME/.pi/agent/git/github.com/flavi0gritti/pi-syncro:$PATH"' >> ~/.zshrc
```

**Windows PowerShell (profilo):**
```powershell
$pkg = "$env:USERPROFILE\.pi\agent\git\github.com\flavi0gritti\pi-syncro"
[Environment]::SetEnvironmentVariable("Path", "$pkg;" + [Environment]::GetEnvironmentVariable("Path", "User"), "User")
```

## Setup primo dispositivo

```bash
# 1. Installa pi-syncro
pi install git:github.com/flavi0gritti/pi-syncro

# 2. Dentro pi:
/sync setup https://github.com/flavi0gritti/pi-config.git
/sync push
```

## Setup secondo dispositivo (Windows incluso)

```bash
# 1. Installa pi (già fatto)
# 2. Installa pi-syncro
pi install git:github.com/flavi0gritti/pi-syncro

# 3. Dentro pi:
/sync setup https://github.com/flavi0gritti/pi-config.git

# 4. Vedi cosa sta per arrivare:
/sync diff

# 5. Applica:
/sync pull
```

## Windows — nota importante

Su Windows, l'installazione è identica. `pi install git:...` funziona nativamente.
Una volta installato:

- **Dentro pi:** usa `/sync` normalmente
- **Da terminale:** puoi usare `node %USERPROFILE%\.pi\agent\git\github.com\flavi0gritti\pi-syncro\cli.mjs` o aggiungere la cartella al PATH

## Cosa viene sincronizzato

`settings.json` · `keybindings.json` · `models.json` · `themes/` · `extensions/*.ts, *.json` · `skills/` · `pi-info.json`

## Cosa NON viene sincronizzato

`auth.json` (API key) · `sessions/` · `npm/` · `tmp/` · `bin/`

### Impostazioni locali per-macchina (`settings.local.json`)

Pi-syncro supporta un file `~/.pi/agent/settings.local.json` (non sincronizzato) che adatta automaticamente la configurazione alla macchina corrente dopo ogni `/sync pull`.

**Al primo `/sync pull`** su una macchina nuova, il file viene creato come template:

```json
// settings.local.json — configurazione locale per questa macchina
// Questo file NON viene sincronizzato. Modificalo per adattare pi
// alla macchina corrente (es. escludere provider non approvati).
{
  "excludedProviders": [],
  "defaultProvider": "",
  "defaultModel": ""
}
```

Poi lo personalizzi. Esempio per escludere DeepSeek e impostare GPT-5.4-mini come default:

```json
{
  "excludedProviders": ["deepseek"],
  "defaultProvider": "openai-codex",
  "defaultModel": "gpt-5.4-mini"
}
```

Dopo ogni `/sync pull`, pi-syncro automaticamente:
- Rimuove i provider in `excludedProviders` da `models-store.json`
- Filtra `enabledModels` in `settings.json`
- Corregge `defaultProvider` / `defaultModel` se puntano a provider esclusi
- Pulisce `auth.json` dalle API key dei provider esclusi

**Comandi:**
```
/sync local            → mostra il contenuto di settings.local.json
/sync local edit       → crea/apri il file per modificarlo
/sync local apply      → ri-applica le regole subito (per test)
```

**Esempio pratico — DeepSeek solo su Mac personale:**

Sul **PC Windows da lavoro**:
```
/sync local edit
```
Imposti `"excludedProviders": ["deepseek"]`, `"defaultProvider": "openai-codex"`, `"defaultModel": "gpt-5.4-mini"`, salvi e fai `/reload`. Fine.

Sul **Mac personale**: nessun `settings.local.json` → DeepSeek rimane attivo.

**Se cambi PC lavoro in futuro:**
- Sul nuovo PC, dopo il primo `/sync pull` verrà creato automaticamente un nuovo template
- Lo personalizzi di nuovo con gli stessi valori (o con valori diversi per quella macchina)
- Niente copia-incolla: ogni macchina ha il suo `settings.local.json` indipendente

### Esclusioni per-macchina (`.syncignore`)

Puoi creare un file `~/.pi/agent/.syncignore` (non sincronizzato) per escludere file specifici solo sulla macchina corrente:
