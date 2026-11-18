import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { applyCatalog, claudeOptions } from './model-catalog.mjs';
import { manageModels, openAiFetch } from './model-manager.mjs';

const directory = fileURLToPath(new URL('.', import.meta.url));
const geminiCredentials = new URL('.env', import.meta.url);
let models = JSON.parse(readFileSync(new URL('models.json', import.meta.url)));
const token = readFileSync(new URL('gateway-token', import.meta.url), 'utf8').trim();
if (process.argv.includes('--sync')) {
  const catalogPath = process.argv[process.argv.indexOf('--sync') + 1];
  const replacements = new Map();
  if (catalogPath) {
    const bundled = JSON.parse(readFileSync(catalogPath, 'utf8'));
    for (const [legacy, next] of [['gpt-6.1-sol', 'gpt-6.2-sol'], ['gpt-6.1-terra', 'gpt-6.2-astra']]) {
      if (!models.some(model => model.provider === 'openai' && model.id === legacy)) continue;
      const replacement = bundled.find(model => model.provider === 'openai' && model.id === next);
      if (!replacement) throw new Error('Missing bundled replacement for ' + legacy);
      replacements.set(legacy, next);
      const alreadyEnabled = models.some(model => model.id === next);
      models = models.flatMap(model => model.provider === 'openai' && model.id === legacy ?
        (alreadyEnabled ? [] : [replacement]) : [model]);
    }
    const installed = new Set(models.map(model => model.id));
    models.push(...bundled.filter(model => model.provider === 'gemini' && !installed.has(model.id)));
  }
  applyCatalog(models, directory, token, replacements);
  process.exit(0);
}
const bridgeToken = process.env.WORKBUDDY_LOCAL_TOKEN;
if (!bridgeToken) throw new Error('Missing WorkBuddy bridge token');
const managerToken = readFileSync(new URL('manager-token', import.meta.url), 'utf8').trim();
const {handleWorkBuddyRequest} = await import('./bridge/workbuddy-bridge.mjs');
const updateModels = next => {
  applyCatalog(next, directory, token);
  models = next;
};

function toResponses(body, {id: model, output}, effort) {
  const system = typeof body.system === 'string' ? body.system :
    (body.system ?? []).map(block => block.text ?? '').join('\n\n');
  const input = [];
  if (system) input.push({role: 'developer', content: system});
  for (const message of body.messages) {
    let content = [];
    const flush = () => {
      if (content.length) input.push({role: message.role, content});
      content = [];
    };
    const blocks = typeof message.content === 'string' ?
      [{type: 'text', text: message.content}] : message.content;
    for (const block of blocks) {
      if (block.type === 'text') {
        if (block.text) content.push({type: message.role === 'assistant' ? 'output_text' : 'input_text', text: block.text});
      } else if (block.type === 'image') {
        const source = block.source;
        const image_url = source.type === 'url' ? source.url : `data:${source.media_type};base64,${source.data}`;
        content.push({type: 'input_image', image_url, detail: 'auto'});
      } else if (block.type === 'tool_use') {
        flush();
        input.push({type: 'function_call', call_id: block.id, name: block.name, arguments: JSON.stringify(block.input)});
      } else if (block.type === 'tool_result') {
        flush();
        const parts = typeof block.content === 'string' ? [{type: 'text', text: block.content}] : (block.content ?? []);
        const output = parts.map(part => {
          if (part.type === 'image') {
            const source = part.source;
            return {type: 'input_image', image_url: source.type === 'url' ?
              source.url : `data:${source.media_type};base64,${source.data}`};
          }
          return {type: 'input_text', text: part.text ?? JSON.stringify(part)};
        });
        if (block.is_error) output.unshift({type: 'input_text', text: 'Tool returned an error.'});
        input.push({type: 'function_call_output', call_id: block.tool_use_id, output: output.length ? output : ''});
      } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
        const encoded = block.signature ?? block.data;
        if (!effort || effort === 'none' || !encoded?.startsWith('openai:')) continue;
        const state = JSON.parse(Buffer.from(encoded.slice(7), 'base64url'));
        if (state.model !== model) continue;
        flush();
        input.push(state.item);
      }
    }
    flush();
  }
  const tools = (body.tools ?? []).filter(tool => tool.input_schema).map(tool => ({
    type: 'function', name: tool.name, description: tool.description,
    parameters: tool.input_schema, strict: false,
  }));
  const choice = body.tool_choice;
  const tool_choice = choice?.type === 'tool' ? {type: 'function', name: choice.name} :
    choice?.type === 'any' ? 'required' : choice?.type ?? 'auto';
  const format = body.output_config?.format;
  return {
    model, input, stream: true, store: false,
    max_output_tokens: Math.max(16, Math.min(body.max_tokens ?? 32000, output)),
    ...(effort ? {reasoning: effort === 'none' ? {effort} : {effort, summary: 'auto'}} : {}),
    ...(effort && effort !== 'none' ? {include: ['reasoning.encrypted_content']} : {}),
    ...(tools.length ? {tools, tool_choice, parallel_tool_calls: false} : {}),
    ...(format?.type === 'json_schema' ? {text: {format: {...format, name: 'result', strict: true}}} : {}),
  };
}

function chatToResponses(body, {id: model, output}, effort) {
  const input = [];
  for (const message of body.messages) {
    if (message.role === 'tool') {
      input.push({type: 'function_call_output', call_id: message.tool_call_id, output: message.content ?? ''});
      continue;
    }
    const role = message.role === 'system' ? 'developer' : message.role;
    const parts = typeof message.content === 'string' ? [{type: 'text', text: message.content}] :
      (message.content ?? []);
    const content = parts.flatMap(part => {
      if (part.type === 'text' && part.text) {
        return [{type: role === 'assistant' ? 'output_text' : 'input_text', text: part.text}];
      }
      if (part.type === 'image_url') {
        return [{type: 'input_image', image_url: part.image_url.url, detail: part.image_url.detail ?? 'auto'}];
      }
      return [];
    });
    if (content.length) input.push({role, content});
    for (const call of message.tool_calls ?? []) {
      input.push({type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments});
    }
  }
  const tools = (body.tools ?? []).map(({function: spec}) => ({
    type: 'function', name: spec.name, description: spec.description, parameters: spec.parameters, strict: false,
  }));
  const choice = body.tool_choice;
  const tool_choice = choice?.type === 'function' ? {type: 'function', name: choice.function.name} : choice ?? 'auto';
  const format = body.response_format;
  return {
    model, input, stream: true, store: false,
    max_output_tokens: Math.max(16, Math.min(body.max_completion_tokens ?? body.max_tokens ?? 32000, output)),
    ...(effort ? {reasoning: effort === 'none' ? {effort} : {effort, summary: 'auto'}} : {}),
    ...(tools.length ? {tools, tool_choice, parallel_tool_calls: body.parallel_tool_calls ?? false} : {}),
    ...(format?.type === 'json_schema' ? {text: {format: {type: 'json_schema', ...format.json_schema}}} : {}),
    ...(format?.type === 'json_object' ? {text: {format}} : {}),
  };
}

async function *responseEvents(upstream) {
  const responseStream = Readable.fromWeb(upstream.body);
  const lines = createInterface({input: responseStream, crlfDelay: Infinity});
  responseStream.on('error', () => lines.close());
  try {
    for await (const line of lines) {
      if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
      const event = JSON.parse(line.slice(6));
      if (event.type === 'error' || event.type === 'response.failed') {
        throw new Error(event.message ?? event.response?.error?.message ?? 'OpenAI response failed');
      }
      yield event;
    }
    throw new Error('OpenAI closed the response before completion');
  } finally {
    lines.close();
    responseStream.destroy();
  }
}

async function relayChat(upstream, res, body) {
  const stream = body.stream === true;
  const message = {role: 'assistant', content: ''};
  const envelope = {id: '', model: body.model, created: 0};
  const send = (delta, finish_reason = null, usage) => {
    if (!stream) return;
    const choices = usage ? [] : [{index: 0, delta, finish_reason}];
    res.write(`data: ${JSON.stringify({...envelope, object: 'chat.completion.chunk', choices, usage})}\n\n`);
  };
  if (stream) res.writeHead(200, {'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache'});
  const heartbeat = stream ? setInterval(() => res.write(': ping\n\n'), 12000) : undefined;
  try {
    for await (const event of responseEvents(upstream)) {
      if (!envelope.id && event.response?.id) {
        envelope.id = event.response.id.replace(/^resp_/, 'chatcmpl-');
        envelope.created = event.response.created_at;
        send({role: 'assistant', content: ''});
      }
      switch (event.type) {
        case 'response.output_text.delta':
        case 'response.refusal.delta':
          message.content += event.delta;
          send({content: event.delta});
          break;
        case 'response.reasoning_summary_text.delta':
          message.reasoning_content = (message.reasoning_content ?? '') + event.delta;
          send({reasoning_content: event.delta});
          break;
        case 'response.output_item.done': {
          const item = event.item;
          if (item.type !== 'function_call') break;
          message.tool_calls ??= [];
          const call = {id: item.call_id, type: 'function', function: {name: item.name, arguments: item.arguments}};
          send({tool_calls: [{index: message.tool_calls.length, ...call}]});
          message.tool_calls.push(call);
          break;
        }
        case 'response.completed':
        case 'response.incomplete': {
          const counts = event.response.usage;
          const usage = {prompt_tokens: counts?.input_tokens ?? 0, completion_tokens: counts?.output_tokens ?? 0,
            total_tokens: counts?.total_tokens ?? 0, prompt_tokens_details: counts?.input_tokens_details,
            completion_tokens_details: counts?.output_tokens_details};
          const finish_reason = event.response.incomplete_details?.reason === 'max_output_tokens' ? 'length' :
            message.tool_calls?.length ? 'tool_calls' : 'stop';
          if (!stream) {
            if (message.tool_calls?.length && !message.content) message.content = null;
            return json(res, 200, {...envelope, object: 'chat.completion', choices: [{index: 0, message, finish_reason}], usage});
          }
          send({}, finish_reason);
          if (body.stream_options?.include_usage) send({}, null, usage);
          res.end('data: [DONE]\n\n');
          return;
        }
      }
    }
  } finally {
    clearInterval(heartbeat);
  }
}

async function relay(upstream, res, body, model) {
  const stream = body.stream === true;
  const content = [];
  let index = 0;
  let started = false;
  let textBlock = null;
  const message = {id: '', type: 'message', role: 'assistant', model: body.model, content: [],
    stop_reason: null, stop_sequence: null, usage: {input_tokens: 0, output_tokens: 0}};
  const send = (type, data = {}) => {
    if (stream) res.write(`event: ${type}\ndata: ${JSON.stringify({type, ...data})}\n\n`);
  };
  const closeText = () => {
    if (textBlock === null) return;
    send('content_block_stop', {index: index++});
    textBlock = null;
  };
  if (stream) res.writeHead(200, {'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache'});
  const heartbeat = stream ? setInterval(() => send('ping'), 12000) : undefined;
  try {
    for await (const event of responseEvents(upstream)) {
      if (!started && event.response?.id) {
        started = true;
        message.id = event.response.id.replace(/^resp_/, 'msg_');
        send('message_start', {message});
      }
      switch (event.type) {
        case 'response.output_text.delta':
        case 'response.refusal.delta':
          if (textBlock === null) {
            textBlock = {type: 'text', text: ''};
            content.push(textBlock);
            send('content_block_start', {index, content_block: textBlock});
          }
          textBlock.text += event.delta;
          send('content_block_delta', {index, delta: {type: 'text_delta', text: event.delta}});
          break;
        case 'response.output_item.done': {
          closeText();
          const item = event.item;
          if (item.type === 'function_call') {
            const call = {type: 'tool_use', id: item.call_id, name: item.name, input: {}};
            send('content_block_start', {index, content_block: call});
            call.input = JSON.parse(item.arguments || '{}');
            content.push(call);
            send('content_block_delta', {index, delta: {type: 'input_json_delta', partial_json: item.arguments || '{}'}});
            send('content_block_stop', {index: index++});
          } else if (item.type === 'reasoning' && item.encrypted_content) {
            const signature = 'openai:' + Buffer.from(JSON.stringify({model, item})).toString('base64url');
            const thinking = (item.summary ?? []).map(part => part.text).join('\n\n');
            if (thinking) {
              const block = {type: 'thinking', thinking: '', signature: ''};
              send('content_block_start', {index, content_block: block});
              send('content_block_delta', {index, delta: {type: 'thinking_delta', thinking}});
              send('content_block_delta', {index, delta: {type: 'signature_delta', signature}});
              content.push({type: 'thinking', thinking, signature});
            } else {
              const block = {type: 'redacted_thinking', data: signature};
              send('content_block_start', {index, content_block: block});
              content.push(block);
            }
            send('content_block_stop', {index: index++});
          }
          break;
        }
        case 'response.completed':
        case 'response.incomplete': {
          closeText();
          const usage = event.response.usage;
          const cached = usage?.input_tokens_details?.cached_tokens ?? 0;
          message.usage = {input_tokens: (usage?.input_tokens ?? 0) - cached,
            cache_read_input_tokens: cached, output_tokens: usage?.output_tokens ?? 0};
          message.stop_reason = event.response.incomplete_details?.reason === 'max_output_tokens' ? 'max_tokens' :
            content.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn';
          if (stream) {
            send('message_delta', {delta: {stop_reason: message.stop_reason, stop_sequence: null}, usage: message.usage});
            send('message_stop');
            res.end();
          } else {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({...message, content}));
          }
          return;
        }
      }
    }
  } finally {
    clearInterval(heartbeat);
  }
}

function json(res, status, value) {
  res.writeHead(status, {'Content-Type': 'application/json'});
  res.end(JSON.stringify(value));
}

createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  const anthropic = path.startsWith('/v1/messages');
  const chat = path === '/v1/chat/completions' || path === '/workbuddy/v1/chat/completions';
  const native = path === '/v1/responses';
  const fail = (status, type, message) => json(res, status,
    {...(anthropic ? {type: 'error'} : {}), error: {type, message}});
  if (req.method === 'GET' && path === '/health') {
    return json(res, 200, {service: 'local-ai-model-gateway', version: 2, pid: process.pid});
  }
  if (path === '/manage' || path.startsWith('/manage/api/')) {
    return manageModels(req, res, path, managerToken, models, updateModels,
      body => complete(req, res, '/v1/chat/completions', body, true));
  }
  const requestToken = req.headers.authorization?.startsWith('Bearer ') ?
    req.headers.authorization.slice(7) : req.headers['x-api-key'];
  if (requestToken !== token && requestToken !== bridgeToken) {
    return fail(401, 'authentication_error', 'Invalid local gateway token');
  }
  if (path === '/v1/auth/device') {
    req.headers.authorization = 'Bearer ' + bridgeToken;
    return handleWorkBuddyRequest(req, res);
  }
  if (req.method === 'GET' && ['/v1/models', '/workbuddy/v1/models'].includes(path)) {
    return json(res, 200, {object: 'list', data: models.map(({id, name, provider, efforts}) => ({
      id, object: 'model', type: 'model', display_name: name, owned_by: provider, reasoning_efforts: efforts,
      created_at: '2026-11-16T00:00:00Z',
    })), has_more: false});
  }
  if (req.method !== 'POST' || (!chat && !native && !['/v1/messages', '/v1/messages/count_tokens'].includes(path))) {
    return fail(404, 'not_found_error', 'Unknown gateway route');
  }
  let body;
  try {
    const readable = req.headers['content-encoding'] === 'gzip' ? req.pipe(createGunzip()) : req;
    const chunks = [];
    for await (const chunk of readable) chunks.push(chunk);
    body = JSON.parse(Buffer.concat(chunks));
    if (!body || typeof body.model !== 'string') throw new Error();
  } catch {
    return fail(400, 'invalid_request_error', 'Expected JSON with a model ID');
  }
  return complete(req, res, path, body);
}).listen(8791, '127.0.0.1');

async function complete(req, res, path, body, plainChat = false) {
  const anthropic = path.startsWith('/v1/messages');
  const chat = path === '/v1/chat/completions' || path === '/workbuddy/v1/chat/completions';
  const native = path === '/v1/responses';
  const fail = (status, type, message) => json(res, status,
    {...(anthropic ? {type: 'error'} : {}), error: {type, message}});
  const selection = anthropic ? claudeOptions(models).find(option => option.id === body.model) :
    {model: models.find(model => model.id === body.model)};
  const model = selection?.model;
  if (!model || (native && model.provider !== 'openai')) {
    return fail(400, 'invalid_request_error', plainChat ? '请选择已同步的模型。' : 'Unknown model for this route');
  }
  if (path === '/v1/messages/count_tokens') {
    return json(res, 200, {input_tokens: Math.ceil(Buffer.byteLength(JSON.stringify(body)) / 3)});
  }
  // Harness can send the chosen effort at the end of its native Responses input.
  const configurationEffort = native && Array.isArray(body.input) ?
    body.input.findLast(item => item?.type === 'configuration_update')?.reasoning?.effort : undefined;
  const effort = selection.fixed ?? (chat ? body.reasoning_effort : native ?
    configurationEffort ?? body.reasoning?.effort : body.output_config?.effort) ??
    (path.startsWith('/workbuddy/') && model.efforts.includes('none') ? 'none' : model.defaultEffort);
  if ((effort || (plainChat && effort === '')) && !model.efforts.includes(effort)) {
    return fail(400, 'invalid_request_error', plainChat ? '该模型不支持所选思考档位。' : 'Unsupported reasoning effort for this model');
  }
  const client = plainChat ? 'manager-chat' : anthropic ? 'claude' : path.startsWith('/workbuddy/') ? 'workbuddy' : 'harness';
  res.on('finish', () => console.log(new Date().toISOString(), client, model.provider, model.id, effort ?? '-', res.statusCode));

  try {
    if (model.provider === 'workbuddy') {
      body.model = model.id;
      req.headers.authorization = 'Bearer ' + bridgeToken;
      delete req.headers['x-api-key'];
      if (chat) {
        if (effort) body.reasoning_effort = effort;
        req.url = '/v1/chat/completions';
      } else {
        body.output_config = {...body.output_config, effort};
      }
      return await handleWorkBuddyRequest(req, res, body, plainChat);
    }
    const abort = new AbortController();
    res.once('close', () => {
      if (!res.writableEnded) abort.abort();
    });
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(600000)]);
    if (model.provider === 'gemini') {
      const variable = model.account === 'free' ? 'GEMINI_API_KEY' : 'GEMINI_PAID_API_KEY';
      const local = existsSync(geminiCredentials) ? parseEnv(readFileSync(geminiCredentials, 'utf8')) : {};
      const key = local[variable]?.trim() || process.env[variable]?.trim();
      if (!key) return fail(503, 'authentication_error', `请在网关目录的 .env 中设置 ${variable}。`);
      const upstream = await fetch('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', {
        method: 'POST', headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + key},
        body: JSON.stringify({...body, model: model.upstream, reasoning_effort: effort, store: undefined}),
        signal,
      });
      if (!upstream.ok) {
        const {error} = await upstream.json().catch(() => ({}));
        const message = error?.message?.replaceAll(key, '[redacted]') ?? `Google AI Studio HTTP ${upstream.status}`;
        return fail(upstream.status, 'api_error', message);
      }
      res.writeHead(upstream.status, {'Content-Type': upstream.headers.get('content-type') ?? 'application/json',
        'Cache-Control': 'no-cache'});
      return await pipeline(Readable.fromWeb(upstream.body), res);
    }
    const payload = native ? {
      ...body, store: false,
      ...(effort && !configurationEffort ? {reasoning: {...body.reasoning, effort}} : {}),
    } : chat ? chatToResponses(body, model, effort) : toResponses(body, model, effort);
    const upstream = await openAiFetch('/responses', {method: 'POST', body: JSON.stringify(payload), signal});
    if (!upstream.ok) {
      const error = (await upstream.json().catch(() => ({}))).error;
      const type = ({400:'invalid_request_error', 401:'authentication_error', 403:'permission_error',
        404:'not_found_error', 429:'rate_limit_error'})[upstream.status] ?? 'api_error';
      return fail(upstream.status, type, error?.message ?? 'OpenAI request failed');
    }
    if (native) {
      res.writeHead(upstream.status, {'Content-Type': upstream.headers.get('content-type') ?? 'application/json',
        'Cache-Control': 'no-cache'});
      return await pipeline(Readable.fromWeb(upstream.body), res);
    }
    if (chat) await relayChat(upstream, res, body);
    else await relay(upstream, res, body, model.id);
  } catch (error) {
    if (res.destroyed) return;
    const message = error.message.replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]');
    const payload = {type: 'error', error: {type: 'api_error', message}};
    if (!res.headersSent) return fail(502, 'api_error', message);
    if (chat) return res.end('data: ' + JSON.stringify({error: payload.error}) + '\n\ndata: [DONE]\n\n');
    res.end('event: error\ndata: ' + JSON.stringify(payload) + '\n\n');
  }
}
