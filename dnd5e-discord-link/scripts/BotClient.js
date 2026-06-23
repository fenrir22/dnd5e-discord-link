import { SettingsManager } from './settings.js';
import { RollHandler } from './RollHandler.js';

export class BotClient {
  constructor() {
    this.ws = null;
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.connected = false;
    this.gameId = null;
    this.pendingMessages = [];
    this._hooksRegistered = false;
  }

  async connect() {
    const url = SettingsManager.getBotUrl();
    const apiKey = SettingsManager.getApiKey();

    if (!url || !apiKey) {
      console.log('D&D5e Discord Link | Bot URL o API Key non configurati.');
      return;
    }

    this._registerHooks();
    this._connect(url, apiKey);
  }

  _registerHooks() {
    if (this._hooksRegistered) return;
    this._hooksRegistered = true;
    const _hpPreUpdate = new WeakMap();

    Hooks.on('preUpdateActor', (actor, changes) => {
      const ch = changes?.system?.attributes?.hp || changes?.['system.attributes.hp'];
      const hpVal = ch?.value ?? changes?.['system.attributes.hp.value'];
      if (hpVal === undefined) return;
      _hpPreUpdate.set(actor, {
        oldHp: actor.system?.attributes?.hp?.value ?? 0,
        oldTemp: actor.system?.attributes?.hp?.temp ?? 0,
      });
    });

    Hooks.on('updateActor', (actor, changes) => {
      const ch = changes?.system?.attributes?.hp || changes?.['system.attributes.hp'];
      const hpVal = ch?.value ?? changes?.['system.attributes.hp.value'];
      if (hpVal === undefined) return;

      const cached = _hpPreUpdate.get(actor);
      if (!cached) return;
      _hpPreUpdate.delete(actor);

      const discordId = SettingsManager.getActiveDiscordUserForCharacter(actor.id);
      if (!discordId) return;

      const oldHp = cached.oldHp;
      const maxHp = actor.system?.attributes?.hp?.max ?? 0;
      const oldTemp = cached.oldTemp;
      const newTemp = ch?.temp ?? changes?.['system.attributes.hp.temp'] ?? oldTemp;
      const diff = hpVal - oldHp;
      if (diff === 0) return;

      const sent = this._send({
        type: 'hp_update',
        discordId,
        actorId: actor.id,
        actorName: actor.name,
        oldHp, newHp: hpVal, maxHp,
        oldTemp, newTemp,
        diff,
      });
      console.log(`D&D5e Discord Link | HP ${actor.name}: ${diff > 0 ? '+' : ''}${diff} (${hpVal}/${maxHp})${sent ? ' → inviato' : ' → accodato'}`);
    });

    Hooks.on('combatStart', (combat) => {
      this._sendCombatUpdate(combat, 'combat_start');
    });

    Hooks.on('updateCombat', (combat, change) => {
      if (change && (change.round !== undefined || change.turn !== undefined)) {
        this._sendCombatUpdate(combat, 'combat_update');
      }
    });

    Hooks.on('updateCombatant', (combatant, change) => {
      if (change?.initiative !== undefined) {
        const combat = combatant.combat;
        if (combat) this._sendCombatUpdate(combat, 'combat_update');
      }
    });

    Hooks.on('deleteCombat', (combat) => {
      this._send({ type: 'combat_end', sceneName: combat.scene?.name || 'Sconosciuto' });
    });
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
          channelId: SettingsManager.getDiscordChannel() || undefined,
          combatChannelId: SettingsManager.getDiscordCombatChannel() || undefined,
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
        this._flushPending();
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
      return true;
    }
    this.pendingMessages.push(data);
    return false;
  }

  _flushPending() {
    const pending = this.pendingMessages;
    this.pendingMessages = [];
    for (const data of pending) {
      this._send(data);
    }
  }

  _handleExecute(msg) {
    if (msg.action === 'update_link') {
      return this._executeAndReply('execute_result', msg, null);
    }
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
    if (msg.action === 'get_available_characters' || msg.action === 'get_character' || msg.action === 'list_skills') {
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
        return RollHandler.handleRollSkill(actor, params.skillId, params);
      case 'roll_ability':
        return RollHandler.handleRollAbility(actor, params.abilityId, params);
      case 'roll_save':
        return RollHandler.handleRollSave(actor, params.abilityId, params);
      case 'roll_attack':
        return RollHandler.handleRollAttack(actor, params.itemId, params);
      case 'roll_damage':
        return RollHandler.handleRollDamage(actor, params.itemId, params.critical, params);
      case 'get_sheet':
        return this._buildSheet(actor);
      case 'get_status':
        return this._buildStatus(actor);
      case 'list_actions':
        return this._buildActions(actor);
      case 'list_skills':
        return this._buildSkills();
      case 'get_character':
        return this._buildCharacterById(params.actorId);
      case 'get_available_characters':
        return this._getAvailableCharacters();
      case 'update_link':
        return this._updateLink(params.discordId, params.actorId, params.actorName);
      case 'roll_puro':
        return RollHandler.handleRollPuro(actor, params);
      case 'roll_initiative':
        return this._rollInitiative(params.discordId);
      case 'short_rest':
        return RollHandler.handleShortRest(actor, params);
      case 'long_rest':
        return RollHandler.handleLongRest(actor);
      case 'death_save':
        return RollHandler.handleDeathSave(actor);
      case 'roll_concentration':
        return RollHandler.handleRollConcentration(actor, params);
      case 'get_inventory':
        return this._buildInventory(actor);
      case 'search_spell':
        return this._searchSpell(actor, params.name);
      default:
        throw new Error(`Azione sconosciuta: ${action}`);
    }
  }

  _updateLink(discordId, actorId, actorName) {
    if (!discordId || !actorId) return { error: 'Parametri mancanti' };
    const actor = game.actors?.get(actorId);
    if (!actor) return { error: 'Personaggio non trovato' };
    SettingsManager.linkCharacter(discordId, actorId);
    this._send({ type: 'link', discordId, actorId, actorName: actorName || actor.name });
    return { success: true, actorName: actor.name };
  }

  _removeCharLink(discordId, actorId) {
    SettingsManager.unlinkCharacterActor(discordId, actorId);
    this._send({ type: 'unlink', discordId, actorId });
  }

  async _rollInitiative(discordId) {
    const combat = game.combat;
    if (!combat) return { error: 'Nessun combat attivo.' };

    const actorId = SettingsManager.getCharacterForDiscordUser(discordId);
    if (!actorId) return { error: 'Personaggio non trovato.' };
    const actor = game.actors?.get(actorId);
    if (!actor) return { error: 'Personaggio non trovato.' };

    const combatant = [...combat.combatants.values()].find(c => c.actor?.id === actorId);
    if (!combatant) return { error: 'Il tuo personaggio non e nel combat.' };

    if (combatant.initiative != null) return { error: 'Hai già tirato iniziativa.' };

    try {
      const bonus = actor.system?.attributes?.init?.total || 0;
      const roll = new Roll(`1d20 + ${bonus}`);
      await roll.evaluate({ async: true });
      await combatant.update({ initiative: roll.total });
      return {
        name: actor.name,
        initiative: roll.total,
      };
    } catch (err) {
      return { error: `Errore nel tiro iniziativa: ${err.message}` };
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
    for (const act of (item.system?.activities || [])) {
      if (act.damage?.parts?.length) {
        const formulas = act.damage.parts.map(d => this._formatDamageData(d)).filter(Boolean);
        if (formulas.length) return formulas;
      }
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

  _buildInventory(actor) {
    const items = actor.items.filter(i =>
      ['weapon', 'equipment', 'consumable', 'tool', 'loot', 'container', 'backpack'].includes(i.type)
    );

    return {
      items: items.map(item => ({
        id: item.id,
        name: item.name,
        type: item.type,
        quantity: item.system?.quantity || 1,
        weight: item.system?.weight || 0,
        equipped: item.system?.equipped || false,
        price: item.system?.price?.value || 0,
        priceDenom: item.system?.price?.denomination || 'gp',
        description: item.system?.description?.value
          ? item.system.description.value.replace(/<[^>]*>/g, '').slice(0, 100)
          : '',
      })),
      currency: {
        pp: actor.system?.currency?.pp || 0,
        gp: actor.system?.currency?.gp || 0,
        ep: actor.system?.currency?.ep || 0,
        sp: actor.system?.currency?.sp || 0,
        cp: actor.system?.currency?.cp || 0,
      },
      equippedCount: items.filter(i => i.system?.equipped).length,
      totalItems: items.length,
    };
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

  _buildCombatData(combat) {
    if (!combat?.combatants) return null;

    const turns = combat.turns || [];
    const combatants = [];
    for (const c of turns) {
      if (!c) continue;
      const actor = c.actor;
      if (!actor) continue;
      const name = actor.name;
      const hp = actor.system?.attributes?.hp;
      const conditions = actor.effects?.filter(e => !e.disabled).map(e => e.label) || [];
      const isCurrent = combat.turn >= 0 && turns[combat.turn]?.id === c.id;
      combatants.push({
        id: c.id,
        name,
        initiative: c.initiative,
        isDefeated: c.isDefeated,
        isHidden: c.hidden,
        isCurrent,
        hp: hp ? { value: hp.value || 0, max: hp.max || 0, temp: hp.temp || 0 } : null,
        ac: actor.system?.attributes?.ac?.value || null,
        conditions,
      });
    }

    if (!combatants.length) return null;

    return {
      sceneName: game.scenes?.get(combat.scene?.id || combat.scene)?.name || combat.scene?.name || 'Sconosciuto',
      round: combat.round || 1,
      turn: combat.turn,
      combatants: combatants.sort((a, b) => (b.initiative ?? -Infinity) - (a.initiative ?? -Infinity)),
    };
  }

  _sendCombatUpdate(combat, type) {
    const data = this._buildCombatData(combat);
    if (!data) return;
    this._send({ type, ...data });
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

  _searchSpell(actor, name) {
    const spells = actor.items.filter(i => i.type === 'spell');
    const match = spells.find(s => s.name.toLowerCase().includes(name.toLowerCase()));
    if (!match) return null;

    const school = match.system?.school?.label
      || CONFIG.DND5E?.spellSchools?.[match.system?.school]?.label
      || match.system?.school || '—';

    const level = match.system?.level ?? 0;
    const levelLabel = level === 0 ? 'Trucchetto' : `Livello ${level}`;

    const props = new Set([...(match.system?.properties || [])].map(p => p.toLowerCase()));
    const compMat = match.system?.materials?.value || match.system?.materials?.name || '';
    const hasV = props.has('vocal') || props.has('verbal');
    const hasS = props.has('somatic');
    const hasM = props.has('material') || !!compMat;
    let components = [
      hasV ? 'V' : '',
      hasS ? 'S' : '',
      hasM ? `M${compMat ? ` (${compMat})` : ''}` : '',
    ].filter(Boolean).join(', ');
    if (!components) {
      const descText = match.system?.description?.value || '';
      const m = descText.match(/Component(?:i|s)[:\s]+([^<]+?)(?:<|$)/i);
      if (m) components = m[1].trim().replace(/\s+/g, ' ').replace(/ *\( */g, ' (').replace(/ *\) */g, ')');
    }
    if (!components) components = '—';

    const activation = match.system?.activation || {};
    const activationTime = activation.type
      ? `${activation.cost || 1} ${activation.type}`
      : '—';

    const target = match.system?.target || {};
    const template = target.template || {};
    const affects = target.affects || {};
    let targetStr;
    if (target.value > 0 && target.units) {
      targetStr = `${target.value} ${target.units}${target.type ? ` (${target.type})` : ''}`;
    } else if (target.type && !target.value) {
      targetStr = target.type;
    } else if (template.type) {
      targetStr = `${template.size || ''} ${template.type}${template.units ? ` ${template.units}` : ''}`.trim();
    } else if (affects.type) {
      targetStr = `${affects.count || ''} ${affects.type}${affects.choice ? ' (scelta)' : ''}${affects.special ? ` (${affects.special})` : ''}`.trim();
    } else {
      const act = (match.system?.activities || []).find(a => a.target);
      if (act?.target) {
        const at = act.target;
        const t = at.template || {};
        const a = at.affects || {};
        if ((at.value || at.units) && !t.type && !a.type) targetStr = `${at.value || ''} ${at.units || ''}`.trim();
        else if (at.value) targetStr = `${at.value} ${at.units || ''}${at.type ? ` (${at.type})` : ''}`.trim();
        else if (t.type) targetStr = `${t.size || ''} ${t.type}${t.units ? ` ${t.units}` : ''}`.trim();
        else if (a.type) targetStr = `${a.count || ''} ${a.type}${a.choice ? ' (scelta)' : ''}`.trim();
        else targetStr = at.type || '—';
      } else {
        targetStr = '—';
      }
    }

    const durationParts = match.system?.duration || {};
    const durationStr = durationParts.value
      ? `${durationParts.value} ${durationParts.units || ''}${durationParts.concentration ? ' (Concentrazione)' : ''}`
      : durationParts.concentration ? 'Concentrazione' : '—';

    const range = match.system?.range || {};
    const rangeStr = range.value
      ? `${range.value}${range.units ? ` ${range.units}` : ''}`
      : range.long ? `${range.value}/${range.long} ${range.units || ''}` : '—';

    const damage = this._getDamageFormulas(match);
    let damageType = '—';
    if (match.system?.damage?.parts?.[0]?.[1]) {
      damageType = CONFIG.DND5E?.damageTypes?.[match.system.damage.parts[0][1]]?.label || match.system.damage.parts[0][1];
    } else if (damage.length) {
      const act = (match.system?.activities || []).find(a => a.damage?.parts?.length);
      const typeKey = act?.damage?.parts?.[0]?.types?.[0] || act?.damage?.parts?.[0]?.damageType;
      if (typeKey) damageType = CONFIG.DND5E?.damageTypes?.[typeKey]?.label || typeKey;
    }

    let desc = match.system?.description?.value || '';
    if (desc) {
      desc = desc
        .replace(/<\/?p>/g, '\n')
        .replace(/<br\s*\/?>/g, '\n')
        .replace(/<\/?strong>/g, '**')
        .replace(/<\/?em>/g, '*')
        .replace(/<[^>]*>/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      const lines = desc.split('\n').filter(Boolean);
      if (lines.some(l => /^Componenti?:/i.test(l) || /^Components?:/i.test(l))) {
        const start = lines.findIndex(l => /^Durata/i.test(l) || /^Duration/i.test(l));
        if (start >= 0) {
          desc = lines.slice(start + 1).join('\n\n').trim();
        }
      }
      desc = desc.slice(0, 500);
    }

    const prepared = match.system?.prepared ?? true;

    const spellSlots = actor.system?.spells || {};
    const slotKey = `spell${level}`;
    const slots = spellSlots[slotKey];

    return {
      id: match.id,
      name: match.name,
      level,
      levelLabel,
      school,
      components,
      activation: activationTime,
      range: rangeStr,
      target: targetStr,
      duration: durationStr,
      damage: damage.length ? `${damage.join(' + ')} ${damageType !== '—' ? damageType : ''}`.trim() : '—',
      description: desc,
      prepared,
      slots: slots ? `${slots.value || 0}/${slots.max || 0}` : '—',
    };
  }

  _buildSkills() {
    const skills = CONFIG.DND5E?.skills || {};
    return {
      skills: Object.entries(skills).map(([key, val]) => ({
        key,
        label: val.label || key,
        ability: val.ability || '',
      })),
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

  sendUnlink(discordId, actorId) {
    this._send({ type: 'unlink', discordId, actorId });
  }

  _startPing() {
    this._stopPing();
    this.pingTimer = setInterval(() => {
      this._send({ type: 'ping' });
    }, 30000);
  }

  _syncLinks() {
    const links = SettingsManager.getAllLinks();
    for (const entry of links) {
      for (const char of entry.characters) {
        this._send({
          type: 'link',
          discordId: entry.discordId,
          actorId: char.actorId,
          actorName: char.actorName,
        });
      }
    }
    if (links.length > 0) {
      const count = links.reduce((s, e) => s + e.characters.length, 0);
      console.log(`D&D5e Discord Link | Sincronizzati ${count} personaggi per ${links.length} utenti con il bot`);
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
