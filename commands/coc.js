import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import { loadTemplate } from '../utils/components.js';

const MESSAGE_FILE = 'chainofcommandmessage.json';

export default {
  name: 'coc',
  aliases: ['chain of command', 'c-o-c'],
  description: 'Posts the chain of command announcement from data/chainofcommandmessage.json.',
  async execute(message) {
    if (!message.member?.permissions.has(PermissionFlagsBits.ManageGuild)) return;
    try {
      const components = await loadTemplate(MESSAGE_FILE);
      await message.channel.send({ components, flags: MessageFlags.IsComponentsV2 });
    } catch (error) {
      await message.reply(`Couldn't send the chain of command message: ${error.message}`).catch(() => {});
    }
  },
};
