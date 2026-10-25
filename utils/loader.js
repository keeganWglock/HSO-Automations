import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { COMMANDS_DIR, EVENTS_DIR } from './paths.js';

async function importDir(dir) {
  const files = (await readdir(dir)).filter((file) => file.endsWith('.js'));
  const modules = [];
  for (const file of files) {
    try {
      modules.push({ file, mod: await import(pathToFileURL(path.join(dir, file)).href) });
    } catch (error) {
      console.error(`[LOAD ERROR] ${file}:`, error);
    }
  }
  return modules;
}

// Slash commands export default { data, execute(interaction) }.
// Prefix commands export default { name, aliases?, execute(message, args, argsText) }.
export async function loadCommands(client) {
  for (const { file, mod } of await importDir(COMMANDS_DIR)) {
    const command = mod.default;
    if (!command || typeof command.execute !== 'function') {
      console.warn(`[LOAD] commands/${file} has no default export with an execute() function - skipped.`);
      continue;
    }
    if (command.data) {
      client.slashCommands.set(command.data.name, command);
      console.log(`[LOAD] Slash command /${command.data.name}`);
    } else if (command.name) {
      for (const key of [command.name, ...(command.aliases ?? [])]) {
        client.prefixCommands.set(key.toLowerCase(), command);
      }
      console.log(`[LOAD] Prefix command ${command.name}`);
    } else {
      console.warn(`[LOAD] commands/${file} needs either "data" or "name" - skipped.`);
    }
  }
}

// Event files export default { name, once?, execute(...args) } or { register(client) }.
export async function loadEvents(client) {
  for (const { file, mod } of await importDir(EVENTS_DIR)) {
    const event = mod.default;
    if (!event) continue;
    if (typeof event.register === 'function') {
      event.register(client);
      console.log(`[LOAD] Event module ${file}`);
    } else if (event.name && typeof event.execute === 'function') {
      const handler = (...args) => event.execute(...args);
      if (event.once) client.once(event.name, handler);
      else client.on(event.name, handler);
      console.log(`[LOAD] Event ${event.name}`);
    }
  }
}

export async function registerGuildCommands(client, guild) {
  const body = [...client.slashCommands.values()].map((command) => command.data.toJSON());
  try {
    await guild.commands.set(body);
    console.log(`[SUCCESS] Registered ${body.length} slash command(s) for ${guild.name} (${guild.id})`);
  } catch (error) {
    console.error(`[ERROR] Failed to register commands for ${guild.name} (${guild.id}):`, error.message);
  }
}
