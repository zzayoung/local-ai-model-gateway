import {copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {basename, dirname, join} from 'node:path';

const [userProfile, harnessProfile, backupDirectory] = process.argv.slice(2);
const command = process.execPath;
const script = join(import.meta.dirname, 'media-mcp.mjs');
const workBuddy = join(userProfile, '.workbuddy', 'mcp.json');
const antigravity = join(userProfile, '.gemini', 'config', 'mcp_config.json');
const timeoutSeconds = 330;

const updates = [];
for (const [file, settings] of [
  [workBuddy, {type: 'stdio'}],
  [antigravity, {
    timeoutSeconds,
    tools: {
      generate_image: {eager: true},
      synthesize_speech: {eager: true},
      generate_music: {eager: true},
    },
  }],
]) {
  const previous = existsSync(file) ? readFileSync(file, 'utf8') : '';
  try {
    const config = JSON.parse(previous.replace(/^\uFEFF/, '').trim() || '{}');
    const servers = config?.mcpServers ?? {};
    if (!config || typeof config !== 'object' || Array.isArray(config) ||
        typeof servers !== 'object' || Array.isArray(servers)) {
      throw new Error('Expected an object with an mcpServers mapping.');
    }
    config.mcpServers = servers;
    const current = servers.gateway_media;
    servers.gateway_media = {...current, ...settings, command, args: [script]};
    updates.push({file, previous, next: JSON.stringify(config, null, 2) + '\n'});
  } catch {
    throw new Error(`Unable to merge the media connector into ${file}. Check the JSON configuration.`);
  }
}

// Cordis saves its desktop patch as a block-style YAML list. Edit only the MCP
// manager's mapping so the other patches and server settings remain intact.
const previous = readFileSync(harnessProfile, 'utf8');
const newline = previous.includes('\r\n') ? '\r\n' : '\n';
const lines = previous.replace(/^\uFEFF/, '').trimEnd().split(/\r?\n/);
const managers = [];
let patch = -1;
for (const [index, line] of lines.entries()) {
  if (/^-(?:\s|$)/.test(line)) patch = index;
  if (patch !== -1 && /^(?:- | {2})id: *(?:mcp-manager|'mcp-manager'|"mcp-manager") *(?:#.*)?$/.test(line)) {
    managers.push(patch);
  }
}
if (managers.length > 1) throw new Error(`Multiple MCP manager patches in ${harnessProfile}.`);
if (managers.length === 0) {
  const documentEnd = lines.findIndex(line => /^\.\.\.(?:\s|$)/.test(line));
  managers.push(documentEnd === -1 ? lines.length : documentEnd);
  lines.splice(managers[0], 0, '- id: mcp-manager');
}

const yamlString = value => "'" + value.replaceAll("'", "''") + "'";
const [config] = yamlEntry(lines, managers[0], 2, 'config');
const [servers] = yamlEntry(lines, config, 4, 'servers');
const [start, count] = yamlEntry(lines, servers, 6, 'gateway_media');
lines.splice(start, count,
  '      gateway_media:',
  '        transport: stdio',
  `        command: ${yamlString(command)}`,
  `        args: [${yamlString(script)}]`,
  `        toolCallTimeoutMs: ${timeoutSeconds * 1000}`,
);
updates.push({file: harnessProfile, previous, next: lines.join(newline) + newline});

for (const {file, previous, next} of updates) {
  if (previous === next) continue;
  // Install.ps1 already backs up the Harness profile before model catalog sync.
  if (file !== harnessProfile && existsSync(file)) {
    mkdirSync(backupDirectory, {recursive: true});
    copyFileSync(file, join(backupDirectory, basename(file)));
  }
  mkdirSync(dirname(file), {recursive: true});
  writeFileSync(file, next, 'utf8');
}

function yamlEntry(lines, parent, indentation, key) {
  const prefix = ' '.repeat(indentation);
  const entry = new RegExp('^' + prefix + '(?:' + key + "|'" + key + "'|\"" + key + '\"):[ \\t]*(.*)$');
  // A list item's first field can share its '-' line.
  let found = indentation === 2 && entry.test(lines[parent].replace(/^- /, '  ')) ? parent : -1;
  let end = parent + 1;
  let lastChild = parent;
  for (; end < lines.length; end++) {
    const line = lines[end];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const spaces = line.length - line.trimStart().length;
    if (spaces < indentation) break;
    if (spaces === indentation && entry.test(line)) {
      if (found !== -1) throw new Error(`Duplicate ${key} entry in ${harnessProfile}.`);
      found = end;
    }
    lastChild = end;
  }
  if (found === -1) {
    lines.splice(lastChild + 1, 0, prefix + key + ':');
    return [lastChild + 1, 1];
  }
  const value = lines[found].replace(/^- /, '  ').match(entry)[1];
  if (key !== 'gateway_media') {
    if (!/^\s*(?:\{\s*\})?\s*(?:#.*)?$/.test(value)) {
      throw new Error(`Use a block-style ${key} mapping in ${harnessProfile} before running the installer.`);
    }
    if (value.startsWith('{')) lines[found] = lines[found].replace(/:\s*\{\s*\}/, ':');
    return [found, 1];
  }
  lastChild = found;
  for (let index = found + 1; index < end; index++) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (line.length - line.trimStart().length <= indentation) break;
    lastChild = index;
  }
  return [found, lastChild - found + 1];
}
