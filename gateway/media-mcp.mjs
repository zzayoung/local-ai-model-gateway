import {randomUUID} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createInterface} from 'node:readline';
import {pathToFileURL} from 'node:url';
import {endpoint} from './model-catalog.mjs';
import {mediaModels, mediaRoutes} from './media-gateway.mjs';

const [imageRoute, speechRoute, musicRoute] = mediaRoutes;
const outputDirectory = join(import.meta.dirname, 'media-output');
const supportedVersions = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const tasks = [
  {
    name: 'generate_image',
    title: '生成图片',
    route: imageRoute,
    description: '根据提示词生成一张图片。',
    defaultModel: 'gpt-image-2.6-flare',
    input: 'prompt',
    inputDescription: '图片提示词。',
  },
  {
    name: 'synthesize_speech',
    title: '生成语音',
    route: speechRoute,
    description: '朗读文本并生成 WAV 文件。默认使用免费入口。',
    defaultModel: 'gemini-3.8-flash-tts-free',
    input: 'text',
    inputDescription: '要朗读的原文。',
  },
  {
    name: 'generate_music',
    title: '生成音乐',
    route: musicRoute,
    description: '根据风格、乐器和节奏描述生成 MP3 音乐。',
    defaultModel: 'lyria-3.5',
    input: 'prompt',
    inputDescription: '音乐提示词。',
  },
];

const tools = tasks.map(task => {
  const models = mediaModels.filter(model => model.route === task.route);
  const modelChoices = models.map(model =>
    model.id + '（' + model.name + (model.account === 'free' ? '，免费入口' : '，付费入口') + '）'
  );
  const properties = {
    [task.input]: {type: 'string', description: task.inputDescription, minLength: 1, maxLength: 32000},
    model: {type: 'string', enum: models.map(model => model.id), default: task.defaultModel,
      description: '可选模型：' + modelChoices.join('、')},
  };
  if (task.route === speechRoute) {
    properties.voice = {type: 'string', default: 'Kore', description: 'Gemini 音色名称。'};
  }
  return {
    name: task.name,
    description: task.description + ' 合适时按用户指定的模型调用。完成后把本地文件链接和路径告诉用户。',
    inputSchema: {type: 'object', properties, required: [task.input], additionalProperties: false},
  };
});

async function callTool(params, signal) {
  const task = tasks.find(task => task.name === params?.name);
  if (!task) throw new Error('找不到该生成工具。');
  const args = params.arguments;
  const input = args?.[task.input];
  if (typeof input !== 'string' || !input.trim() || input.length > 32000) {
    throw new Error('请输入 1 至 32000 字符的提示词或文本。');
  }
  const model = mediaModels.find(model =>
    model.id === (args.model ?? task.defaultModel) && model.route === task.route
  );
  if (!model) throw new Error('请选择工具列表中的模型。');
  let payload = {model: model.id, input};
  if (task.route === imageRoute) {
    payload = {model: model.id, prompt: input, size: '1024x1024', n: 1};
    if (model.provider === 'openai') Object.assign(payload, {quality: 'low', output_format: 'png'});
  } else if (task.route === speechRoute) {
    payload.voice = args.voice ?? 'Kore';
  }
  const token = (await readFile(join(import.meta.dirname, 'gateway-token'), 'utf8').catch(() => '')).trim();
  if (!token) throw new Error('本机网关尚未配置访问令牌。');
  const response = await fetch(endpoint + task.route, {
    method: 'POST',
    headers: {authorization: 'Bearer ' + token, 'content-type': 'application/json'},
    signal: AbortSignal.any([signal, AbortSignal.timeout(310000)]),
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const result = await response.json().catch(() => null);
    throw new Error(result?.error?.message || '网关调用失败（HTTP ' + response.status + '）。');
  }
  let bytes;
  let extension;
  if (task.route === imageRoute) {
    const result = await response.json();
    const image = result.data?.[0];
    if (!image?.b64_json) throw new Error('网关没有返回图片。');
    bytes = Buffer.from(image.b64_json, 'base64');
    extension = image.mime_type === 'image/jpeg' ? 'jpg' : 'png';
  } else {
    bytes = Buffer.from(await response.arrayBuffer());
    extension = task.route === speechRoute ? 'wav' : 'mp3';
  }
  if (!bytes.length) throw new Error('网关返回了空文件。');
  const file = join(outputDirectory, model.id + '-' + randomUUID() + '.' + extension);
  await mkdir(outputDirectory, {recursive: true});
  await writeFile(file, bytes);
  const entry = model.account === 'free' ? '（免费入口）' : '';
  return {content: [{type: 'text', text:
    task.title + '完成 · ' + model.name + entry +
    '\n[打开生成文件](' + pathToFileURL(file).href + ')\n文件路径：' + file}]};
}

const pending = new Map();
const lines = createInterface({input: process.stdin, crlfDelay: Infinity});
lines.on('line', async line => {
  const send = body => process.stdout.write(JSON.stringify({jsonrpc: '2.0', ...body}) + '\n');
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    send({id: null, error: {code: -32700, message: 'Invalid JSON'}});
    return;
  }
  const {id, method, params} = request ?? {};
  if (method === 'notifications/cancelled') pending.get(params?.requestId)?.abort();
  if (id === undefined) return;

  if (method === 'initialize') {
    const requested = params?.protocolVersion;
    send({id, result: {
      protocolVersion: supportedVersions.includes(requested) ? requested : supportedVersions[0],
      serverInfo: {name: 'gateway_media', version: '1.0.0'},
      capabilities: {tools: {}},
    }});
  } else if (method === 'ping') {
    send({id, result: {}});
  } else if (method === 'tools/list') {
    send({id, result: {tools}});
  } else if (method === 'tools/call') {
    const abort = new AbortController();
    pending.set(id, abort);
    try {
      const result = await callTool(params, abort.signal);
      if (!abort.signal.aborted) send({id, result});
    } catch (error) {
      if (!abort.signal.aborted) send({id, result: {isError: true,
        content: [{type: 'text', text: error.message}]}});
    } finally {
      pending.delete(id);
    }
  } else {
    send({id, error: {code: -32601, message: 'Method not found'}});
  }
});
lines.on('close', () => {
  for (const abort of pending.values()) abort.abort();
});
