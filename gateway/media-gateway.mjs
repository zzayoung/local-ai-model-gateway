const image = '/v1/images/generations';
const speech = '/v1/audio/speech';
const music = '/v1/audio/music';
export const mediaRoutes = [image, speech, music];

export const mediaModels = [
  {id: 'gpt-image-2.6-flare', name: 'GPT Image 2.6 Flare', provider: 'openai', route: image},
  {id: 'gpt-image-2.6-sunburst', name: 'GPT Image 2.6 Sunburst', provider: 'openai', route: image},
  {id: 'gemini-nano-banana-2.1', name: 'Nano Banana 2.1', provider: 'gemini', account: 'paid', route: image},
  ...[
    ['gemini-3.8-flash-tts', 'Gemini 3.8 Flash TTS'],
    ['gemini-3.8-flash-lite-tts', 'Gemini 3.8 Flash-Lite TTS'],
  ].flatMap(([id, name]) => [
    {id: id + '-free', name, provider: 'gemini', account: 'free', route: speech, upstream: id},
    {id, name, provider: 'gemini', account: 'paid', route: speech},
  ]),
  {id: 'lyria-3.5', name: 'Lyria 3.5', provider: 'gemini', account: 'paid', route: music},
];

const aspectRatios = new Map([['auto', '1:1'], ['1024x1024', '1:1'], ['1536x1024', '3:2'], ['1024x1536', '2:3']]);
const googleURL = 'https://generativelanguage.googleapis.com/v1beta/interactions';

export function createMediaHandler(openAiFetch, getGeminiKey) {
  return async (res, path, body) => {
    const preview = path === '/manage/api/media';
    const model = mediaModels.find(model => model.id === body?.model);
    const json = (status, data) => {
      res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
      res.end(JSON.stringify(data));
    };
    if (!model || (!preview && model.route !== path)) {
      return json(400, {error: {message: '该模型不支持此生成入口。'}});
    }
    const input = preview || model.route !== image ? body.input : body.prompt;
    if (typeof input !== 'string' || !input.trim() || input.length > 32000) {
      return json(400, {error: {message: '请输入 1 至 32000 字符的提示词或文本。'}});
    }
    const abort = new AbortController();
    res.once('close', () => {
      if (!res.writableEnded) abort.abort();
    });
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(300000)]);
    try {
      let upstream;
      if (model.provider === 'openai') {
        const payload = preview ? {model: model.id, prompt: input, n: 1,
          size: '1024x1024', quality: 'low', output_format: 'png'} : body;
        upstream = await openAiFetch('/images/generations', {method: 'POST', body: JSON.stringify(payload), signal});
      } else {
        const payload = {model: model.upstream ?? model.id, input, store: false};
        if (model.route === image) {
          const aspectRatio = aspectRatios.get(body.size ?? 'auto');
          if (!aspectRatio || (body.n !== undefined && body.n !== 1)) {
            return json(400, {error: {message: 'Nano Banana 支持单张输出，尺寸可选 auto、1024x1024、1536x1024 或 1024x1536。'}});
          }
          if (body.output_format !== undefined && body.output_format !== 'jpeg') {
            return json(400, {error: {message: '此网关的 Nano Banana 入口输出 JPEG。'}});
          }
          payload.response_format = {type: 'image', aspect_ratio: aspectRatio, image_size: '1K'};
        } else if (model.route === speech) {
          const voice = body.voice ?? 'Kore';
          if (typeof voice !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(voice) ||
              (body.response_format !== undefined && body.response_format !== 'wav')) {
            return json(400, {error: {message: '请选择 Gemini 音色，语音输出格式为 WAV。'}});
          }
          payload.response_format = {type: 'audio'};
          payload.generation_config = {speech_config: [{voice}]};
        } else if (body.response_format !== undefined && body.response_format !== 'mp3') {
          return json(400, {error: {message: '音乐输出格式为 MP3。'}});
        }
        const key = getGeminiKey(model.account);
        if (!key) return json(503, {error: {message: '所选 Google AI Studio 项目还没有配置 API Key。'}});
        upstream = await fetch(googleURL, {
          method: 'POST',
          headers: {'x-goog-api-key': key, 'Content-Type': 'application/json', 'Api-Revision': '2026-05-20'},
          body: JSON.stringify(payload), signal,
        });
      }
      const result = await upstream.json().catch(() => null);
      if (!upstream.ok) {
        const message = result?.error?.message?.replace(/sk-[\w-]+|AIza[\w-]+/g, '[redacted]');
        return json(upstream.status, {error: {message: message || '上游生成失败（HTTP ' + upstream.status + '）。'}});
      }
      const openAi = model.provider === 'openai';
      if (!preview && openAi && result) return json(upstream.status, result);
      const formats = model.route === image ? ['image/jpeg', 'image/png'] :
        model.route === speech ? ['audio/wav'] : ['audio/mpeg'];
      const media = openAi ? {mime_type: 'image/png', data: result?.data?.[0]?.b64_json} :
        result?.steps?.flatMap(step => step.content ?? []).find(part =>
          formats.includes(part.mime_type) && typeof part.data === 'string' && part.data);
      if (!media?.data) return json(502, {error: {message: '上游没有返回可用的图像或音频。'}});
      if (preview) return json(200, {mimeType: media.mime_type, data: media.data});
      if (model.route === image) {
        return json(200, {created: Math.floor(Date.now() / 1000), data: [{b64_json: media.data, mime_type: media.mime_type}]});
      }
      res.writeHead(200, {'Content-Type': media.mime_type, 'Cache-Control': 'no-store'});
      res.end(Buffer.from(media.data, 'base64'));
    } catch {
      if (!res.destroyed) {
        json(signal.aborted ? 504 : 502, {error: {message: signal.aborted ?
          '生成超时，请重试。' : '无法调用上游生成服务，请检查网络和项目配置。'}});
      }
    }
  };
}
