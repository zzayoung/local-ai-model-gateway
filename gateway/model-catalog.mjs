import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const efforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const slider = ['low', 'medium', 'high', 'xhigh', 'max'];
export const endpoint = 'http://127.0.0.1:8791';
const workBuddyChat = endpoint + '/workbuddy/v1/chat/completions';
const harnessHome = process.env.DSH_HOME;
const harnessProviders = {openai: 'OpenAI 官方', workbuddy: 'WorkBuddy', 'gemini-gateway': 'Google AI Studio（本地网关）'};

export function claudeOptions(catalog) {
  return catalog.filter(model => model.provider !== 'gemini').flatMap(model => {
    const label = model.name + (model.provider === 'workbuddy' ? ' (WorkBuddy)' : '');
    const useSlider = slider.every(effort => model.efforts.includes(effort)) && !model.efforts.includes('minimal');
    const rows = [{model, id: model.id, label,
      ...(useSlider ? {behavesAs: 'claude-opus-4-8'} : {fixed: model.defaultEffort})}];
    for (const effort of model.efforts) {
      if (useSlider ? slider.includes(effort) : effort === model.defaultEffort) continue;
      rows.push({model, id: model.id + '-' + effort,
        label: label + (effort === 'none' ? ' (no reasoning)' : ' (' + effort + ')'), fixed: effort});
    }
    return rows;
  });
}

export function applyCatalog(catalog, gateway, token, replacements = new Map()) {
  const claude = {modelPicker: {replaceBuiltInOptions: true, options: claudeOptions(catalog)
    .map(({id, label, behavesAs}) => ({model: id, label, behavesAs}))}};
  const desktop = join(harnessHome, 'profiles', 'desktop', 'cordis.patch.yml');
  const current = readFileSync(desktop, 'utf8');
  const providers = {};
  for (const [vendor, displayName] of Object.entries(harnessProviders)) {
    const provider = vendor === 'gemini-gateway' ? 'gemini' : vendor;
    const entries = catalog.filter(model => model.provider === provider);
    if (!entries.length) { providers[vendor] = ''; continue; }
    const rows = entries.flatMap(model => [
      `          - id: ${model.id}`,
      `            name: ${JSON.stringify(model.name)}`,
      `            contextWindow: ${model.context}`,
      `            maxTokens: ${model.output}`,
      `            input: [text${model.image ? ', image' : ''}]`,
      ...(model.efforts.length ? [
        `            reasoningEfforts: { ${model.efforts.map(effort => effort === 'none' ? 'off: none' : effort + ': ' + effort).join(', ')} }`,
      ] : ['            reasoningEfforts: false']),
    ]);
    providers[vendor] = [
      '      ' + vendor + ':',
      '        displayName: ' + displayName,
      '        apiKeyEnv: WORKBUDDY_BRIDGE_KEY',
      '        api: ' + (vendor === 'openai' ? 'openai-responses' : 'openai-completions'),
      '        baseURL: ' + endpoint + '/v1',
      ...(vendor === 'openai' ? ['        transport: sse'] : [
        '        compat: { thinkingFormat: openai, supportsReasoningEffort: true }',
      ]),
      '        timeoutMs: 600000',
      '        streamIdleTimeoutMs: 600000',
      '        models:',
      ...rows, '',
    ].join('\n');
  }
  let harness = current.replace(/\r\n/g, '\n');
  for (const vendor of Object.keys(harnessProviders)) {
    const block = new RegExp(`^      ${vendor}:\\n(?:^ {8,}[^\\n]*\\n)*`, 'm');
    if (block.test(harness)) {
      harness = harness.replace(block, () => providers[vendor]);
    } else if (providers[vendor]) {
      const start = /^  name: "@deepseek-ai\/dsh-llm-pi-ai"\n  config:\n    providers:\n/m;
      if (!start.test(harness)) throw new Error('找不到 Harness 的供应商配置。');
      harness = harness.replace(start, line => line + providers[vendor]);
    }
  }
  harness = harness.replace(/(    provider: )(openai|workbuddy)\n    model: (\S+)\n(?:    reasoningEffort: (\S+)\n)?/,
    (block, lead, vendor, id, effort) => {
      if (catalog.some(model => model.id === id && model.provider === vendor)) return block;
      const replacementId = vendor === 'openai' ? replacements.get(id) : undefined;
      const replacement = catalog.find(model => model.id === replacementId && model.provider === vendor);
      if (replacement) {
        const level = replacement.efforts.includes(effort) ? effort : replacement.defaultEffort;
        return `${lead}${vendor}\n    model: ${replacement.id}\n    reasoningEffort: ${level}\n`;
      }
      const fallback = catalog[0];
      return `${lead}${fallback.provider}\n    model: ${fallback.id}\n`;
    });

  const local = join(homedir(), '.workbuddy', 'models.json');
  const root = JSON.parse(readFileSync(local, 'utf8').replace(/^\uFEFF/, ''));
  const original = Array.isArray(root) ? root : root.models;
  if (!Array.isArray(original)) throw new Error('WorkBuddy 的模型配置格式无法识别。');
  const ids = new Set(catalog.map(model => model.id));
  const entries = original.filter(entry => entry.url !== workBuddyChat && !ids.has(entry.id));
  entries.push(...catalog.map(model => ({
    id: model.id,
    name: model.provider === 'gemini' ? model.name : `${model.name} (${model.provider === 'openai' ? 'OpenAI' : 'WorkBuddy'})`,
    vendor: 'Custom',
    url: workBuddyChat,
    apiKey: token,
    supportsToolCall: model.tools,
    supportsImages: model.image,
    supportsReasoning: model.efforts.some(effort => effort !== 'none'),
    onlyReasoning: model.efforts.length > 0 && !model.efforts.includes('none'),
    useCustomProtocol: true,
    maxInputTokens: model.context,
    maxOutputTokens: model.output,
    ...(model.efforts.length ? {reasoning: {
      defaultEffort: model.defaultEffort,
      supportedEfforts: model.efforts.filter(effort => effort !== 'none'),
      canDisableThinking: model.efforts.includes('none'),
    }} : {}),
  })));

  const serialize = data => JSON.stringify(data, null, 2) + '\n';
  const files = [
    [join(gateway, 'claude-settings.json'), serialize(claude)],
    [desktop, current.includes('\r\n') ? harness.replace(/\n/g, '\r\n') : harness],
    [local, serialize(Array.isArray(root) ? entries : {...root, models: entries})],
    [join(gateway, 'harness-providers.yml'), [
      '- id: llm-pi-ai', '  name: "@deepseek-ai/dsh-llm-pi-ai"', '  config:', '    providers:',
      providers.workbuddy + providers.openai + providers['gemini-gateway'],
    ].join('\n')],
    [join(gateway, 'models.json'), serialize(catalog)],
  ];
  const originals = files.map(([file]) => existsSync(file) ? readFileSync(file) : null);
  const written = [];
  try {
    for (const [file, content] of files) writeFileSync(file + '.sync', content);
    for (const [file] of files) {
      renameSync(file + '.sync', file);
      written.push(file);
    }
  } catch (error) {
    for (const [index, file] of written.entries()) {
      const original = originals[index];
      if (original === null) unlinkSync(file);
      else writeFileSync(file, original);
    }
    throw error;
  } finally {
    for (const [file] of files) {
      if (existsSync(file + '.sync')) unlinkSync(file + '.sync');
    }
  }
}
