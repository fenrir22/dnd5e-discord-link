export class SettingsManager {
  static NAMESPACE = 'dnd5e-discord-link';

  static KEYS = {
    apiKey: 'apiKey',
    botUrl: 'botUrl',
    links: 'discordLinks',
    botConnected: 'botConnected',
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

  static getCharacterForDiscordUser(discordId) {
    const links = this.getLinks();
    return links[discordId] || null;
  }

  static getDiscordUserForCharacter(actorId) {
    const links = this.getLinks();
    return Object.entries(links).find(([, id]) => id === actorId)?.[0] || null;
  }

  static async linkCharacter(discordId, actorId) {
    const links = this.getLinks();
    links[discordId] = actorId;
    await this.setLinks(links);
  }

  static async unlinkCharacter(discordId) {
    const links = this.getLinks();
    delete links[discordId];
    await this.setLinks(links);
  }

  static async unlinkByActorId(actorId) {
    const links = this.getLinks();
    const discordId = Object.entries(links).find(([, id]) => id === actorId)?.[0];
    if (discordId) {
      delete links[discordId];
      await this.setLinks(links);
    }
  }

  static getAllLinks() {
    const links = this.getLinks();
    return Object.entries(links).map(([discordId, actorId]) => ({
      discordId,
      actorId,
      actorName: game.actors?.get(actorId)?.name || 'Unknown',
    }));
  }
}
