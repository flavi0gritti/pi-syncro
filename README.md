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
