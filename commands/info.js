import {
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { fetchSendableChannel, loadTemplate } from '../utils/components.js';

// ---------------------------------------------------------------------------
// INFO SETTINGS - edit these
// ---------------------------------------------------------------------------
// Channel where submitted information is sent.
const INFO_CHANNEL_ID = '1563974208080576612';

const PANEL_FILE = 'infomessage.json';
const RESPONSE_FILE = 'inforesponsemessage.json';

const MODAL_ID = 'info:modal';
const isValidId = (id) => /^\d{17,20}$/.test(id);

export function isInfoInteraction(customId) {
  return customId.startsWith('info:');
}

// The form questions. `key` is the placeholder used in inforesponsemessage.json, e.g. {roblox}.
const FIELDS = [
  { key: 'id', label: 'What is your Discord ID?', max: 25 },
  { key: 'roblox', label: 'What is your Roblox username?', max: 40 },
  { key: 'callsign', label: 'What is your callsign?', max: 30 },
  { key: 'rank', label: 'What is your rank?', max: 50 },
  { key: 'timezone', label: 'What is your timezone?', max: 50 },
];

// Adds the "Submit Information" button if infomessage.json doesn't already have one:
// next to your link button when it sits in a button row, otherwise in a new row under the text.
function ensureOpenButton(components) {
  if (JSON.stringify(components).includes('"info:open"')) return components;
  const button = { type: 2, style: 1, label: 'Submit Information', custom_id: 'info:open' };

  const container = components.find((c) => c?.type === 17 && Array.isArray(c.components));
  const parent = container ? container.components : components;

  const row = parent.find(
    (c) => c?.type === 1 && Array.isArray(c.components) && c.components.length < 5 && c.components.every((b) => b.type === 2),
  );
  if (row) {
    row.components.push(button);
    return components;
  }

  let lastText = -1;
  parent.forEach((c, i) => {
    if (c?.type === 10) lastText = i;
  });
  parent.splice(lastText + 1, 0, { type: 1, components: [button] });
  return components;
}

function walkText(nodes, visit) {
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;
    if (node.type === 10 && typeof node.content === 'string') visit(node);
    if (Array.isArray(node.components)) walkText(node.components, visit);
  }
}

function buildModal() {
  const modal = new ModalBuilder().setCustomId(MODAL_ID).setTitle('Information');
  for (const field of FIELDS) {
    modal.addLabelComponents(
      new LabelBuilder()
        .setLabel(field.label)
        .setTextInputComponent(
          new TextInputBuilder().setCustomId(field.key).setStyle(TextInputStyle.Short).setMaxLength(field.max).setRequired(true),
        ),
    );
  }
  return modal;
}

export async function handleButton(interaction) {
  if (interaction.customId !== 'info:open' || !interaction.inGuild()) return;
  if (!isValidId(INFO_CHANNEL_ID)) {
    return interaction.reply({
      content: '❌ This is not set up yet (INFO_CHANNEL_ID in commands/info.js).',
      flags: MessageFlags.Ephemeral,
    });
  }
  return interaction.showModal(buildModal());
}

export async function handleModal(interaction) {
  if (interaction.customId !== MODAL_ID) return;
  if (!interaction.inGuild() || !isValidId(INFO_CHANNEL_ID)) {
    return interaction.reply({ content: '❌ This is not set up yet.', flags: MessageFlags.Ephemeral });
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const answers = {};
  for (const field of FIELDS) answers[field.key] = interaction.fields.getTextInputValue(field.key).trim();
  if (Object.values(answers).some((value) => !value)) {
    return interaction.editReply({ content: '❌ Every question needs an answer.' });
  }

  try {
    const components = await loadTemplate(RESPONSE_FILE);
    let replaced = false;
    walkText(components, (node) => {
      const before = node.content;
      let content = before.replaceAll('{user}', () => `<@${interaction.user.id}>`);
      for (const field of FIELDS) {
        content = content.replace(new RegExp(`\\{${field.key}\\}`, 'gi'), () => answers[field.key]);
      }
      if (content !== before) replaced = true;
      node.content = content;
    });
    if (!replaced) {
      throw new Error(`data/${RESPONSE_FILE} needs placeholders like {id}, {roblox}, {callsign}, {rank} and {timezone}.`);
    }

    const channel = await fetchSendableChannel(interaction.client, INFO_CHANNEL_ID);
    await channel.send({
      components,
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    console.error('[INFO] Could not post the information:', error);
    return interaction.editReply({ content: `❌ Couldn't submit your information: ${error.message}` });
  }

  return interaction.editReply({ content: '✅ Your information was submitted.' });
}

// "-info" posts the information panel in the current channel.
export default {
  name: 'info',
  description: 'Posts the information panel from data/infomessage.json.',
  async execute(message) {
    if (!message.member?.permissions.has(PermissionFlagsBits.ManageGuild)) return;
    try {
      const components = ensureOpenButton(await loadTemplate(PANEL_FILE));
      await message.channel.send({ components, flags: MessageFlags.IsComponentsV2 });
    } catch (error) {
      await message.reply(`Couldn't post the information panel: ${error.message}`).catch(() => {});
    }
  },
};
