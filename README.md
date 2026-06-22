# D&D5e Discord Link

[![Foundry v13](https://img.shields.io/badge/Foundry-v13-green)](https://foundryvtt.com)
[![D&D5e v4.x](https://img.shields.io/badge/D&D5e-v4.x-blue)](https://github.com/foundryvtt/dnd5e)

**Manifest URL per Foundry:**
```
https://raw.githubusercontent.com/fenrir22/dnd5e-discord-link/master/dnd5e-discord-link/module.json
```

Modulo Foundry VTT v13 + Bot Discord per controllare il personaggio di D&D5e da Discord.
Tiri per colpire, danni, abilità, tiri salvezza, scheda, status — tutto da Discord.

## Architettura

```
Discord  ←→  Bot (tuo server)  ←→  Modulo Foundry (outbound WebSocket)
                   ↑
            Cloudflare Tunnel
            (wss://dndlink.tuodominio.it)
```

Il **bot fa da server WebSocket** su porta 4758.
Il **modulo Foundry si connette al bot** (chiamata outbound) — nessuna porta da aprire su Foundry.
Multi-istanza: più partite Foundry possono connettersi allo stesso bot.

## Prerequisiti

- Foundry VTT **v13** con sistema **D&D5e v3.x**
- Server con **Docker** e **docker compose**
- Cloudflare Tunnel (cloudflared) per esporre il bot
- Un'applicazione Discord con token

## 1. App Discord

1. Vai su https://discord.com/developers/applications → **New Application**
2. Vai su **Bot** → **Reset Token** → copia il token (sarà `DISCORD_TOKEN`)
3. Nella sezione **OAuth2 → URL Generator**:
   - Scopes: `bot`, `applications.commands`
   - Permessi: `Send Messages`, `Embed Links`, `Read Message History`
4. Apri l'URL generato in un browser e invita il bot nel tuo server

## 2. Bot Discord (Docker)

```bash
git clone https://github.com/fenrir22/dnd5e-discord-link.git
cd dnd5e-discord-link/bot

# Configura
cp .env.example .env
nano .env
```

**.env**:
```env
DISCORD_TOKEN=il_tuo_token_discord
WS_PORT=4758
FOUNDRY_API_KEY=una_chiave_a_caso
LINKS_FILE=./data/links.json
```

```bash
# Avvia
docker compose up -d

# Verifica log
docker compose logs -f
```

Se tutto ok vedrai: `[Discord] Loggato come NomeBot#1234`

## 3. Cloudflare Tunnel

Installa cloudflared sul server e crea un tunnel:

```yaml
# ~/.cloudflared/config.yml
tunnel: il-tuo-tunnel-id
credentials-file: /root/.cloudflared/il-tuo-tunnel-id.json
ingress:
  - hostname: dndlink.tuodominio.it
    service: http://localhost:4758
  - service: http_status:404
```

Avvia:
```bash
cloudflared tunnel run
```

## 4. Modulo Foundry

1. Copia la cartella `dnd5e-discord-link/` in `Data/modules/` del tuo Foundry
2. Avvia Foundry → **Impostazioni → Moduli → D&D5e Discord Link → Attiva**
3. Configura:
   - **Bot URL**: `wss://dndlink.tuodominio.it` (o `ws://IP_SERVER:4758` in LAN)
   - **API Key**: stessa chiave del `.env` del bot
4. Salva — il modulo si connetterà automaticamente al bot

Stato visibile nella sezione "D&D5e Discord Link" delle Impostazioni.

## 5. Collega personaggi

1. Apri **Impostazioni → Moduli → D&D5e Discord Link → Gestisci Collegamenti**
2. Inserisci l'**ID utente Discord** del giocatore
   - Discord → Impostazioni → Avanzate → Attiva "Modalità Sviluppatore"
   - Click destro sul nome utente → Copia ID
3. Seleziona il personaggio Foundry da collegare
4. Clicca **Collega**

Il bot salva i collegamenti su volume Docker (persistenti).

## Comandi Discord

| Comando | Descrizione |
|---------|-------------|
| `/collega` | Collega il tuo account Discord a un personaggio |
| `/scheda` | Scheda completa (abilità, skill, HP, CA, classe, razza) |
| `/status` | HP, CA, condizioni, ispirazione |
| `/tiro tipo: skill nome:percezione [modalita: vantaggio] [bonus: +1d4]` | Tira skill/abilità/tiro salvezza (autocomplete) |
| `/puro formula: 1d20+5 [modalita: vantaggio] [bonus: +1d4]` | Tiro libero con formula personalizzata |
| `/azioni` | Elenca armi, incantesimi e talenti disponibili |
| `/attacca arma: spada lunga [modalita: vantaggio] [bonus: +1d4]` | Tiro per colpire (incluso danno automatico) |
| `/danno arma: spada lunga [critico: true] [bonus: +1d4]` | Tiro danno separato (con opzione critico e bonus) |
| `/incantesimi` | Incantesimi preparati con slot |
| `/switch personaggio: Nome` | Cambia personaggio attivo tra quelli collegati |
| `/iniziativa` | Tira iniziativa per il tuo personaggio nel combat attivo |
| `/ping` | Stato del bot e connessioni attive |
| `/help` | Lista comandi |

I tiri appaiono sia su Discord che nella chat di Foundry.

## Vantaggio / Svantaggio / Bonus

I comandi `/tiro` e `/attacca` supportano le opzioni `modalita` e `bonus`:

- **`modalita: vantaggio`** — tira con vantaggio (usa `2d20kh` nella formula)
- **`modalita: svantaggio`** — tira con svantaggio (usa `2d20kl` nella formula)
- **`bonus: +1d4`** — bonus personalizzato aggiunto alla formula del tiro

### Strategia di rolling

```
Tiro normale               → API nativa Foundry (actor.rollSkill / activity.rollAttack)
Tiro con adv/svantaggio    → Formula custom (2d20kh/2d20kl + modificatore + bonus)
Tiro con bonus             → Formula custom con +{bonus} in coda
```

**Perché non usare sempre l'API nativa?**

Il sistema D&D5e v3.x (5.2.x su Foundry v13) **NON supporta** `advantage`
/ `disadvantage` / `bonus` come parametri delle API di roll (`rollSkill`,
`rollAbilityCheck`, `rollSavingThrow`, `rollAttack`). Passare
`{ advantage: true }` non produce effetto.

Abbiamo quindi scelto un approccio ibrido:

- **Nessuna opzione** → chiamata API Foundry nativa (risultato ufficiale in
  chat, compatibile con aggiornamenti del sistema)
- **Con adv/svantaggio/bonus** → costruiamo manualmente la formula Roll
  (es. `2d20kh + 5 + 1d4`), la valutiamo con `new Roll().evaluate()`, e la
  inviamo in chat Foundry con `roll.toMessage()`. Il messaggio in chat
  Foundry mostra la formula completa con i dadi e i risultati.

### Per comando

| Comando | Normale | Con opzioni |
|---------|---------|-------------|
| `/tiro skill/ability/save` | `actor.rollSkill` / `actor.rollAbilityCheck` / `actor.rollSavingThrow` con `{ create: true }` | Formula manuale + `roll.toMessage()` |
| `/attacca` | `activity.rollAttack` con `{ create: true }` | `activity.rollAttack({ create: false })` → estrae formula → sostituisce `1d20` con `2d20kh/2d20kl` → `new Roll()`. `evaluate()`. `toMessage()` |
| `/danno` | Formula costruita manualmente (sempre) | Idem + `{ bonus }` aggiunto ai parts |

### Foundry v13: Roll getter-only

In Foundry v13, le proprietà `formula`, `total`, `terms` del Roll sono getter
sul prototype, NON scrivibili direttamente. Questo ha reso impossibile
modificare un roll esistente con:

```js
roll.formula = roll.formula + " (Vantaggio)";  // ERRORE in v13
```

Abbiamo sperimentato diverse soluzioni prima di arrivare a quella attuale:

1. **Mutazione `_formula`/`_total`/`_terms`** — modifica le proprietà interne
   sottolineate. Funziona ma `toMessage` inviava un oggetto Roll parziale in
   cui Foundry non riusciva a renderizzare i dadi (perdeva la struttura dei
   termini).
2. **`Object.defineProperty` per sovrascrivere i getter** — tecnicamente
   funzionante, ma il Roll risultante perdeva la connessione al sistema di
   rendering dadi di Foundry perché i termini modificati non erano più
   istanze valide di `DieTerm`.
3. **Formula sostituita prima della valutazione** — soluzione finale: invece
   di modificare un roll già valutato, costruiamo una formula completa
   (es. `2d20kh + 5 + 1d4`), creiamo un `new Roll(formula)` FRESCO,
   lo valutiamo e lo inviamo con `roll.toMessage()`. Foundry gestisce
   correttamente il rendering perché il Roll è un'istanza valida e completa.

**Per gli attacchi**: usiamo `activity.rollAttack({ create: false })` per
ottenere la formula base del modificatore (calcolato dal sistema), poi
sostituiamo `1d20` con `2d20kh`/`2d20kl` e aggiungiamo il bonus facoltativo.
Così il modificatore di attacco è sempre calcolato correttamente dal sistema
D&D5e (abilità, prof., bonus arma), e solo il dado viene modificato.

### Nomi completi

Skill, ability e tiri salvezza mostrano il **nome localizzato completo**
(es. "Furtività" invece di "ste") sia su Discord che nella chat Foundry.
La risoluzione usa:

- **Discord**: mappa `SKILL_NAMES` / `ABILITY_NAMES` con traduzione italiana
- **Foundry**: lookup su `CONFIG.DND5E.skills[key].label` con
  `game.i18n.localize()` per supportare localizzazione automatica

### Codice custom (RollHandler.js)

| Metodo | Descrizione |
|--------|-------------|
| `_createAndSendRoll` | Costruisce formula Roll con adv/svantaggio/bonus, valuta e invia in chat Foundry |
| `_skillLabel(key)` | Restituisce il nome localizzato di una skill da `CONFIG.DND5E.skills` |
| `_abilityLabel(key)` | Restituisce il nome localizzato di un'ability/save da `CONFIG.DND5E.abilities` |
| `handleRollPuro` | Tiro libero: accetta formula custom (es. `3d8+2`), adv/svantaggio e bonus. Usato da `/puro` |

Metodi rimossi dopo il refactoring:
- `_rollWithAdvantage` — non più necessario: la formula viene costruita
  direttamente con `2d20kh`/`2d20kl` prima della valutazione
- `_applyBonus` — non più necessario: il bonus viene aggiunto direttamente
  alla formula (`formula + bonusFormula`) prima di creare il Roll

## Docker Compose

```bash
docker compose up -d       # avvia
docker compose logs -f     # log in tempo reale
docker compose down        # ferma
docker compose pull        # aggiorna immagine
```

Volume `dnd5e-links` per persistenza collegamenti.

## Sviluppo locale

```bash
cd bot
npm install

# Imposta nel tuo .env:
# DISCORD_TOKEN, WS_PORT=4758, FOUNDRY_API_KEY, LINKS_FILE=./data/links.json

npm run dev
```

Il modulo Foundry si connette a `ws://localhost:4758` in sviluppo.

## HP in tempo reale

Quando il DM modifica i PF di un personaggio in Foundry (danno, cura, temp HP),
il modulo invia un aggiornamento immediato via WebSocket al bot, che lo pubblica
nel canale Discord configurato.

```
Esempio in Discord:
  Selerio bruno
  4 PF subito (21/27)
```

- L'aggiornamento è **istantaneo** (WebSocket, non polling)
- Solo i personaggi **collegati a un utente Discord** generano notifiche
- Il nome del personaggio viene dal modulo Foundry (non dal link)
- Supporta danni, cure e temp HP

### Storico

Inizialmente il modulo usava un **polling ogni 15 secondi** dal bot verso
Foundry per rilevare cambiamenti HP. Questo causava:

- Notifiche duplicate (WebSocket + polling)
- Ritardo di fino a 15 secondi
- Traffico inutile

Ora il polling è **rimosso**: l'unico canale è il WebSocket in tempo reale,
attivato dall'hook `preUpdateActor` + `updateActor` di Foundry.

## Struttura repo

```
bot/                       # Bot Discord (Node.js + Docker)
  index.js                 # Entry point del bot
  Dockerfile               # Immagine Docker
  docker-compose.yml       # Stack Docker
  package.json             # Dipendenze Node.js
  .env.example             # Template configurazione

dnd5e-discord-link/        # Modulo Foundry VTT
  module.json              # Manifest del modulo
  scripts/
    main.js                # Punto di ingresso
    BotClient.js           # WebSocket client + azioni
    RollHandler.js         # Gestione tiri (v3.x activity API)
    LinkingUI.js           # UI di collegamento
    settings.js            # Impostazioni modulo
  templates/
    linking.html           # Template UI collegamento
  lang/
    en.json, it.json       # Traduzioni
  styles/
    styles.css             # Stili UI
```

## Compatibilità

- **Foundry VTT**: v13
- **Sistema D&D5e**: v3.x (5.2.x PHB 2024)
- **API Discord.js**: v14
- **Node.js**: 18+
