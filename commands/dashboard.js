import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ContainerBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
} from 'discord.js';
import { fetchSendableChannel, loadTemplate } from '../utils/components.js';
import { createTranscript } from '../utils/transcript.js';
import {
  claimTicketInDb,
  findOpenTicketByOwner,
  generateSupportId,
  getTicket,
  removeTicket,
  saveTicket,
  updateTicket,
} from '../utils/tickets.js';
import { lookupRoblox } from '../utils/roblox.js';

// ---------------------------------------------------------------------------
// TICKET SETTINGS - edit these
// ---------------------------------------------------------------------------
export const TICKET_CATEGORY_ID = '1563753567267987474'; // new ticket channels are created here
export const SUPPORT_ROLE_ID = '1563753564067602530'; // staff who can see, claim and close tickets
const TICKET_LOG_CHANNEL_ID = '1563753564512329732'; // closed-ticket logs go here

const DASHBOARD_FILE = 'dashboardmessage.json';
const SUPPORT_FILES = {
  general: 'supportmessagegeneral.json',
  hr: 'supportmessagehr.json',
};
const DELETE_DELAY_MS = 5000;

const isValidId = (id) => /^\d{17,20}$/.test(id);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const text = (content) => new TextDisplayBuilder().setContent(content);

const closing = new Set(); // channelIds currently being closed

export function isTicketInteraction(customId) {
  return customId.startsWith('ticket:');
}

// Owner, Support ID and claimer of a ticket channel (null if the channel is not a ticket).
function ticketInfo(channel) {
  return channel ? getTicket(channel.id) : null;
}

export function isStaff(member) {
  if (!member) return false;
  if (member.permissions?.has(PermissionFlagsBits.ManageGuild)) return true;
  return Boolean(member.roles?.cache?.has(SUPPORT_ROLE_ID));
}

function walkText(nodes, visit) {
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;
    if (node.type === 10 && typeof node.content === 'string') visit(node);
    if (Array.isArray(node.components)) walkText(node.components, visit);
  }
}

// Adds Claim / Close buttons if supportmessage.json doesn't already contain them.
function ensureTicketButtons(components) {
  const json = JSON.stringify(components);
  if (json.includes('"ticket:claim"') && json.includes('"ticket:close"')) return components;
  const row = {
    type: 1,
    components: [
      { type: 2, style: 3, label: 'Claim', custom_id: 'ticket:claim' },
      { type: 2, style: 4, label: 'Close', custom_id: 'ticket:close' },
    ],
  };
  const container = components.find((c) => c?.type === 17 && Array.isArray(c.components));
  if (container) container.components.push(row);
  else components.push(row);
  return components;
}

// ---------------------------------------------------------------------------
// Creating a ticket
// ---------------------------------------------------------------------------
async function createTicket(interaction, kind = 'general') {
  const reply = (content) => interaction.editReply({ content });
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (!isValidId(TICKET_CATEGORY_ID) || !isValidId(SUPPORT_ROLE_ID)) {
    return reply('❌ Tickets are not set up yet (TICKET_CATEGORY_ID / SUPPORT_ROLE_ID in commands/dashboard.js).');
  }

  const guild = interaction.guild;
  const user = interaction.user;

  const existing = findOpenTicketByOwner(guild, user.id);
  if (existing) return reply(`❌ You already have an open ticket: <#${existing}>`);

  let channel;
  let supportId;
  try {
    supportId = generateSupportId();
    const name = `ticket-${user.username}`.toLowerCase().replace(/[^a-z0-9-_]/g, '').slice(0, 90) || `ticket-${user.id}`;
    channel = await guild.channels.create({
      name,
      type: ChannelType.GuildText,
      parent: TICKET_CATEGORY_ID,
      topic: supportId,
      reason: `Ticket opened by ${user.username}`,
      permissionOverwrites: [
        { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
        {
          id: user.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.AttachFiles,
          ],
        },
        {
          id: SUPPORT_ROLE_ID,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.AttachFiles,
          ],
        },
        {
          id: interaction.client.user.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.ManageChannels,
          ],
        },
      ],
    });
  } catch (error) {
    console.error('[TICKET] Could not create the ticket channel:', error);
    return reply(`❌ Couldn't create your ticket: ${error.message}`);
  }

  saveTicket(channel.id, { guildId: guild.id, owner: user.id, supportId, claimedBy: null, roblox: null });

  // Roblox account linked through Dock (used for {Roblox}, {Robloxid}, {robloxurl} and the close log).
  let roblox = null;
  try {
    roblox = await lookupRoblox(guild.id, user.id);
    if (roblox) updateTicket(channel.id, { roblox });
  } catch (error) {
    console.warn(`[TICKET] Roblox lookup failed for ${user.id}: ${error.message}`);
  }

  try {
    const templateFile = SUPPORT_FILES[kind] ?? SUPPORT_FILES.general;
    const components = await loadTemplate(templateFile);
    walkText(components, (node) => {
      node.content = node.content
        .replaceAll('{user}', () => `<@${user.id}>`)
        .replaceAll('{support}', () => `<@&${SUPPORT_ROLE_ID}>`)
        .replaceAll('{supportid}', () => supportId)
        .replace(/\{robloxid\}/gi, () => roblox?.id ?? 'Not verified')
        .replace(/\{robloxurl\}/gi, () => roblox?.profile ?? 'Not verified')
        .replace(/\{roblox\}/gi, () => roblox?.name ?? 'Not verified');
    });
    await channel.send({
      components: ensureTicketButtons(components),
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { parse: [], users: [user.id], roles: [SUPPORT_ROLE_ID] },
    });
  } catch (error) {
    console.error('[TICKET] Could not post the support message:', error);
    await channel.send({ content: `<@${user.id}> your ticket was created, but the support message failed to load: ${error.message}` }).catch(() => {});
  }

  return reply(`✅ Your ticket has been created: <#${channel.id}>`);
}

// ---------------------------------------------------------------------------
// Claiming a ticket
// ---------------------------------------------------------------------------
async function claimTicket(interaction) {
  const ephemeral = (content) => interaction.reply({ content, flags: MessageFlags.Ephemeral });
  const channel = interaction.channel;
  const info = ticketInfo(channel);
  if (!info) return ephemeral('This is not a ticket channel.');
  if (!isStaff(interaction.member)) return ephemeral('Only support staff can claim tickets.');

  const result = claimTicketInDb(channel.id, interaction.user.id);
  if (!result.ok) {
    return ephemeral(
      result.claimedBy === interaction.user.id
        ? 'You have already claimed this ticket.'
        : `This ticket was already claimed by <@${result.claimedBy}>.`,
    );
  }

  return interaction.reply({
    content: `<@${interaction.user.id}> has claimed the ticket.`,
    allowedMentions: { parse: [] },
  });
}

// ---------------------------------------------------------------------------
// Closing a ticket
// ---------------------------------------------------------------------------
function buildCloseLog({ channel, info, closer, transcriptUrl }) {
  const lines = [
    `**Support ID:** ${info.supportId ?? 'Unknown'}`,
    `**Opened By:** ${info.owner ? `<@${info.owner}>` : 'Unknown'}`,
    `**Roblox:** ${info.roblox ? `[${info.roblox.name}](${info.roblox.profile}) (${info.roblox.id})` : 'Not verified'}`,
    `**Closed By:** <@${closer.id}>`,
  ];
  if (info.claimedBy) lines.push(`**Claimed By:** <@${info.claimedBy}>`);
  lines.push(`**Ticket:** #${channel.name}`, `**Closed At:** <t:${Math.floor(Date.now() / 1000)}:F>`);

  return new ContainerBuilder()
    .addTextDisplayComponents(text('## Ticket Closed'))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents(text(lines.join('\n')))
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel('Transcript').setStyle(ButtonStyle.Link).setURL(transcriptUrl),
      ),
    );
}

async function closeTicket(interaction) {
  const ephemeral = (content) => interaction.reply({ content, flags: MessageFlags.Ephemeral });
  const channel = interaction.channel;
  const info = ticketInfo(channel);
  if (!info) return ephemeral('This is not a ticket channel.');
  if (!isStaff(interaction.member) && interaction.user.id !== info.owner) {
    return ephemeral('Only support staff or the ticket owner can close this ticket.');
  }
  if (!isValidId(TICKET_LOG_CHANNEL_ID)) {
    return ephemeral('❌ The ticket log channel is not set up yet (TICKET_LOG_CHANNEL_ID in commands/dashboard.js).');
  }
  if (closing.has(channel.id)) return ephemeral('This ticket is already being closed.');

  closing.add(channel.id);
  await interaction.reply({ content: 'Closing soon, saving transcript.' });

  let transcriptUrl;
  try {
    transcriptUrl = await createTranscript(interaction.client, channel.id);
  } catch (error) {
    console.error('[TICKET] Transcript failed:', error);
    closing.delete(channel.id);
    await channel
      .send({ content: `❌ I couldn't save the transcript (${error.message}). The ticket was left open - press **Close** to try again.` })
      .catch(() => {});
    return;
  }

  try {
    const logChannel = await fetchSendableChannel(interaction.client, TICKET_LOG_CHANNEL_ID);
    await logChannel.send({
      components: [buildCloseLog({ channel, info, closer: interaction.user, transcriptUrl })],
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    console.error('[TICKET] Could not write the close log:', error);
    closing.delete(channel.id);
    await channel
      .send({ content: `❌ I couldn't post the log (${error.message}). Transcript: ${transcriptUrl}\nThe ticket was left open.` })
      .catch(() => {});
    return;
  }

  await sleep(DELETE_DELAY_MS);
  try {
    await channel.delete(`Ticket closed by ${interaction.user.username}`);
    removeTicket(channel.id);
  } catch (error) {
    console.error('[TICKET] Could not delete the ticket channel:', error);
    await channel.send({ content: '⚠️ The log was saved, but I could not delete this channel. Please delete it manually.' }).catch(() => {});
  } finally {
    closing.delete(channel.id);
  }
}

export async function handleButton(interaction) {
  if (!interaction.inGuild()) return;
  if (interaction.customId === 'ticket:create' || interaction.customId === 'ticket:create:general') {
    return createTicket(interaction, 'general');
  }
  if (interaction.customId === 'ticket:create:hr') return createTicket(interaction, 'hr');
  if (interaction.customId === 'ticket:claim') return claimTicket(interaction);
  if (interaction.customId === 'ticket:close') return closeTicket(interaction);
}

// "-dashboard" posts the ticket dashboard in the current channel.
export default {
  name: 'dashboard',
  description: 'Posts the ticket dashboard from data/dashboardmessage.json.',
  async execute(message) {
    if (!message.member?.permissions.has(PermissionFlagsBits.ManageGuild)) return;
    try {
      const components = await loadTemplate(DASHBOARD_FILE);
      await message.channel.send({ components, flags: MessageFlags.IsComponentsV2 });
    } catch (error) {
      await message.reply(`Couldn't post the dashboard: ${error.message}`).catch(() => {});
    }
  },
};
