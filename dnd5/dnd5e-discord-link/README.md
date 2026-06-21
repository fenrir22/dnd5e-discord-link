# D&D5e Discord Link

Modulo Foundry VTT v13 + Bot Discord per collegare Discord alla partita di D&D5e.
Assegna schede personaggio a utenti Discord e lascia che controllino il personaggio da Discord.

## Architettura

```
Discord  ←→  Bot (tuo server)  ←→  Modulo Foundry (outbound WebSocket)
                   ↑
            Cloudflare Tunnel
            (wss://dndlink.tuodominio.it)
```

Il **bot fa da ponte**: si connette a Discord e fa da server WebSocket.
Il **modulo Foundry si connette al bot** (outbound), nessuna porta da aprire.

## Installazione

### 1. Modulo Foundry

Copia la cartella in `Data/modules/` di Foundry. Attiva il modulo da Impostazioni → Moduli.

Configura dal modulo:
- **Bot WebSocket URL**: `wss://dndlink.tuodominio.it` (o `ws://IP:4758` in LAN)
- **API Key**: genera una chiave e copiala (servirà al bot e al modulo)

### 2. Bot Discord (Docker)

```bash
cd bot
cp .env.example .env
# modifica DISCORD_TOKEN con il token del tuo bot Discord
docker compose up -d
```

Esponi la porta 4758 con Cloudflare Tunnel:
```yaml
# config.yml di cloudflared
tunnel: il-tuo-tunnel
ingress:
  - hostname: dndlink.tuodominio.it
    service: http://localhost:4758
  - service: http_status:404
```

### 3. App Discord

1. https://discord.com/developers/applications → New Application → Bot
2. Copia il token in `DISCORD_TOKEN`
3. Invita il bot con scope `bot` + `applications.commands`

### 4. Collega i personaggi

1. Assicurati che il bot sia connesso (vedi stato nel modulo Foundry)
2. Vai in **Impostazioni → Moduli → D&D5e Discord Link → Gestisci Collegamenti**
3. Inserisci l'**ID utente Discord** (fai click destro sul nome → Copia ID)
4. Seleziona il personaggio Foundry
5. Clicca **Collega**

## Comandi Discord

| Comando | Descrizione |
|---------|-------------|
| `/collega` | Collega un utente a un personaggio |
| `/scheda` | Scheda completa |
| `/status` | HP, CA, condizioni |
| `/tiro tipo:nome` | Tira abilità/TS/skill |
| `/azioni` | Elenca armi e azioni |
| `/attacca arma:` | Tiro per colpire (autocomplete) |
| `/danno arma:` | Tiro danno (opzione critico) |
| `/incantesimi` | Incantesimi preparati |
| `/ping` | Stato del bot |
| `/help` | Aiuto |

## Docker

```bash
docker compose up -d                  # avvia
docker compose logs -f                # log
docker compose down                   # stop
docker compose pull                   # aggiorna
```

I collegamenti sono persistenti grazie al volume `dnd5e-links`.

## Sviluppo locale

```bash
cd bot
npm install
# imposta DISCORD_TOKEN, WS_PORT, LINKS_FILE
npm run dev
```

Il modulo Foundry si connette a `ws://localhost:4758`.
