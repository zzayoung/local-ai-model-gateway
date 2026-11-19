import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { efforts } from './model-catalog.mjs';
import { mediaModels } from './media-gateway.mjs';

const credentials = join(process.env.DSH_HOME, '.credentials.yaml');
const localKey = new URL('openai-key', import.meta.url);
const page = readFileSync(new URL('model-manager.html', import.meta.url));
const restartScript = fileURLToPath(new URL('Restart-ModelClients.ps1', import.meta.url));
const run = promisify(execFile);
let available = new Map();
let reviewed = new Map();
let restarting = false;

export function openAiFetch(path, options) {
  const key = (existsSync(localKey) ? readFileSync(localKey, 'utf8').trim() : undefined) ||
    process.env.OPENAI_API_KEY ||
    (existsSync(credentials) ? readFileSync(credentials, 'utf8') : '').match(/^\s*OPENAI_API_KEY:[ \t]*['"]?(sk-[A-Za-z0-9_-]+)/m)?.[1];
  if (!key) throw new Error('找不到现有的 OpenAI 官方 API 凭据。');
  return fetch('https://api.openai.com/v1' + path, {
    ...options, headers: {authorization: 'Bearer ' + key, 'content-type': 'application/json'},
  });
}

async function inspect(id) {
  if (reviewed.has(id)) return reviewed.get(id);
  const base = id.replace(/-\d{4}-\d{2}-\d{2}$/, '');
  const docs = 'https://developers.openai.com/api/docs/models/' + base;
  const response = await fetch(docs + '.md', {signal: AbortSignal.timeout(15000)});
  if (!response.ok) throw new Error('暂时无法从官方文档核对这个模型的能力。');
  const text = (await response.text()).replace(/\r\n/g, '\n');
  if (!text.includes('\x60' + id + '\x60')) throw new Error('官方文档未列出这个模型 ID。');
  if (!/\|\s*\x60v1\/responses\x60\s*\|\s*Supported\s*\|/i.test(text) ||
      !/^[-*] Output modalities:[^\n]*\btext\b/im.test(text) ||
      !/^[-*] function_calling\s*$/im.test(text)) {
    throw new Error('官方文档未确认同时支持 Responses、文本输出和函数调用。');
  }
  const context = text.match(/^[-*] ([\d,]+) context window\b/im)?.[1];
  const output = text.match(/^[-*] ([\d,]+) max output tokens\b/im)?.[1];
  if (!context || !output) throw new Error('官方文档未列出可识别的上下文或输出上限。');
  const normalized = text.replaceAll('\x60', '');
  const described = normalized.match(/reasoning\.effort[ \t]+supports[ \t]*:?\s+([a-z, ()\n \t]+)\./i)?.[1];
  const levels = described ? efforts.filter(effort => new RegExp('\\b' + effort + '\\b', 'i').test(described)) : [];
  if (!levels.length && /reasoning token support|reasoning\.effort/i.test(normalized)) {
    throw new Error('官方文档中的思考档位还需要核对。');
  }
  const markedDefault = described?.match(/\b([a-z]+)\s*\(default\)/i)?.[1];
  const defaultEffort = levels.includes(markedDefault) ? markedDefault :
    levels.includes('medium') ? 'medium' : levels[0];
  const contextLimit = text.match(/more than ([\d,]+)K input tokens are priced/i)?.[1];
  const model = {
    id, name: text.match(/^# ([^\n]+)$/m)?.[1].trim() ?? id, provider: 'openai',
    context: Math.min(Number(context.replaceAll(',', '')), contextLimit ? Number(contextLimit.replaceAll(',', '')) * 1000 : Infinity),
    output: Number(output.replaceAll(',', '')),
    image: /^[-*] Input modalities:[^\n]*\bimage\b/im.test(text),
    tools: true, efforts: levels, defaultEffort, docs,
  };
  reviewed.set(id, model);
  return model;
}

export async function manageModels(req, res, path, managerToken, models, apply, chat, generateMedia) {
  const reply = (status, value) => {
    res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
    res.end(JSON.stringify(value));
  };
  if (req.headers.host !== '127.0.0.1:8791' ||
      (req.headers.origin && req.headers.origin !== 'http://127.0.0.1:8791')) {
    return reply(403, {error: '请从本机的「模型管理」入口打开。'});
  }
  if (req.method === 'GET' && path === '/manage') {
    res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src blob:; media-src blob:; base-uri 'none'; frame-ancestors 'none'"});
    return res.end(page);
  }
  if (req.headers.authorization !== 'Bearer ' + managerToken) {
    return reply(401, {error: '请重新双击「模型管理.cmd」打开。'});
  }
  try {
    if (req.method === 'GET' && path === '/manage/api/status') return reply(200, {models, mediaModels});
    if (req.method === 'POST' && path === '/manage/api/restart') {
      if (restarting) return reply(409, {error: '正在重启客户端，请稍候。'});
      restarting = true;
      try {
        const {stdout} = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', restartScript],
          {windowsHide: true, timeout: 60000});
        return reply(200, {clients: JSON.parse(stdout)});
      } catch {
        return reply(502, {error: '未能完成客户端重启，请检查已打开的客户端。'});
      } finally {
        restarting = false;
      }
    }
    if (req.method === 'GET' && path === '/manage/api/check') {
      const response = await openAiFetch('/models', {signal: AbortSignal.timeout(20000)});
      if (!response.ok) throw new Error('OpenAI 官方模型清单查询失败（HTTP ' + response.status + '）。');
      const {data} = await response.json();
      if (!Array.isArray(data)) throw new Error('OpenAI 官方返回的模型清单格式异常。');
      const active = new Set([...models, ...mediaModels].map(model => model.id));
      available = new Map(data.filter(row => typeof row?.id === 'string' &&
        /^[a-z0-9][a-z0-9.-]+$/.test(row.id) && !active.has(row.id))
        .map(({id, shutdown_date}) => [id, {id, shutdown: shutdown_date}]));
      reviewed = new Map();
      return reply(200, {candidates: [...available.values()].sort((a, b) => a.id.localeCompare(b.id))});
    }
    if (req.method === 'GET' && path === '/manage/api/inspect') {
      const id = new URL(req.url, 'http://127.0.0.1:8791').searchParams.get('id');
      if (!available.has(id)) return reply(400, {error: '请先检查更新，再选择模型。'});
      const model = await inspect(id);
      return reply(200, {model});
    }
    if (req.method === 'POST' && ['/manage/api/apply', '/manage/api/chat', '/manage/api/media'].includes(path)) {
      let selection;
      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        selection = JSON.parse(Buffer.concat(chunks));
      } catch {
        return reply(400, {error: '无法读取请求内容。'});
      }
      if (path === '/manage/api/media') return generateMedia(res, path, selection);
      if (path === '/manage/api/chat') {
        const {model, effort, system = '', messages} = selection ?? {};
        if (typeof model !== 'string' || (effort !== undefined && typeof effort !== 'string') ||
            typeof system !== 'string' || !Array.isArray(messages) || messages.length % 2 !== 1 ||
            messages.some((message, index) => message?.role !== (index % 2 === 0 ? 'user' : 'assistant') ||
              typeof message.content !== 'string' || !message.content.trim())) {
          return reply(400, {error: '请选择模型，并发送一条文本消息。'});
        }
        res.setHeader('Cache-Control', 'no-store');
        return chat({
          model, reasoning_effort: effort, stream: false,
          messages: [
            ...(system ? [{role: 'system', content: system}] : []),
            ...messages.map(({role, content}) => ({role, content})),
          ],
        });
      }
      const ids = selection?.ids;
      const active = new Set(models.map(model => model.id));
      if (selection?.confirm !== true || !Array.isArray(ids) || !ids.length ||
          ids.some(id => !available.has(id) || !reviewed.has(id) || active.has(id))) {
        return reply(400, {error: '请勾选已核对的模型，再点击「确认并同步」。'});
      }
      const next = [...models, ...[...new Set(ids)].map(id => reviewed.get(id))];
      apply(next);
      for (const id of ids) available.delete(id);
      return reply(200, {models: next});
    }
    return reply(404, {error: '找不到该页面。'});
  } catch (error) {
    return reply(502, {error: error.message.replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]')});
  }
}
