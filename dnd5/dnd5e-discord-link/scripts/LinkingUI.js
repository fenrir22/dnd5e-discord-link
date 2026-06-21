import { SettingsManager } from './settings.js';
import { BotClient } from './BotClient.js';

let _bot = null;
export function setBotInstance(bot) {
  _bot = bot;
}

export class LinkingUI extends FormApplication {
  static get defaultOptions() {
    return {
      ...super.defaultOptions,
      id: 'dndlink-linking',
      title: 'DND5e Discord Link - Gestione Collegamenti',
      template: 'modules/dnd5e-discord-link/templates/linking.html',
      width: 520,
      height: 620,
      classes: ['dndlink-window'],
    };
  }

  getData() {
    return {
      botUrl: SettingsManager.getBotUrl(),
      apiKey: SettingsManager.getApiKey(),
      botConnected: SettingsManager.getBotConnected(),
      links: SettingsManager.getAllLinks(),
      actors: (game.actors?.filter(a => a.type === 'character') || []).map(a => ({
        id: a.id,
        name: a.name,
        level: a.system?.details?.level || 0,
        class: a.system?.details?.class || '',
        race: a.system?.details?.race || '',
        player: a.system?.details?.player || '',
      })),
    };
  }

  activateListeners(html) {
    super.activateListeners(html);

    html.find('#dndlink-link-btn').click(this._onLink.bind(this));
    html.find('#dndlink-unlink-btn').click(this._onUnlink.bind(this));
    html.find('#dndlink-genkey-btn').click(this._onGenerateKey.bind(this));
    html.find('.unlink-btn').click(this._onRemoveLink.bind(this));
  }

  async _onLink(event) {
    event.preventDefault();
    const discordId = this.element.find('#dndlink-discord-id').val().trim();
    const actorId = this.element.find('#dndlink-actor-select').val();

    if (!discordId || !actorId) {
      ui.notifications.warn('Inserisci un ID Discord e seleziona un personaggio.');
      return;
    }

    if (SettingsManager.getCharacterForDiscordUser(discordId)) {
      ui.notifications.warn('Questo utente Discord è già collegato a un personaggio.');
      return;
    }

    const actor = game.actors?.get(actorId);
    await SettingsManager.linkCharacter(discordId, actorId);
    if (_bot?.isConnected()) {
      _bot.sendLink(discordId, actorId, actor?.name || 'Sconosciuto');
    }
    ui.notifications.info(`Personaggio collegato all'utente Discord ${discordId}`);
    this.render();
  }

  async _onUnlink(event) {
    event.preventDefault();
    const discordId = this.element.find('#dndlink-discord-id').val().trim();
    if (!discordId) {
      ui.notifications.warn('Inserisci un ID Discord.');
      return;
    }
    await SettingsManager.unlinkCharacter(discordId);
    if (_bot?.isConnected()) _bot.sendUnlink(discordId);
    ui.notifications.info(`Utente Discord ${discordId} scollegato`);
    this.render();
  }

  async _onRemoveLink(event) {
    const discordId = event.currentTarget.dataset.discordId;
    if (!discordId) return;
    await SettingsManager.unlinkCharacter(discordId);
    if (_bot?.isConnected()) _bot.sendUnlink(discordId);
    ui.notifications.info(`Utente Discord ${discordId} scollegato`);
    this.render();
  }

  async _onGenerateKey(event) {
    event.preventDefault();
    const key = 'fvtt_' + Array.from({ length: 32 }, () =>
      'abcdefghijklmnopqrstuvwxyz0123456789'.charAt(Math.floor(Math.random() * 36))
    ).join('');

    await game.settings.set('dnd5e-discord-link', 'apiKey', key);

    try {
      await navigator.clipboard.writeText(key);
      ui.notifications.info('Nuova API Key generata e copiata negli appunti!');
    } catch {
      ui.notifications.info(`Nuova API Key: ${key}`);
    }

    this.render();
  }
}
