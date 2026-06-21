import { SettingsManager } from './settings.js';
import { BotClient } from './BotClient.js';
import { LinkingUI, setBotInstance } from './LinkingUI.js';

let bot = null;

Hooks.once('init', () => {
  SettingsManager.registerSettings();

  game.settings.registerMenu('dnd5e-discord-link', 'linkingMenu', {
    name: 'Gestisci Collegamenti',
    label: 'Apri Gestione',
    hint: 'Collega utenti Discord a personaggi di Foundry. Genera l\'API Key.',
    icon: 'fas fa-address-card',
    type: LinkingUI,
    restricted: true,
  });
});

Hooks.once('ready', async () => {
  if (!game.user.isGM) return;
  bot = new BotClient();
  setBotInstance(bot);
  try { await bot.connect(); } catch (err) {
    console.error('D&D5e Discord Link | Connection error:', err);
  }
});

Hooks.on('closeSettingsConfig', () => {
  if (bot) {
    bot.disconnect();
    bot.connect().catch(err =>
      console.error('D&D5e Discord Link | Reconnect error:', err)
    );
  }
});
