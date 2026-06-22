import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, StringSelectMenuBuilder, ActionRowBuilder } from 'discord.js';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { randomBytes } from 'crypto';

// ── Config ─────────────────────────────────────────────────────────────
const CONFIG = {
  discordToken: process.env.DISCORD_TOKEN || '',
  wsPort: parseInt(process.env.WS_PORT || '4758', 10),
  linksFile: process.env.LINKS_FILE || './data/links.json',
  apiKey: process.env.FOUNDRY_API_KEY || '',
};

if (!CONFIG.discordToken) {
  console.error('Manca DISCORD_TOKEN');
  process.exit(1);
}

const SKILL_NAMES = {
  acr: 'Acrobazia', ani: 'Addestrare Animali', arc: 'Arcano',
  ath: 'Atletica', dec: 'Inganno', his: 'Storia', ins: 'Intuizione',
  itm: 'Intimidire', inv: 'Indagare', med: 'Medicina', nat: 'Natura',
  pcp: 'Percezione', prf: 'Intrattenere', per: 'Persuasione',
  rel: 'Religione', slt: 'Rapidità di Mano', ste: 'Furtività', sur: 'Sopravvivenza',
};

const ABILITY_NAMES = {
  str: 'Forza', dex: 'Destrezza', con: 'Costituzione',
  int: 'Intelligenza', wis: 'Saggezza', cha: 'Carisma',
};

function getFullName(tipo, nome) {
  const key = nome.toLowerCase();
  if (tipo === 'skill') return SKILL_NAMES[key] || nome;
  return ABILITY_NAMES[key] || nome;
}

// ── Persistenza links ──────────────────────────────────────────────────
const links = new Map(); // discordId -> { activeActorId, activeActorName, gameId, gameName, characters: [{ actorId, actorName }] }

function loadLinks() {
  try {
    if (existsSync(CONFIG.linksFile)) {
      const data = JSON.parse(readFileSync(CONFIG.linksFile, 'utf-8'));
      for (const [k, v] of Object.entries(data)) links.set(k, v);
      console.log(`[Links] Caricati ${links.size} collegamenti`);
    }
  } catch (err) { console.error('[Links] Errore caricamento:', err.message); }
}

function saveLinks() {
  try {
    const obj = Object.fromEntries(links);
    writeFileSync(CONFIG.linksFile, JSON.stringify(obj, null, 2));
  } catch (err) { console.error('[Links] Errore salvataggio:', err.message); }
}

loadLinks();

// ── Sessioni Foundry ───────────────────────────────────────────────────
const sessions = new Map(); // gameId -> { ws, apiKey, gameName, connectedAt }
const combatMessages = new Map(); // gameId -> { messageId, channelId }

// ── Discord Client ─────────────────────────────────────────────────────
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

// ── Comandi Slash ──────────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName('collega')
    .setDescription('Collega il tuo account Discord a un personaggio di Foundry')
    .addUserOption(o => o.setName('utente').setDescription('Utente da collegare (solo GM)')),

  new SlashCommandBuilder()
    .setName('scheda')
    .setDescription('Mostra la scheda del tuo personaggio'),

  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Mostra lo stato del personaggio (HP, condizioni)'),

  new SlashCommandBuilder()
    .setName('tiro')
    .setDescription('Tira un dado (abilità, tiro salvezza o skill)')
    .addStringOption(o => o.setName('tipo').setDescription('Tipo').setRequired(true)
      .addChoices(
        { name: 'Abilità', value: 'ability' },
        { name: 'Tiro Salvezza', value: 'save' },
        { name: 'Skill', value: 'skill' },
      ))
    .addStringOption(o => o.setName('nome').setDescription('Nome').setRequired(true).setAutocomplete(true))
    .addStringOption(o => o.setName('modalita').setDescription('Vantaggio o svantaggio')
      .addChoices(
        { name: 'Normale', value: 'normal' },
        { name: 'Vantaggio', value: 'advantage' },
        { name: 'Svantaggio', value: 'disadvantage' },
      ))
    .addStringOption(o => o.setName('bonus').setDescription('Bonus extra (es: 1d4, +2, 1d6+1)')),

  new SlashCommandBuilder()
    .setName('azioni')
    .setDescription('Mostra le armi e azioni disponibili'),

  new SlashCommandBuilder()
    .setName('attacca')
    .setDescription('Tira per colpire con un\'arma')
    .addStringOption(o => o.setName('arma').setDescription('Nome dell\'arma').setRequired(true).setAutocomplete(true))
    .addStringOption(o => o.setName('modalita').setDescription('Vantaggio o svantaggio')
      .addChoices(
        { name: 'Normale', value: 'normal' },
        { name: 'Vantaggio', value: 'advantage' },
        { name: 'Svantaggio', value: 'disadvantage' },
      ))
    .addStringOption(o => o.setName('bonus').setDescription('Bonus extra (es: 1d4, +2, 1d6+1)')),

  new SlashCommandBuilder()
    .setName('danno')
    .setDescription('Tira il danno di un\'arma')
    .addStringOption(o => o.setName('arma').setDescription('Nome dell\'arma').setRequired(true).setAutocomplete(true))
    .addBooleanOption(o => o.setName('critico').setDescription('Tiro critico?'))
    .addStringOption(o => o.setName('bonus').setDescription('Bonus extra (es: 1d4, +2, 1d6+1)')),

  new SlashCommandBuilder()
    .setName('incantesimi')
    .setDescription('Mostra gli incantesimi preparati'),

  new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Stato del bot'),

  new SlashCommandBuilder()
    .setName('help')
    .setDescription('Mostra i comandi disponibili'),

  new SlashCommandBuilder()
    .setName('switch')
    .setDescription('Cambia personaggio attivo')
    .addStringOption(o => o.setName('personaggio').setDescription('Nome del personaggio').setRequired(true).setAutocomplete(true)),

  new SlashCommandBuilder()
    .setName('iniziativa')
    .setDescription("Tira iniziativa per il tuo personaggio"),

  new SlashCommandBuilder()
    .setName('puro')
    .setDescription('Tiro libero con formula personalizzata')
    .addStringOption(o => o.setName('formula').setDescription('Formula del dado (es: 1d20+5, 3d6+2)').setRequired(true))
    .addStringOption(o => o.setName('modalita').setDescription('Vantaggio o svantaggio')
      .addChoices(
        { name: 'Normale', value: 'normal' },
        { name: 'Vantaggio', value: 'advantage' },
        { name: 'Svantaggio', value: 'disadvantage' },
      ))
    .addStringOption(o => o.setName('bonus').setDescription('Bonus extra (es: 1d4, +2, 1d6+1)')),
];

// ── WebSocket Server ───────────────────────────────────────────────────
const httpServer = createServer();
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  console.log('[WS] Nuova connessione in attesa di registrazione...');

  const timeout = setTimeout(() => {
    console.log('[WS] Timeout registrazione, chiusura');
    ws.close(4001, 'Registration timeout');
  }, 15000);

  ws.once('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'register' && msg.apiKey && msg.gameId) {
        if (CONFIG.apiKey && msg.apiKey !== CONFIG.apiKey) {
          clearTimeout(timeout);
          ws.close(4000, 'Invalid API key');
          return;
        }
        clearTimeout(timeout);
        const existing = sessions.get(msg.gameId);
        if (existing && existing.ws !== ws) {
          console.log(`[WS] Sostituzione sessione esistente per ${msg.gameId}`);
          try { existing.ws.close(4002, 'New session replacing'); } catch {}
        }

        sessions.set(msg.gameId, {
          ws,
          apiKey: msg.apiKey,
          gameName: msg.gameName || msg.gameId,
          connectedAt: Date.now(),
          channelId: msg.channelId || null,
          combatChannelId: msg.combatChannelId || msg.channelId || null,
        });

        console.log(`[WS] ${msg.gameName} (${msg.gameId}) registrato${msg.channelId ? ' con canale HP' : ''}${msg.combatChannelId ? ' e turni' : ''}`);

        ws.authenticated = true;
        ws.gameId = msg.gameId;
        ws.send(JSON.stringify({ type: 'registered', gameId: msg.gameId }));

        ws.on('message', (raw) => {
          try {
            const m = JSON.parse(raw.toString());
            handleFoundryMessage(ws, m);
          } catch {}
        });

        ws.on('close', () => {
          sessions.delete(msg.gameId);
          console.log(`[WS] ${msg.gameName} disconnesso`);

          for (const [discordId, link] of links) {
            if (link.gameId === msg.gameId) links.delete(discordId);
          }
          saveLinks();
        });

        ws.on('error', () => sessions.delete(msg.gameId));
      } else {
        clearTimeout(timeout);
        ws.close(4000, 'Invalid registration');
      }
    } catch {
      clearTimeout(timeout);
      ws.close(4000, 'Invalid JSON');
    }
  });
});

function handleFoundryMessage(ws, msg) {
  // Gestisce messaggi da Foundry
  switch (msg.type) {
    case 'link': {
      const existing = links.get(msg.discordId);
      if (existing) {
        if (!existing.characters.find(c => c.actorId === msg.actorId)) {
          existing.characters.push({ actorId: msg.actorId, actorName: msg.actorName });
        }
        existing.activeActorId = msg.actorId;
        existing.activeActorName = msg.actorName;
      } else {
        links.set(msg.discordId, {
          activeActorId: msg.actorId,
          activeActorName: msg.actorName,
          gameId: ws.gameId,
          gameName: sessions.get(ws.gameId)?.gameName || 'Unknown',
          characters: [{ actorId: msg.actorId, actorName: msg.actorName }],
        });
      }
      saveLinks();
      ws.send(JSON.stringify({ type: 'link_ok', discordId: msg.discordId }));
      break;
    }
    case 'unlink': {
      if (msg.actorId) {
        const entry = links.get(msg.discordId);
        if (entry) {
          entry.characters = entry.characters.filter(c => c.actorId !== msg.actorId);
          if (entry.activeActorId === msg.actorId) {
            entry.activeActorId = entry.characters[0]?.actorId || null;
            entry.activeActorName = entry.characters[0]?.actorName || null;
          }
          if (!entry.characters.length) {
            links.delete(msg.discordId);
          }
        }
      } else {
        links.delete(msg.discordId);
      }
      saveLinks();
      ws.send(JSON.stringify({ type: 'unlink_ok', discordId: msg.discordId }));
      break;
    }
    case 'pong':
      break;
    case 'hp_update': {
      (async () => {
        const sess = sessions.get(ws.gameId);
        if (!sess?.channelId) return;
        let channel;
        try { channel = await client.channels.fetch(sess.channelId); } catch {}
        if (!channel) return;

        const { discordId, actorName, newHp, maxHp, newTemp, diff } = msg;
        const label = diff > 0 ? 'recuperato' : 'subito';
        const color = diff > 0 ? 0x4CAF50 : 0xF44336;
        const absDiff = Math.abs(diff);

        if (discordId) {
          hpCache.set(discordId, { value: newHp, temp: newTemp || 0 });
        }

        const embed = new EmbedBuilder()
          .setColor(color)
          .setTitle(actorName)
          .setDescription(`**${absDiff}** PF ${label} (${newHp}/${maxHp}${newTemp ? ` +${newTemp} temp` : ''})`)
          .setTimestamp();

        await channel.send({ embeds: [embed] }).catch(() => {});
      })();
      break;
    }
    case 'combat_start': {
      (async () => {
        const sess = sessions.get(ws.gameId);
        if (!sess?.combatChannelId) return;
        let channel;
        try { channel = await client.channels.fetch(sess.combatChannelId); } catch {}
        if (!channel) return;

        const { sceneName, round, combatants } = msg;
        if (!combatants?.length) return;
        const current = combatants.find(c => c.isCurrent);

        const existing = combatMessages.get(ws.gameId);
        if (existing) {
          try {
            const msgObj = await channel.messages.fetch(existing.messageId);
            await msgObj.edit({ embeds: [buildCombatEmbed(sceneName, round, combatants, current)] });
            return;
          } catch {
            combatMessages.delete(ws.gameId);
          }
        }

        const sent = await channel.send({ embeds: [buildCombatEmbed(sceneName, round, combatants, current)] });
        combatMessages.set(ws.gameId, { messageId: sent.id, channelId: sent.channelId });
      })();
      break;
    }
    case 'combat_update': {
      (async () => {
        const existing = combatMessages.get(ws.gameId);
        if (!existing) return;

        const sess = sessions.get(ws.gameId);
        if (!sess?.combatChannelId) return;
        const { sceneName, round, combatants } = msg;
        if (!combatants?.length) return;
        const current = combatants.find(c => c.isCurrent);

        try {
          const channel = await client.channels.fetch(existing.channelId);
          const msgObj = await channel.messages.fetch(existing.messageId);
          await msgObj.edit({ embeds: [buildCombatEmbed(sceneName, round, combatants, current)] });
        } catch {}
      })();
      break;
    }
    case 'combat_end': {
      (async () => {
        const existing = combatMessages.get(ws.gameId);
        if (existing) {
          try {
            const channel = await client.channels.fetch(existing.channelId).catch(() => null);
            if (channel) {
              const msgObj = await channel.messages.fetch(existing.messageId).catch(() => null);
              if (msgObj) {
                await msgObj.edit({ embeds: [new EmbedBuilder()
                  .setColor(0x888888)
                  .setTitle(`[OK] Combat Terminato — ${msg.sceneName}`)
                  .setTimestamp()
                ]});
              }
            }
          } catch {}
          combatMessages.delete(ws.gameId);
        }
      })();
      break;
    }
    case 'execute_result':
    case 'request_result': {
      const pending = pendingRequests.get(msg.requestId);
      if (pending) {
        pending.resolve(msg.result);
        pendingRequests.delete(msg.requestId);
      }
      break;
    }
  }
}

// ── HP polling (disabilitato — ora usiamo WebSocket in tempo reale) ────
const hpCache = new Map(); // ancora usato da hp_update per evitare log spuri

// ── Gestione richieste pending ─────────────────────────────────────────
const pendingRequests = new Map();

function sendToFoundry(gameId, message, discordId, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const session = sessions.get(gameId);
    if (!session || session.ws.readyState !== 1) {
      return reject(new Error(`Foundry ${gameId} non connesso`));
    }

    const requestId = `req_${Date.now()}_${randomBytes(4).toString('hex')}`;
    message.requestId = requestId;
    if (discordId) message.discordId = discordId;
    pendingRequests.set(requestId, { resolve, reject, timer: null });

    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error('Timeout: Foundry non ha risposto in tempo'));
    }, timeoutMs);

    pendingRequests.get(requestId).timer = timer;

    try {
      session.ws.send(JSON.stringify(message));
    } catch (err) {
      clearTimeout(timer);
      pendingRequests.delete(requestId);
      reject(err);
    }
  });
}

// ── Helper per trovare la sessione Foundry ─────────────────────────────
function getSessionForDiscord(discordId) {
  const link = links.get(discordId);
  if (!link) return null;
  const session = sessions.get(link.gameId);
  if (!session || session.ws.readyState !== 1) return null;
  return { session, link };
}

// ── Discord Ready ──────────────────────────────────────────────────────
client.once('ready', async () => {
  console.log(`[Discord] Loggato come ${client.user.tag}`);

  try {
    const rest = new REST({ version: '10' }).setToken(CONFIG.discordToken);
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log('[Discord] Comandi slash registrati');
  } catch (err) {
    console.error('[Discord] Errore registrazione comandi:', err.message);
  }

});

// ── Autocomplete ───────────────────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isAutocomplete()) return;

  const cmd = interaction.commandName;
  const focusedOption = interaction.options.getFocused(true);
  const focused = focusedOption.value.toLowerCase();
  const focusedName = focusedOption.name;
  const sess = getSessionForDiscord(interaction.user.id);
  if (!sess) return interaction.respond([]);

  try {
    if (cmd === 'tiro') {
      if (focusedName !== 'nome') return interaction.respond([]);
      
      const tipo = interaction.options.getString('tipo');
      let choices = [];
      if (tipo === 'ability' || tipo === 'save') {
        const abil = { str: 'Forza', dex: 'Destrezza', con: 'Costituzione', int: 'Intelligenza', wis: 'Saggezza', cha: 'Carisma' };
        choices = Object.entries(abil).map(([k, v]) => ({ name: `${v} (${k})`, value: k }));
      } else if (tipo === 'skill') {
        const result = await sendToFoundry(sess.link.gameId, {
          type: 'request', action: 'list_skills', params: {},
        }, interaction.user.id);
        choices = (result?.skills || []).map(s => ({ name: `${s.label} (${s.key})`, value: s.key }));
      } else {
        const abil = { str: 'Forza', dex: 'Destrezza', con: 'Costituzione', int: 'Intelligenza', wis: 'Saggezza', cha: 'Carisma' };
        choices = Object.entries(abil).map(([k, v]) => ({ name: `${v} (${k})`, value: k }));
      }
      const filtered = choices.filter(c => c.name.toLowerCase().includes(focused) || c.value.includes(focused)).slice(0, 25);
      return interaction.respond(filtered);
    }

    if (cmd === 'switch') {
      if (focusedName !== 'personaggio') return interaction.respond([]);
      
      const entry = links.get(interaction.user.id);
      const choices = (entry?.characters || []).map(c => ({
        name: c.actorName,
        value: c.actorName,
      }));
      const filtered = choices.filter(c => c.name.toLowerCase().includes(focused) || c.value.toLowerCase().includes(focused)).slice(0, 25);
      return interaction.respond(filtered);
    }

    if (cmd === 'attacca' || cmd === 'danno') {
      if (focusedName !== 'arma') return interaction.respond([]);
    }

    const result = await sendToFoundry(sess.link.gameId, {
      type: 'request',
      action: 'list_actions',
      params: {},
    }, interaction.user.id);
    const items = (result?.actions || []).filter(a => a.type === 'weapon' || a.type === 'spell');
    const filtered = items
      .filter(i => i.name.toLowerCase().includes(focused))
      .slice(0, 25)
      .map(i => ({ name: i.name, value: i.name }));
    await interaction.respond(filtered);
  } catch {
    await interaction.respond([]);
  }
});

// ── Slash Command Handler ──────────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    await handlers[interaction.commandName]?.(interaction);
  } catch (err) {
    console.error(`[Command] ${interaction.commandName}:`, err.message, err.stack);
    const content = `[ERR] Errore: ${err.message}`;
    if (interaction.deferred) {
      await interaction.editReply(content).catch(() => {});
    } else if (interaction.replied) {
      await interaction.followUp({ content, ephemeral: true }).catch(() => {});
    } else {
      await interaction.reply({ content, ephemeral: true }).catch(() => {});
    }
  }
});

function buildCombatEmbed(sceneName, round, combatants, current) {
  const turnName = current?.name || combatants.find(c => !c.isDefeated)?.name || '—';
  const lines = combatants.map(c => {
    let icon = c.isCurrent ? '>' : '  ';
    if (c.isDefeated) icon = '[†]';
    const init = c.initiative != null ? `[${c.initiative}]` : '[—]';
    const hpStr = c.hp ? ` ${c.hp.value}/${c.hp.max}` : '';
    const acStr = c.ac ? ` CA:${c.ac}` : '';
    const condStr = c.conditions?.length ? ` [cond]${c.conditions.slice(0, 2).join(',')}` : '';
    return `${icon} ${init} **${c.name}**${hpStr}${acStr}${condStr}`;
  });

  return new EmbedBuilder()
    .setColor(0xE53935)
    .setTitle(`${sceneName} — Round ${round}`)
    .setDescription(`**> Tocca a ${turnName}**\n${lines.join('\n')}`)
    .setTimestamp();
}

const handlers = {
  async ping(interaction) {
    const connected = sessions.size;
    const linked = links.size;
    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('Pong!')
        .addFields(
          { name: 'Foundry connesse', value: `${connected}`, inline: true },
          { name: 'Collegamenti attivi', value: `${linked}`, inline: true },
          { name: 'Latenza Discord', value: `${client.ws.ping}ms`, inline: true },
        )
        .setTimestamp()],
      ephemeral: true,
    });
  },

  async help(interaction) {
    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('D&D5e Discord Link — Comandi')
        .setDescription('Controlla il tuo personaggio di Foundry VTT da Discord!')
        .addFields(
          { name: '/collega', value: 'Collega il tuo account a un personaggio' },
          { name: '/scheda', value: 'Scheda completa del personaggio' },
          { name: '/status', value: 'Stato (HP, CA, condizioni)' },
          { name: '/tiro', value: 'Tira abilità/skill/tiro salvezza' },
          { name: '/puro', value: 'Tiro libero con formula personalizzata' },
          { name: '/azioni', value: 'Elenca armi e azioni' },
          { name: '/attacca', value: 'Tira per colpire' },
          { name: '/danno', value: 'Tira il danno' },
          { name: '/incantesimi', value: 'Incantesimi preparati' },
          { name: '/switch', value: 'Cambia personaggio attivo' },
          { name: '/iniziativa', value: 'Tira iniziativa' },
          { name: '/ping', value: 'Stato del bot' },
        )],
      ephemeral: true,
    });
  },

  async collega(interaction) {
    const target = interaction.options.getUser('utente') || interaction.user;
    const discordId = target.id;
    const isGM = interaction.memberPermissions?.has(8n);

    if (!isGM) {
      await interaction.reply({
        content: 'Chiedi al DM di collegare il tuo personaggio tramite l\'interfaccia del modulo in Foundry.',
        ephemeral: true,
      });
      return;
    }

    if (sessions.size === 0) {
      await interaction.reply({ content: '[ERR] Nessuna istanza di Foundry connessa al bot.', ephemeral: true });
      return;
    }

    // Mostra la lista dei personaggi dalla prima Foundry connessa
    const firstGameId = sessions.keys().next().value;
    try {
      const result = await sendToFoundry(firstGameId, {
        type: 'request',
        action: 'get_available_characters',
        params: {},
      });

      if (!result?.characters?.length) {
        await interaction.reply({ content: '[ERR] Nessun personaggio trovato in Foundry.', ephemeral: true });
        return;
      }

      const select = new StringSelectMenuBuilder()
        .setCustomId(`link_${discordId}_${firstGameId}`)
        .setPlaceholder('Seleziona un personaggio...')
        .addOptions(result.characters.slice(0, 25).map(c => ({
          label: `${c.name} (Lv.${c.level} ${c.class})`,
          description: `${c.race}${c.player ? ` — ${c.player}` : ''}`,
          value: c.id,
        })));

      await interaction.reply({
        content: `Collega <@${discordId}> a un personaggio:`,
        components: [new ActionRowBuilder().addComponents(select)],
        ephemeral: true,
      });
    } catch (err) {
      await interaction.reply({ content: `[ERR] Errore: ${err.message}`, ephemeral: true });
    }
  },

  async scheda(interaction) {
    await interaction.deferReply();
    const sess = getSessionForDiscord(interaction.user.id);
    if (!sess) return interaction.editReply('[ERR] Non hai un personaggio collegato.');

    let result;
    try {
      result = await sendToFoundry(sess.link.gameId, {
        type: 'request',
        action: 'get_sheet',
        params: {},
      }, interaction.user.id);
    } catch (err) {
      return interaction.editReply(`[ERR] ${err.message}`);
    }

    if (result?.error) return interaction.editReply(`[ERR] ${result.error}`);
    if (!result) return interaction.editReply('[ERR] Errore nel recupero scheda.');

    try {
      const s = result;
      const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle(`Scheda: ${s.name}`)
        .setDescription(`**${s.race} ${s.class}** — Lv.${s.level}`)
        .addFields(
          { name: 'PF', value: `${s.hp.value}/${s.hp.max}${s.hp.temp ? ` (+${s.hp.temp})` : ''}`, inline: true },
          { name: 'CA', value: `${s.ac}`, inline: true },
          { name: 'Iniziativa', value: `${s.initiative >= 0 ? '+' : ''}${s.initiative}`, inline: true },
          { name: 'Velocità', value: `${s.speed} ft`, inline: true },
          { name: 'Competenza', value: `+${s.proficiency}`, inline: true },
          { name: 'Ispirazione', value: s.inspiration ? '[OK]' : '[ERR]', inline: true },
        );

      if (s.conditions?.length > 0) {
        embed.addFields({ name: 'Condizioni', value: s.conditions.join(', ') });
      }

      const abilFields = ['str', 'dex', 'con', 'int', 'wis', 'cha'].map(k => {
        const a = s.abilities?.[k];
        return {
          name: a?.label || k.toUpperCase(),
          value: `**${a?.value || 10}** (${a?.modifier >= 0 ? '+' : ''}${a?.modifier || 0})`,
          inline: true,
        };
      });

      const abilEmbed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('Caratteristiche')
        .addFields(...abilFields);

      const proficientSkills = Object.entries(s.skills || {})
        .filter(([, sk]) => sk.proficient)
        .sort((a, b) => b[1].modifier - a[1].modifier);

      for (let i = 0; i < proficientSkills.length; i += 8) {
        const chunk = proficientSkills.slice(i, i + 8);
        abilEmbed.addFields({
          name: i === 0 ? 'Competenze' : '‎',
          value: chunk.map(([, sk]) =>
            `${sk.expertise ? '' : '[OK] '}${sk.label}: **${sk.modifier >= 0 ? '+' : ''}${sk.modifier}**`
          ).join('\n'),
          inline: true,
        });
      }

      await interaction.editReply({ embeds: [embed, abilEmbed] });
    } catch (err) {
      console.error(`[scheda] Errore costruzione embed:`, err);
      await interaction.editReply(`[ERR] Errore: ${err.message}`);
    }
  },

  async status(interaction) {
    await interaction.deferReply();
    const sess = getSessionForDiscord(interaction.user.id);
    if (!sess) return interaction.editReply('[ERR] Non hai un personaggio collegato.');

    const result = await sendToFoundry(sess.link.gameId, {
      type: 'request',
      action: 'get_status',
      params: {},
    }, interaction.user.id);

    if (result?.error) return interaction.editReply(`[ERR] ${result.error}`);
    if (!result) return interaction.editReply('[ERR] Errore nel recupero status.');

    const hpPct = result.hp.percentage;
    const color = hpPct >= 50 ? 0x4CAF50 : hpPct >= 30 ? 0xFF9800 : 0xF44336;
    const icon = hpPct >= 50 ? '[OK]' : hpPct >= 30 ? '[!]' : '[ERR]';

    await interaction.editReply({
      embeds: [new EmbedBuilder()
        .setColor(color)
        .setTitle('Stato Personaggio')
        .addFields(
          { name: 'PF', value: `${result.hp.value}/${result.hp.max} (${hpPct}%)`, inline: true },
          { name: 'CA', value: `${result.ac}`, inline: true },
          { name: 'Livello', value: `${result.level}`, inline: true },
        )
        .addFields(
          result.conditions?.length
            ? { name: 'Condizioni', value: result.conditions.join('\n') }
            : { name: 'Condizioni', value: 'Nessuna', inline: true },
        )
        .setFooter({ text: `${icon} ${hpPct >= 50 ? 'In buona salute' : hpPct >= 30 ? 'Ferito' : 'In pericolo'}` })
      ],
    });
  },

  async tiro(interaction) {
    await interaction.deferReply();
    const sess = getSessionForDiscord(interaction.user.id);
    if (!sess) return interaction.editReply('[ERR] Non hai un personaggio collegato.');

    const tipo = interaction.options.getString('tipo');
    const nome = interaction.options.getString('nome').toLowerCase();
    const modalita = interaction.options.getString('modalita') || 'normal';
    const bonus = interaction.options.getString('bonus');

    const actionMap = { ability: 'roll_ability', save: 'roll_save', skill: 'roll_skill' };
    const params = { [tipo === 'skill' ? 'skillId' : 'abilityId']: nome };
    if (modalita === 'advantage') params.advantage = true;
    if (modalita === 'disadvantage') params.disadvantage = true;
    if (bonus) params.bonus = bonus;

    const result = await sendToFoundry(sess.link.gameId, {
      type: 'execute',
      action: actionMap[tipo],
      params,
    }, interaction.user.id);

    if (result?.error) return interaction.editReply(`[ERR] ${result.error}`);
    if (!result?.success) return interaction.editReply(`[ERR] ${result?.error || 'Tiro fallito'}`);

    const r = result.roll;
    const modeText = modalita === 'advantage' ? ' (Vantaggio)' : modalita === 'disadvantage' ? ' (Svantaggio)' : '';
    const bonusText = bonus ? ` + ${bonus}` : '';

    await interaction.editReply({
      embeds: [new EmbedBuilder()
        .setColor(0x9C27B0)
        .setTitle(`Tiro: ${tipo.toUpperCase()}: ${getFullName(tipo, nome)}${modeText}${bonusText}`)
        .setDescription(`**Risultato: ${r.total}**`)
        .addFields(
          { name: 'Formula', value: `\`${r.formula}\``, inline: true },
          { name: 'Tiri', value: r.termsDisplay || (r.terms || []).map(t => `\`${t}\``).join(' ') || '—', inline: true },
        )
        .setTimestamp()],
    });
  },

  async azioni(interaction) {
    await interaction.deferReply();
    const sess = getSessionForDiscord(interaction.user.id);
    if (!sess) return interaction.editReply('[ERR] Non hai un personaggio collegato.');

    const result = await sendToFoundry(sess.link.gameId, {
      type: 'request',
      action: 'list_actions',
      params: {},
    }, interaction.user.id);

    if (result?.error) return interaction.editReply(`[ERR] ${result.error}`);
    if (!result?.actions?.length) return interaction.editReply('Nessuna azione disponibile.');

    const byType = { weapon: [], spell: [], feat: [], other: [] };
    for (const a of result.actions) {
      if (byType[a.type]) byType[a.type].push(a);
      else byType.other.push(a);
    }

    const embed = new EmbedBuilder().setColor(0xFF5722).setTitle('Azioni Disponibili');

    if (byType.weapon.length > 0) {
      embed.addFields({
        name: `Armi (${byType.weapon.length})`,
        value: byType.weapon.map(w =>
          `**${w.name}**${w.damage?.length ? ` [${w.damage.join(', ')}]` : ''}${w.uses !== null ? ` (${w.uses}/${w.usesMax})` : ''}`
        ).join('\n'),
      });
    }

    if (byType.spell.length > 0) {
      const prepared = byType.spell.filter(s => s.prepared);
      embed.addFields({
        name: `Incantesimi (${prepared.length}/${byType.spell.length})`,
        value: prepared.slice(0, 10).map(s =>
          `**Lv.${s.level}** ${s.name}${s.uses !== null ? ` [${s.uses}/${s.usesMax}]` : ''}`
        ).join('\n'),
      });
    }

    if (byType.feat.length > 0) {
      embed.addFields({
        name: `Talenti (${byType.feat.length})`,
        value: byType.feat.slice(0, 8).map(f =>
          `**${f.name}**${f.uses !== null ? ` (${f.uses}/${f.usesMax})` : ''}`
        ).join('\n'),
      });
    }

    embed.addFields({ name: '', value: 'Usa `/attacca` o `/danno` per usare le armi' });
    await interaction.editReply({ embeds: [embed] });
  },

  async puro(interaction) {
    await interaction.deferReply();
    const sess = getSessionForDiscord(interaction.user.id);
    if (!sess) return interaction.editReply('[ERR] Non hai un personaggio collegato.');

    const formula = interaction.options.getString('formula');
    const modalita = interaction.options.getString('modalita') || 'normal';
    const bonus = interaction.options.getString('bonus');

    const params = { formula };
    if (modalita === 'advantage') params.advantage = true;
    if (modalita === 'disadvantage') params.disadvantage = true;
    if (bonus) params.bonus = bonus;

    const result = await sendToFoundry(sess.link.gameId, {
      type: 'execute',
      action: 'roll_puro',
      params,
    }, interaction.user.id);

    if (result?.error) return interaction.editReply(`[ERR] ${result.error}`);
    if (!result?.success) return interaction.editReply(`[ERR] ${result?.error || 'Tiro fallito'}`);

    const r = result.roll;
    const modeText = modalita === 'advantage' ? ' (Vantaggio)' : modalita === 'disadvantage' ? ' (Svantaggio)' : '';
    const bonusText = bonus ? ` + ${bonus}` : '';
    const title = `Tiro Libero${modeText}${bonusText}`;

    await interaction.editReply({
      embeds: [new EmbedBuilder()
        .setColor(0x9C27B0)
        .setTitle(title)
        .setDescription(`**Risultato: ${r.total}**`)
        .addFields(
          { name: 'Formula', value: `\`${r.formula}\``, inline: true },
          { name: 'Tiri', value: r.termsDisplay || '—', inline: true },
        )
        .setTimestamp()],
    });
  },

  async attacca(interaction) {
    await interaction.deferReply();
    const sess = getSessionForDiscord(interaction.user.id);
    if (!sess) return interaction.editReply('[ERR] Non hai un personaggio collegato.');

    const armaNome = interaction.options.getString('arma').toLowerCase();
    const modalita = interaction.options.getString('modalita') || 'normal';
    const bonus = interaction.options.getString('bonus');

    const actions = await sendToFoundry(sess.link.gameId, {
      type: 'request', action: 'list_actions', params: {},
    }, interaction.user.id);

    if (actions?.error) return interaction.editReply(`[ERR] ${actions.error}`);

    const weapon = (actions?.actions || []).find(a =>
      (a.type === 'weapon' || a.type === 'spell') && a.name.toLowerCase() === armaNome
    );

    if (!weapon) return interaction.editReply(`[ERR] Arma "${armaNome}" non trovata. Usa /azioni.`);

    const params = { itemId: weapon.id };
    if (modalita === 'advantage') params.advantage = true;
    if (modalita === 'disadvantage') params.disadvantage = true;
    if (bonus) params.bonus = bonus;

    const result = await sendToFoundry(sess.link.gameId, {
      type: 'execute',
      action: 'roll_attack',
      params,
    }, interaction.user.id);

    if (result?.error) return interaction.editReply(`[ERR] ${result.error}`);
    if (!result?.success) return interaction.editReply(`[ERR] ${result?.error || 'Attacco fallito'}`);

    const modeText = modalita === 'advantage' ? ' (Vantaggio)' : modalita === 'disadvantage' ? ' (Svantaggio)' : '';
    const bonusText = bonus ? ` + ${bonus}` : '';

    const embed = new EmbedBuilder()
      .setColor(0xF44336)
      .setTitle(`${weapon.name}${modeText}${bonusText}`)
      .setDescription(`**Tiro per Colpire: ${result.roll.total}**`)
      .addFields({ name: 'Formula', value: `\`${result.roll.formula}\``, inline: true });

    if (result.damageRoll) {
      embed.addFields(
        { name: 'Danno', value: `**${result.damageRoll.total}**`, inline: true },
        { name: 'Formula Danno', value: `\`${result.damageRoll.formula}\``, inline: true },
      );
    }

    await interaction.editReply({ embeds: [embed] });
  },

  async danno(interaction) {
    await interaction.deferReply();
    const sess = getSessionForDiscord(interaction.user.id);
    if (!sess) return interaction.editReply('[ERR] Non hai un personaggio collegato.');

    const armaNome = interaction.options.getString('arma').toLowerCase();
    const critico = interaction.options.getBoolean('critico') || false;
    const bonus = interaction.options.getString('bonus');

    const actions = await sendToFoundry(sess.link.gameId, {
      type: 'request', action: 'list_actions', params: {},
    }, interaction.user.id);

    if (actions?.error) return interaction.editReply(`[ERR] ${actions.error}`);

    const weapon = (actions?.actions || []).find(a =>
      (a.type === 'weapon' || a.type === 'spell') && a.name.toLowerCase() === armaNome
    );

    if (!weapon) return interaction.editReply(`[ERR] Arma "${armaNome}" non trovata.`);

    const params = { itemId: weapon.id, critical: critico };
    if (bonus) params.bonus = bonus;

    const result = await sendToFoundry(sess.link.gameId, {
      type: 'execute',
      action: 'roll_damage',
      params,
    }, interaction.user.id);

    if (result?.error) return interaction.editReply(`[ERR] ${result.error}`);
    if (!result?.success) return interaction.editReply(`[ERR] ${result?.error || 'Danno fallito'}`);

    const bonusText = bonus ? ` + ${bonus}` : '';

    await interaction.editReply({
      embeds: [new EmbedBuilder()
        .setColor(0xFF5722)
        .setTitle(`${weapon.name}${critico ? ' (CRITICO!)' : ''}${bonusText}`)
        .setDescription(`**Danno: ${result.roll.total}**`)
        .addFields({ name: 'Formula', value: `\`${result.roll.formula}\``, inline: true })
        .setTimestamp()],
    });
  },

  async incantesimi(interaction) {
    await interaction.deferReply();
    const sess = getSessionForDiscord(interaction.user.id);
    if (!sess) return interaction.editReply('[ERR] Non hai un personaggio collegato.');

    const result = await sendToFoundry(sess.link.gameId, {
      type: 'request', action: 'list_actions', params: {},
    }, interaction.user.id);

    if (result?.error) return interaction.editReply(`[ERR] ${result.error}`);

    const spells = (result?.actions || []).filter(a => a.type === 'spell' && a.prepared);
    if (!spells.length) return interaction.editReply('Nessun incantesimo preparato.');

    const embed = new EmbedBuilder().setColor(0x2196F3).setTitle('Incantesimi Preparati');

    if (result.spellSlots) {
      const slots = Object.entries(result.spellSlots)
        .filter(([k]) => k.startsWith('spell'))
        .map(([k, v]) => `Lv.${k.replace('spell', '')}: ${v.value || 0}/${v.max || 0}`)
        .join(' | ');
      if (slots) embed.setDescription(`Slot: ${slots}`);
    }

    const byLevel = {};
    for (const s of spells) {
      const lv = s.level ?? 0;
      (byLevel[lv] = byLevel[lv] || []).push(s);
    }

    Object.entries(byLevel)
      .sort(([a], [b]) => Number(a) - Number(b))
      .forEach(([level, list]) => {
        embed.addFields({
          name: `${level === '0' ? 'Trucchetti' : `Liv. ${level}`} (${list.length})`,
          value: list.map(s => `**${s.name}**${s.uses !== null ? ` [${s.uses}/${s.usesMax}]` : ''}`).join('\n'),
        });
      });

    await interaction.editReply({ embeds: [embed] });
  },

  async switch(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const sess = getSessionForDiscord(interaction.user.id);
    if (!sess) return interaction.editReply('[ERR] Nessun personaggio collegato.');

    const nome = interaction.options.getString('personaggio');
    const entry = links.get(interaction.user.id);
    const target = (entry?.characters || []).find(c => c.actorName.toLowerCase() === nome.toLowerCase());
    if (!target) return interaction.editReply(`[ERR] Personaggio "${nome}" non trovato tra i tuoi collegati.`);

    const result = await sendToFoundry(sess.link.gameId, {
      type: 'execute', action: 'update_link',
      params: { discordId: interaction.user.id, actorId: target.actorId, actorName: target.actorName },
    }, interaction.user.id);

    if (result?.error) return interaction.editReply(`[ERR] ${result.error}`);

    entry.activeActorId = target.actorId;
    entry.activeActorName = target.actorName;
    saveLinks();
    hpCache.delete(interaction.user.id);

    await interaction.editReply(`[OK] Passato a **${target.actorName}**`);
  },

  async iniziativa(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const sess = getSessionForDiscord(interaction.user.id);
    if (!sess) return interaction.editReply('[ERR] Non hai un personaggio collegato.');

    const result = await sendToFoundry(sess.link.gameId, {
      type: 'execute', action: 'roll_initiative', params: { discordId: interaction.user.id },
    }, interaction.user.id, 30000);

    if (result?.error) return interaction.editReply(`[ERR] ${result.error}`);

    await interaction.editReply({ content: `[OK] Iniziativa: **${result.initiative}**`, ephemeral: true });
  },
};

// ── Select menu handler (collega) ──────────────────────────────────────
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isStringSelectMenu()) return;
  if (!interaction.customId.startsWith('link_')) return;

  const parts = interaction.customId.split('_');
  const discordId = parts[1];
  const gameId = parts.slice(2).join('_');
  const actorId = interaction.values[0];

  if (!interaction.memberPermissions?.has(8n)) {
    return interaction.reply({ content: '[ERR] Solo il DM può usare questo comando.', ephemeral: true });
  }

  try {
    const result = await sendToFoundry(gameId, {
      type: 'request',
      action: 'get_character',
      params: { actorId },
    }, discordId);

    const actorName = result?.name || actorId;
    const existing = links.get(discordId);
    if (existing) {
      if (!existing.characters.find(c => c.actorId === actorId)) {
        existing.characters.push({ actorId, actorName });
      }
      existing.activeActorId = actorId;
      existing.activeActorName = actorName;
      existing.gameId = gameId;
      existing.gameName = sessions.get(gameId)?.gameName || 'Unknown';
    } else {
      links.set(discordId, {
        activeActorId: actorId,
        activeActorName: actorName,
        gameId,
        gameName: sessions.get(gameId)?.gameName || 'Unknown',
        characters: [{ actorId, actorName }],
      });
    }
    saveLinks();

    await interaction.update({
      content: `[OK] <@${discordId}> collegato a **${actorName}**!`,
      components: [],
    });
  } catch (err) {
    await interaction.update({
      content: `[ERR] Errore: ${err.message}`,
      components: [],
    });
  }
});

// ── Avvio ──────────────────────────────────────────────────────────────
httpServer.listen(CONFIG.wsPort, '0.0.0.0', () => {
  console.log(`[WS] Server WebSocket in ascolto su 0.0.0.0:${CONFIG.wsPort}`);
  console.log(`[WS] I moduli Foundry devono connettersi a ws://IP_SERVER:${CONFIG.wsPort} o via tunnel`);
});

client.login(CONFIG.discordToken).catch(err => {
  console.error('[Discord] Login fallito:', err.message);
  process.exit(1);
});
