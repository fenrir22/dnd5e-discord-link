import { SettingsManager } from './settings.js';
import { RollHandler } from './RollHandler.js';

export class BotClient {
  constructor() {
    this.ws = null;
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.connected = false;
    this.gameId = null;
  }

  async connect() {
    const url = SettingsManager.getBotUrl();
    const apiKey = SettingsManager.getApiKey();

    if (!url || !apiKey) {
      console.log('D&D5e Discord Link | Bot URL o API Key non configurati.');
      return;
    }

    this._connect(url, apiKey);
  }

  _connect(url, apiKey) {
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }

    try {
      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        console.log(`D&D5e Discord Link | Connesso al bot: ${url}`);
        this.ws.send(JSON.stringify({
          type: 'register',
          apiKey,
          gameId: game.world.id,
          gameName: game.world.title,
        }));
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          this._handleMessage(msg);
        } catch (err) {
          console.error('D&D5e Discord Link | Messaggio non valido:', err);
        }
      };

      this.ws.onclose = (event) => {
        console.log(`D&D5e Discord Link | Disconnesso (${event.code})`);
        this.connected = false;
        SettingsManager.setBotConnected(false);
        this._scheduleReconnect(url, apiKey);
      };

      this.ws.onerror = () => {};

    } catch (err) {
      console.error('D&D5e Discord Link | Errore connessione:', err);
      this._scheduleReconnect(url, apiKey);
    }
  }

  _scheduleReconnect(url, apiKey) {
    if (this.reconnectTimer) return;
    const delay = 5000;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._connect(url, apiKey);
    }, delay);
  }

  _handleMessage(msg) {
    switch (msg.type) {
      case 'registered':
        this.connected = true;
        this.gameId = msg.gameId;
        SettingsManager.setBotConnected(true);
        console.log(`D&D5e Discord Link | Registrato come "${msg.gameId}"`);
        this._startPing();
        this._syncLinks();
        break;

      case 'ping':
        this._send({ type: 'pong' });
        break;

      case 'link_ok':
        console.log(`D&D5e Discord Link | Link confermato dal bot: ${msg.discordId}`);
        break;

      case 'unlink_ok':
        console.log(`D&D5e Discord Link | Unlink confermato dal bot: ${msg.discordId}`);
        break;

      case 'execute':
        this._handleExecute(msg);
        break;

      case 'request':
        this._handleRequest(msg);
        break;

      case 'error':
        console.error('D&D5e Discord Link | Errore dal bot:', msg.message);
        break;
    }
  }

  _send(data) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  _handleExecute(msg) {
    const actor = this._getActorForDiscord(msg.discordId);
    if (!actor) {
      return this._send({
        type: 'execute_result',
        requestId: msg.requestId,
        result: { error: 'Personaggio non trovato per questo utente Discord' },
      });
    }
    this._executeAndReply('execute_result', msg, actor);
  }

  _handleRequest(msg) {
    if (msg.action === 'get_available_characters' || msg.action === 'get_character') {
      return this._executeAndReply('request_result', msg, null);
    }

    const actor = this._getActorForDiscord(msg.discordId);
    if (!actor) {
      return this._send({
        type: 'request_result',
        requestId: msg.requestId,
        result: { error: 'Personaggio non trovato per questo utente Discord' },
      });
    }
    this._executeAndReply('request_result', msg, actor);
  }

  async _executeAndReply(replyType, msg, actor) {
    try {
      const result = await this._executeAction(msg.action, actor, msg.params || {});
      this._send({ type: replyType, requestId: msg.requestId, result });
    } catch (err) {
      this._send({ type: replyType, requestId: msg.requestId, result: { error: err.message } });
    }
  }

  _getActorForDiscord(discordId) {
    const actorId = SettingsManager.getCharacterForDiscordUser(discordId);
    if (!actorId) return null;
    return game.actors?.get(actorId) || null;
  }

  async _executeAction(action, actor, params) {
    switch (action) {
      case 'roll_skill':
        return RollHandler.handleRollSkill(actor, params.skillId);
      case 'roll_ability':
        return RollHandler.handleRollAbility(actor, params.abilityId);
      case 'roll_save':
        return RollHandler.handleRollSave(actor, params.abilityId);
      case 'roll_attack':
        return RollHandler.handleRollAttack(actor, params.itemId);
      case 'roll_damage':
        return RollHandler.handleRollDamage(actor, params.itemId, params.critical);
      case 'get_sheet':
        return this._buildSheet(actor);
      case 'get_status':
        return this._buildStatus(actor);
      case 'list_actions':
        return this._buildActions(actor);
      case 'get_character':
        return this._buildCharacterById(params.actorId);
      case 'get_available_characters':
        return this._getAvailableCharacters();
      default:
        throw new Error(`Azione sconosciuta: ${action}`);
    }
  }

  _getClassString(actor) {
    const classes = actor.items.filter(i => i.type === 'class');
    if (classes.length) {
      return classes.map(c => `${c.name} ${c.system.levels || 0}`).join(' / ');
    }
    return actor.system?.details?.class || '';
  }

  _getRaceName(actor) {
    const race = actor.system?.details?.race;
    return race?.name || race || '';
  }

  _getDamageFormulas(item) {
    if (item.system?.damage?.parts?.length) {
      return item.system.damage.parts.map(([f]) => f);
    }
    const base = item.system?.damage?.base;
    if (base) {
      const f = this._formatDamageData(base);
      if (f) return [f];
    }
    const activity = item.system?.activities?.find(a => a.type === 'attack' || a.type === 'damage');
    if (activity?.damage?.parts?.length) {
      return activity.damage.parts.map(d => this._formatDamageData(d)).filter(Boolean);
    }
    return [];
  }

  _formatDamageData(d) {
    if (d.custom?.enabled && d.custom?.formula) return d.custom.formula;
    const num = d.number || 1;
    const denom = d.denomination;
    if (!denom) return '';
    let f = `${num}d${denom}`;
    if (d.bonus) f += ` + ${d.bonus}`;
    return f;
  }

  _buildCharacter(actor) {
    return {
      id: actor.id,
      name: actor.name,
      class: this._getClassString(actor),
      level: actor.system?.details?.level || 0,
      race: this._getRaceName(actor),
      background: actor.system?.details?.background?.name || actor.system?.details?.background || '',
    };
  }

  _buildCharacterById(actorId) {
    const actor = game.actors?.get(actorId);
    if (!actor) return { error: 'Personaggio non trovato' };
    return this._buildCharacter(actor);
  }

  _buildSheet(actor) {
    const abilities = {};
    for (const ab of ['str', 'dex', 'con', 'int', 'wis', 'cha']) {
      const a = actor.system?.abilities?.[ab];
      abilities[ab] = {
        value: a?.value || 10,
        modifier: a?.mod || 0,
        save: a?.mod || 0,
        label: CONFIG.DND5E?.abilities?.[ab]?.label || ab.toUpperCase(),
      };
    }

    const skills = {};
    if (actor.system?.skills) {
      for (const [key, sk] of Object.entries(actor.system.skills)) {
        skills[key] = {
          label: CONFIG.DND5E?.skills?.[key]?.label || key,
          modifier: sk?.total || 0,
          proficient: sk?.value >= 1,
          expertise: sk?.value >= 2,
        };
      }
    }

    return {
      name: actor.name,
      level: actor.system?.details?.level || 0,
      class: this._getClassString(actor),
      race: this._getRaceName(actor),
      abilities,
      skills,
      hp: {
        value: actor.system?.attributes?.hp?.value || 0,
        max: actor.system?.attributes?.hp?.max || 0,
        temp: actor.system?.attributes?.hp?.temp || 0,
      },
      ac: actor.system?.attributes?.ac?.value || 10,
      initiative: actor.system?.attributes?.init?.total || 0,
      speed: actor.system?.attributes?.movement?.walk || 30,
      proficiency: actor.system?.attributes?.prof || 2,
      inspiration: actor.system?.attributes?.inspiration || false,
      conditions: actor.effects?.filter(e => !e.disabled).map(e => e.label) || [],
    };
  }

  _buildStatus(actor) {
    const hp = actor.system?.attributes?.hp;
    return {
      hp: {
        value: hp?.value || 0,
        max: hp?.max || 0,
        percentage: hp?.max > 0 ? Math.round((hp.value / hp.max) * 100) : 100,
      },
      ac: actor.system?.attributes?.ac?.value || 10,
      level: actor.system?.details?.level || 0,
      conditions: actor.effects?.filter(e => !e.disabled).map(e => e.label) || [],
      inspiration: actor.system?.attributes?.inspiration || false,
    };
  }

  _buildActions(actor) {
    const items = actor.items.filter(i =>
      ['weapon', 'spell', 'feat', 'equipment'].includes(i.type)
    );

    return {
      actions: items.map(item => ({
        id: item.id,
        name: item.name,
        type: item.type,
        damage: this._getDamageFormulas(item),
        range: item.system?.range?.value || null,
        uses: item.system?.uses?.value || null,
        usesMax: item.system?.uses?.max || null,
        level: item.system?.level || null,
        prepared: item.system?.prepared ?? true,
      })),
      spellSlots: actor.system?.spells || null,
    };
  }

  _getAvailableCharacters() {
    const actors = game.actors?.filter(a => a.type === 'character') || [];
    return {
      characters: actors.map(a => ({
        id: a.id,
        name: a.name,
        level: a.system?.details?.level || 0,
        class: this._getClassString(a),
        race: this._getRaceName(a),
        player: a.system?.details?.player || '',
      })),
    };
  }

  // Metodi chiamati dalla UI per sincronizzare i link col bot
  sendLink(discordId, actorId, actorName) {
    this._send({ type: 'link', discordId, actorId, actorName });
  }

  sendUnlink(discordId) {
    this._send({ type: 'unlink', discordId });
  }

  _startPing() {
    this._stopPing();
    this.pingTimer = setInterval(() => {
      this._send({ type: 'ping' });
    }, 30000);
  }

  _syncLinks() {
    const links = SettingsManager.getLinks();
    for (const [discordId, actorId] of Object.entries(links)) {
      const actor = game.actors?.get(actorId);
      this._send({
        type: 'link',
        discordId,
        actorId,
        actorName: actor?.name || 'Sconosciuto',
      });
    }
    if (Object.keys(links).length > 0) {
      console.log(`D&D5e Discord Link | Sincronizzati ${Object.keys(links).length} collegamenti con il bot`);
    }
  }

  _stopPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  disconnect() {
    this._stopPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try { this.ws.close(1000, 'Shutdown'); } catch {}
      this.ws = null;
    }
    this.connected = false;
    SettingsManager.setBotConnected(false);
  }

  isConnected() {
    return this.connected && this.ws?.readyState === WebSocket.OPEN;
  }
}
