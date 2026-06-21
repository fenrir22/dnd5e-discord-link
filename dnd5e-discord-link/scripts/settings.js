export class SettingsManager {
  static NAMESPACE = 'dnd5e-discord-link';

  static KEYS = {
    apiKey: 'apiKey',
    botUrl: 'botUrl',
    links: 'discordLinks',
    botConnected: 'botConnected',
    discordChannel: 'discordChannel',
    discordCombatChannel: 'discordCombatChannel',
  };

  static registerSettings() {
    game.settings.register(this.NAMESPACE, this.KEYS.botUrl, {
      name: 'Bot WebSocket URL',
      hint: 'URL del bot Discord. Es: wss://dndlink.tuodominio.it',
      scope: 'world',
      config: true,
      type: String,
      default: '',
    });

    game.settings.register(this.NAMESPACE, this.KEYS.apiKey, {
      name: 'API Key',
      hint: 'Chiave segreta. Usa "Gestisci Collegamenti" qui sopra per generarla.',
      scope: 'world',
      config: true,
      type: String,
      default: '',
    });

    game.settings.register(this.NAMESPACE, this.KEYS.discordChannel, {
      name: 'Canale Discord (HP)',
      hint: 'ID del canale Discord dove ricevere aggiornamenti HP in tempo reale. Lascia vuoto per disabilitare.',
      scope: 'world',
      config: true,
      type: String,
      default: '',
    });

    game.settings.register(this.NAMESPACE, this.KEYS.discordCombatChannel, {
      name: 'Canale Discord (Turni)',
      hint: 'ID del canale Discord per la turnistica del combat. Lascia vuoto per usare lo stesso canale HP.',
      scope: 'world',
      config: true,
      type: String,
      default: '',
    });

    game.settings.register(this.NAMESPACE, this.KEYS.links, {
      scope: 'world',
      config: false,
      type: Object,
      default: {},
    });

    game.settings.register(this.NAMESPACE, this.KEYS.botConnected, {
      scope: 'world',
      config: false,
      type: Boolean,
      default: false,
    });
  }

  static getApiKey() {
    return game.settings.get(this.NAMESPACE, this.KEYS.apiKey);
  }

  static getBotUrl() {
    return game.settings.get(this.NAMESPACE, this.KEYS.botUrl);
  }

  static getLinks() {
    return game.settings.get(this.NAMESPACE, this.KEYS.links);
  }

  static async setLinks(links) {
    await game.settings.set(this.NAMESPACE, this.KEYS.links, links);
  }

  static getBotConnected() {
    return game.settings.get(this.NAMESPACE, this.KEYS.botConnected);
  }

  static async setBotConnected(status) {
    await game.settings.set(this.NAMESPACE, this.KEYS.botConnected, status);
  }

  static getDiscordChannel() {
    return game.settings.get(this.NAMESPACE, this.KEYS.discordChannel);
  }

  static getDiscordCombatChannel() {
    return game.settings.get(this.NAMESPACE, this.KEYS.discordCombatChannel) || game.settings.get(this.NAMESPACE, this.KEYS.discordChannel);
  }

  static _migrate(entry) {
    if (typeof entry === 'string') return { active: entry, characters: [entry] };
    return entry;
  }

  static getCharacterForDiscordUser(discordId) {
    const links = this.getLinks();
    const entry = links[discordId];
    if (!entry) return null;
    return this._migrate(entry).active;
  }

  static getDiscordUserForCharacter(actorId) {
    const links = this.getLinks();
    for (const [discordId, entry] of Object.entries(links)) {
      const parsed = this._migrate(entry);
      if (parsed.characters.includes(actorId)) return discordId;
    }
    return null;
  }

  static getActiveDiscordUserForCharacter(actorId) {
    const links = this.getLinks();
    for (const [discordId, entry] of Object.entries(links)) {
      const parsed = this._migrate(entry);
      if (parsed.active === actorId) return discordId;
    }
    return null;
  }

  static getLinkedCharacters(discordId) {
    const links = this.getLinks();
    const entry = links[discordId];
    if (!entry) return [];
    return this._migrate(entry).characters;
  }

  static async linkCharacter(discordId, actorId) {
    const links = this.getLinks();
    const entry = this._migrate(links[discordId] || null);
    if (entry) {
      if (!entry.characters.includes(actorId)) entry.characters.push(actorId);
      entry.active = actorId;
    } else {
      links[discordId] = { active: actorId, characters: [actorId] };
    }
    await this.setLinks(links);
  }

  static async switchActiveCharacter(discordId, actorId) {
    const links = this.getLinks();
    const entry = this._migrate(links[discordId]);
    if (!entry) return false;
    if (!entry.characters.includes(actorId)) return false;
    entry.active = actorId;
    await this.setLinks(links);
    return true;
  }

  static async unlinkCharacter(discordId) {
    const links = this.getLinks();
    delete links[discordId];
    await this.setLinks(links);
  }

  static async unlinkCharacterActor(discordId, actorId) {
    const links = this.getLinks();
    const entry = this._migrate(links[discordId]);
    if (!entry) return;
    entry.characters = entry.characters.filter(id => id !== actorId);
    if (entry.active === actorId) {
      entry.active = entry.characters[0] || null;
    }
    if (!entry.characters.length) {
      delete links[discordId];
    }
    await this.setLinks(links);
  }

  static async unlinkByActorId(actorId) {
    const links = this.getLinks();
    for (const [discordId, entry] of Object.entries(links)) {
      const parsed = this._migrate(entry);
      if (parsed.characters.includes(actorId)) {
        parsed.characters = parsed.characters.filter(id => id !== actorId);
        if (parsed.active === actorId) {
          parsed.active = parsed.characters[0] || null;
        }
        if (!parsed.characters.length) {
          delete links[discordId];
        } else {
          links[discordId] = parsed;
        }
        await this.setLinks(links);
        return;
      }
    }
  }

  static getAllLinks() {
    const links = this.getLinks();
    const result = [];
    for (const [discordId, entry] of Object.entries(links)) {
      const parsed = this._migrate(entry);
      const allChars = parsed.characters.map(id => ({
        actorId: id,
        actorName: game.actors?.get(id)?.name || 'Unknown',
      }));
      const activeChar = allChars.find(c => c.actorId === parsed.active);
      result.push({
        discordId,
        active: activeChar || allChars[0] || null,
        characters: allChars,
      });
    }
    return result;
  }
}
