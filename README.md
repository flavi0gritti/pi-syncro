# pi-syncro

Sync della configurazione di [pi coding agent](https://github.com/earendil-works/pi) tra dispositivi (macOS, Linux, Windows) tramite GitHub.

## Installazione

```bash
pi install github:flavi0gritti/pi-syncro
```

## Utilizzo in pi

Una volta installato, hai a disposizione i comandi `/sync`:

| Comando | Descrizione |
|---------|-------------|
| `/sync setup <url>` | Collega la config al repo GitHub |
| `/sync push` | Carica la config su GitHub |
| `/sync pull` | Scarica la config da GitHub |
| `/sync status` | Stato: modifiche locali, differenze col remote |
| `/sync log` | Storico degli ultimi 20 sync |
| `/sync remote [url]` | Mostra o imposta l'URL del remote |

## Setup primo dispositivo

```bash
# Installa pi-syncro
pi install github:flavi0gritti/pi-syncro

# In pi:
/sync setup https://github.com/flavi0gritti/pi-config.git
/sync push
```

## Setup secondo dispositivo

```bash
# Installa pi e pi-syncro
pi install github:flavi0gritti/pi-syncro

# In pi:
/sync setup https://github.com/flavi0gritti/pi-config.git
/sync pull
```

## CLI standalone (fuori da pi)

```bash
node ~/.pi/agent/npm/node_modules/pi-syncro/cli.mjs push
node ~/.pi/agent/npm/node_modules/pi-syncro/cli.mjs pull
node ~/.pi/agent/npm/node_modules/pi-syncro/cli.mjs status
```

## Cosa viene sincronizzato

`settings.json` · `keybindings.json` · `models.json` · `themes/` · `extensions/*.ts, *.json` · `skills/` · `pi-info.json`

## Cosa NON viene sincronizzato

`auth.json` (API key) · `sessions/` · `npm/` · `tmp/` · `bin/`
