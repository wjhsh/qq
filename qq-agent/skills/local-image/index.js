import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { DATA_DIR, getConfig as readConfig } from '../../src/config.js';
import { detectImageType } from '../../src/image-type.js';
import { createCodexImageClient } from './codex-image-client.js';
import { referenceEntries, referencesStillPresent, loadReferenceImages } from './image-inputs.js';

export const DEFAULT_IMAGE_MODEL = 'gemini-3.1-flash-image';
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const ASPECT_RATIOS = Object.freeze(['1:1', '16:9', '9:16', '4:3', '3:4']);
const DEPLOY_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const KEY_FILE = path.join(DEPLOY_DIR, 'cliproxy', 'client-key');
const IMAGE_DIR = path.join(DATA_DIR, 'generated-images');
const ERRORS = Object.freeze({
  unavailable: '本机生图服务暂时不可用，本次未确认生成成功，请勿自动重试。',
  auth: '生图登录或本机凭证已失效，需要管理员检查连接。',
  verification_required: 'Chat服务端实际要求验证，本次未确认生图成功。请管理员检查该任务；不会自动重试或切换Codex。',
  native_disabled: '主人已关闭Codex原生生图，避免消耗Codex额度。GPT、ChatGPT和Chat生图要求统一走Chat聊天渠道。',
  quota: '生图额度不足或服务正在限流，请稍后重新发出要求；本次不会自动重试。',
  blocked: '图片服务因内容安全检查拦截了本次生成，没有返回可发送的图片。请调整描述后另发要求；不会自动重试。',
  no_image: '图片服务没有返回可用图片，本次没有发图，请勿自动重试。',
  invalid_image: '图片服务返回的数据不是有效图片，本次没有发图。',
  too_large: '生成的图片或响应过大，本次没有发图。',
  invalid_response: '图片服务返回格式异常，本次没有发图，请勿自动重试。',
  timeout: '生图等待超时，结果未确认，请勿自动重试，以免重复消耗额度。',
  aborted: '本次生图已中止，不会继续发送图片。',
  busy: '服务器正在处理其他任务，本次生图已取消排队，请稍后另发要求。',
  conversation_pending: '这个Chat生图对话的上一轮仍未结束，请等它结束后再发新要求；本次没有提交生图。',
  reference_image: '参考图片获取或校验失败。请把静态PNG/JPG/WebP图片与要求一起发送，或引用图片后重新发出要求；最多4张、单张5MiB、合计8MiB，本次未确认生成成功。',
  storage: '生图本地记录或图片无法保存，本次不会自动重试。'
});

function imageError(code) {
  const error = new Error(ERRORS[code] || ERRORS.unavailable);
  error.code = code;
  return error;
}

function validateImage(buffer, claimedMime) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) throw imageError('invalid_image');
  if (buffer.length > MAX_IMAGE_BYTES) throw imageError('too_large');
  const type = detectImageType(buffer);
  const mime = String(claimedMime || '').toLowerCase().replace('image/jpg', 'image/jpeg');
  if (!type || !['image/png', 'image/jpeg', 'image/webp'].includes(type.mime) || (mime && mime !== type.mime)) throw imageError('invalid_image');
  if (type.mime === 'image/png' && (buffer.length < 57
      || !buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
      || buffer.readUInt32BE(8) !== 13 || buffer.toString('ascii', 12, 16) !== 'IHDR'
      || buffer.readUInt32BE(16) < 1 || buffer.readUInt32BE(20) < 1
      || buffer.readUInt32BE(16) > 16384 || buffer.readUInt32BE(20) > 16384
      || buffer.toString('ascii', buffer.length - 8, buffer.length - 4) !== 'IEND')) throw imageError('invalid_image');
  if (type.mime === 'image/jpeg' && (buffer.at(-2) !== 255 || buffer.at(-1) !== 217)) throw imageError('invalid_image');
  if (type.mime === 'image/webp' && buffer.readUInt32LE(4) + 8 !== buffer.length) throw imageError('invalid_image');
  return { buffer, ...type, model: DEFAULT_IMAGE_MODEL };
}

export function extractGeminiImage(payload) {
  const data = payload?.response && typeof payload.response === 'object' ? payload.response : payload;
  if (data?.promptFeedback?.blockReason && data.promptFeedback.blockReason !== 'BLOCK_REASON_UNSPECIFIED') throw imageError('blocked');
  const candidates = Array.isArray(data?.candidates) ? data.candidates.slice(0, 8) : [];
  for (const candidate of candidates) {
    if (['SAFETY', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'IMAGE_SAFETY', 'RECITATION'].includes(candidate?.finishReason)) throw imageError('blocked');
    for (const part of (Array.isArray(candidate?.content?.parts) ? candidate.content.parts : []).slice(0, 100)) {
      if (part?.thought === true) continue;
      const inline = part?.inlineData ?? part?.inline_data;
      if (!inline) continue;
      const encoded = inline.data;
      if (typeof encoded !== 'string' || !encoded.length || encoded.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4) throw imageError(encoded?.length ? 'too_large' : 'invalid_image');
      if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw imageError('invalid_image');
      return validateImage(Buffer.from(encoded, 'base64'), inline.mimeType ?? inline.mime_type);
    }
  }
  throw imageError('no_image');
}

async function boundedJson(response, maxBytes) {
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel();
    throw imageError('too_large');
  }
  if (!response.body) throw imageError('invalid_response');
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        throw imageError('too_large');
      }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks, length).toString('utf8')); }
  catch { throw imageError('invalid_response'); }
}

export function createGeminiImageClient({ fetchImpl = globalThis.fetch,
  readKey = () => fs.readFileSync(KEY_FILE, 'utf8').trim(),
  baseUrl = 'http://127.0.0.1:8317', timeoutMs = 180000, maxResponseBytes = 20 * 1024 * 1024 } = {}) {
  const endpoint = new URL(baseUrl);
  if (!['http:', 'https:'].includes(endpoint.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)
      || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !['', '/'].includes(endpoint.pathname)) throw new Error('Image gateway must be local');
  return async ({ prompt, inputImages = [], aspectRatio = '1:1', signal } = {}) => {
    if (signal?.aborted) throw imageError('aborted');
    if (typeof prompt !== 'string' || !prompt.trim() || Array.from(prompt).length > 2000 || !ASPECT_RATIOS.includes(aspectRatio)) throw imageError('invalid_response');
    if (!Array.isArray(inputImages) || inputImages.length > 4 || inputImages.reduce((n,image) => n+(image?.buffer?.length||0),0)>8*1024*1024
      || inputImages.some(image=>!Buffer.isBuffer(image?.buffer)||!image.buffer.length||image.buffer.length>5*1024*1024||!['image/png','image/jpeg','image/webp'].includes(image.mime))) throw imageError('reference_image');
    let key;
    try { key = String(await readKey()).trim(); } catch { throw imageError('auth'); }
    if (!key || key.length > 4096 || /[\r\n]/.test(key)) throw imageError('auth');
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    try {
      const response = await fetchImpl(new URL(`/v1beta/models/${DEFAULT_IMAGE_MODEL}:generateContent`, endpoint), {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt.trim() }, ...inputImages.map(image=>({inlineData:{mimeType:image.mime,data:image.buffer.toString('base64')}}))] }],
          generationConfig: { candidateCount: 1, responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio } }
        })
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw imageError(response.status === 429 ? 'quota' : [401,403].includes(response.status) ? 'auth' : 'unavailable');
      }
      return extractGeminiImage(await boundedJson(response, maxResponseBytes));
    } catch (error) {
      if (signal?.aborted) throw imageError('aborted');
      if (timedOut) throw imageError('timeout');
      if (Object.hasOwn(ERRORS, error?.code)) throw imageError(error.code);
      throw imageError('unavailable');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
    }
  };
}

function directRequest(text) {
  if (typeof text !== 'string' || text.length > 12000) return false;
  const value = text.trim().replace(/^那(?:你)?\s*/u,'').replace(/^((?:(?:哈基米|小猫|机器人)[，,:：\s]*)?)(?:(?:请|帮我|给我)\s*)?(?:用|使用)\s*(?:chatgpt|chat(?:模式)?|codex|gpt|openai|gemini|nano\s*banana(?:\s*2)?)\s*(?:来)?/iu,'$1');
  const command = /^\/生图\s+/u.test(value);
  const body = command ? originalImagePrompt(value) : value;
  if (!body) return false;
  if (command) {
    if (/^(?:(?:请|麻烦)\s*)?(?:不要|别|不用|不必|先不|暂不|取消|停止)/u.test(body)) return false;
    return !/^(?:帮助|用法|教程|怎么用|如何使用)(?:$|[，。？?\s])/u.test(body);
  }
  const actionAt = body.search(/(?:画|生图|生成|绘制)/u);
  const negativeAt = body.search(/(?:不要|别|不用|不必|先不|暂不|取消|停止)/u);
  // A leading cancellation blocks the action; visual constraints after an
  // explicit request ("画猫，不要画狗") do not cancel the whole request.
  if (negativeAt >= 0 && (actionAt < 0 || negativeAt < actionAt)) return false;
  if (/(?:需要多少钱|要多少钱|怎么收费|收费吗|费用|价格|生图额度|要等多久|要多久|需要多久|多长时间|耗时|怎么用|如何使用|使用方法|用法|教程)/u.test(value)) return false;
  if (/^(?:(?:你|它|这个|哈基米|gemini|机器人)[，,:：\s]*)?(?:(?:能不能|可不可以|会不会|是否|能|会|可以|支持)\s*)?(?:生图|画图|绘图|生成图片)(?:功能)?(?:吗|么|不|[？?。!！\s])*$/iu.test(value)) return false;
  if (/^(?:please\s+)?(?:draw|paint)\s+\S|^(?:please\s+)?(?:generate|create)\s+(?:an?\s+)?(?:image|picture|illustration|portrait)\s+(?:of|showing|with)\s+\S/iu.test(value)) return true;
  return /^(?:(?:哈基米|gemini|机器人|小猫)[，,:：\s]*)?(?:(?:请你|请|麻烦|能不能|可以|能|帮我|给我|替我|帮忙|你|我想让你|我想要你)\s*)*(?:画(?:一|个|张|幅|只|些|下)|画图[ :：]|生图[ :：]|绘制|生成[^，。！？?\n]{0,24}(?:图片|图像|插画|头像|壁纸|海报|流程图|一张图)|做(?:一张|个).{0,20}(?:图|头像|壁纸))/iu.test(value);
}

function chatAllowed(ctx, cfg, entry = null) {
  const match = /^(group|private):([1-9]\d{0,14})$/u.exec(String(ctx?.chatKey || ''));
  if (!match || (ctx.kind && ctx.kind !== match[1]) || (ctx.chatId && String(ctx.chatId) !== match[2]) || cfg?.skills?.['local-image']?.enabled === false) return false;
  const [, kind, id] = match;
  const has = (list, value) => Array.isArray(list) && list.map(String).includes(String(value));
  const allow = cfg?.allow?.[kind] ?? cfg?.allow?.[`${kind}s`] ?? [];
  const deny = cfg?.deny?.[kind] ?? cfg?.deny?.[`${kind}s`] ?? [];
  if (has(deny, id) || (allow.length ? !has(allow, id) : cfg?.allowAllWhenEmpty !== true)) return false;
  if (entry && (has(cfg?.globalBlocklist, entry.senderId) && !has(cfg?.communityExemptions, entry.senderId)
      || kind === 'group' && has(cfg?.blocklist?.[id], entry.senderId))) return false;
  return true;
}

function requestEntry(ctx, cfg) {
  return [...(Array.isArray(ctx?.triggerEntries) ? ctx.triggerEntries : [])].reverse().find((entry) => {
    if (!entry || entry.self || entry.isPoke || entry.recalled || entry.withdrawn || entry.deleted
        || !/^[1-9]\d{0,14}$/u.test(String(entry.senderId || '')) || String(entry.senderId) === String(ctx.selfId || '')
        || !chatAllowed(ctx, cfg, entry)) return false;
    const text=String(entry.directText || '').trim();
    const editAt=text.search(/改成|改为|换成|换为|变成|添加|加上|去掉|移除|删除|重绘|重画|修图|图生图|调整|扩图|抠图|换背景/u);
    const cancelAt=text.search(/不要|不用|不必|取消|先别|别改|先不|停止/u);
    const edit = referenceEntries(ctx, entry).length > 0 && (cancelAt<0||cancelAt>editAt)
      && /^(?:(?:请|麻烦|帮我|给我|替我)\s*)*(?:(?:把|将).{0,80}?)?(?:改成|改为|换成|换为|变成|添加|加上|去掉|移除|删除|重绘|重画|修图|图生图|调整|扩图|抠图|换背景)/u.test(text);
    if (!directRequest(entry.directText) && !edit) return false;
    if (ctx.chatKey.startsWith('private:') && ctx.chatKey !== `private:${entry.senderId}`) return false;
    return !ctx.chatKey.startsWith('group:') || entry.atMe === true || /^\/生图\s+\S/u.test(entry.directText.trim());
  });
}

function requestStillPresent(ctx, entry) {
  const live = entry.mid !== null && entry.mid !== undefined && typeof ctx?.store?.findByMid === 'function'
    ? ctx.store.findByMid(ctx.chatKey, entry.mid) : entry;
  return Boolean(live && !entry.recalled && !entry.withdrawn && !entry.deleted
    && !live.recalled && !live.withdrawn && !live.deleted);
}

export function originalImagePrompt(text) {
  // Remove transport commands only. The language model's prompt argument must
  // never replace, expand, translate or summarize the user's actual message.
  let value = String(text || '').trim();
  if (/^\/生图\s+/u.test(value)) {
    value = value.replace(/^\/生图\s+/u, '');
    value = value.replace(/^(?:chatgpt|chat(?:模式)?|codex|gpt|openai|gemini|nano\s*banana(?:\s*2)?)\s+/iu, '');
  }
  return value.trim();
}

export class ImageRequestLedger {
  constructor(file = path.join(DATA_DIR, 'image-generation-state.json')) {
    this.file = file;
    this.entries = new Map();
    if (fs.existsSync(file)) {
      try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
        if (!Array.isArray(data)) throw new Error();
        this.entries = new Map(data.slice(-500));
      } catch { throw imageError('storage'); }
    }
  }
  get(key) { return this.entries.get(key); }
  set(key, value) {
    this.entries.set(key, value);
    while (this.entries.size > 500) this.entries.delete(this.entries.keys().next().value);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = this.file + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify([...this.entries]), { mode: 0o600 });
    fs.renameSync(temporary, this.file);
    return this;
  }
}

async function saveGeneratedImage(image, requestKey) {
  const filename = createHash('sha256').update(requestKey).digest('hex') + image.ext;
  fs.mkdirSync(IMAGE_DIR, { recursive: true });
  const file = path.join(IMAGE_DIR, filename);
  fs.writeFileSync(file, image.buffer, { flag: 'wx', mode: 0o600 });
  return file;
}

export function createImageTool({ generate = createGeminiImageClient(), generateGpt = createCodexImageClient(), generateChat = createCodexImageClient({engine:'chatgpt'}), getConfig = readConfig,
  saveImage = saveGeneratedImage, loadReferences = loadReferenceImages, ledger = null, now = Date.now, cooldownMs = 30000 } = {}) {
  let busy = false;
  const lastStarted = new Map();
  const result = (content) => ({ content, isError: true });
  return {
    id: 'generate_image', name: '画一张图（Gemini / GPT / Chat）', category: 'media', icon: '🎨', defaultEnabled: true,
    description: '用户明确要求画图或改图时使用，群聊应艾特。宿主从原消息直接提取提示词，不采用模型改写。图生图自动附上本条或明确引用消息的图片，也兼容QQ将同一人5秒内紧邻的图片和要求拆成两条；禁止挑选其他历史图片或编造图片URL。GPT、ChatGPT、OpenAI、Chat统一选chat；同一聊天同一发言者复用独立生图对话。Gemini/Nano Banana走gemini；未指定渠道沿用默认渠道。最多4张参考图，仅发送一张结果。失败不重试、不换渠道，Codex原生生图已关闭。',
    parameters: { type: 'object', additionalProperties: false,
      properties: {
        prompt: { type: 'string', minLength: 1, maxLength: 2000, description: '复制用户原话，禁止补充、扩写或翻译。宿主始终以原消息为准；最多2000字。' },
        aspectRatio: { type: 'string', enum: ASPECT_RATIOS, description: '图片比例，默认1:1。' },
        provider: { type: 'string', enum: ['gemini','gpt','chat'], description: 'GPT、ChatGPT、OpenAI、Chat填chat。gpt旧值保留兼容，Codex原生生图已关闭。宿主依据原始发言校验。' }
      }, required: ['prompt'] },
    async execute(ctx, args) {
      if (!args || typeof args !== 'object' || Array.isArray(args)
          || Object.keys(args).some((key) => !['prompt','aspectRatio','provider'].includes(key))
          || typeof args.prompt !== 'string' || !args.prompt.trim() || Array.from(args.prompt).length > 2000
          || !ASPECT_RATIOS.includes(args.aspectRatio ?? '1:1') || (args.provider!==undefined&&!['gemini','gpt','chat'].includes(args.provider))) return result('生图参数无效，请提供最多2000字的prompt和可选的图片比例。');
      if (ctx?.signal?.aborted) return result(ERRORS.aborted);
      if (typeof ctx?.sender?.sendMedia !== 'function' || !chatAllowed(ctx, getConfig())) return result('当前会话没有生图权限。');
      const entry = requestEntry(ctx, getConfig());
      if (!entry) return result('未收到当前发言者明确的生图要求。请私聊发送“/生图 内容”，或群内艾特我后要求画图。');
      const prompt = originalImagePrompt(entry.directText);
      if (!prompt || Array.from(prompt).length > 2000) return result('原始生图描述需为1至2000字，不会用模型缩写替换。');
      const references = referenceEntries(ctx, entry);
      const choice=/^\/生图\s+(chatgpt|chat(?:模式)?|codex|gpt|openai|gemini|nano\s*banana(?:\s*2)?)\s+/iu.exec(entry.directText.trim())
        || /(?:用|使用)\s*(chatgpt|chat(?:模式)?|codex|gpt|openai|gemini|nano\s*banana(?:\s*2)?)(?=\s|画|来|绘|生|$)/iu.exec(entry.directText);
      const provider=choice?(/^codex$/iu.test(choice[1])?'gpt':/^(?:chat(?:模式)?|gpt|chatgpt|openai)$/iu.test(choice[1])?'chat':'gemini')
        :references.length>0||['gpt','chat'].includes(getConfig()?.skills?.['local-image']?.provider)?'chat':'gemini';
      if(provider==='gpt')return result(ERRORS.native_disabled);
      if (!requestStillPresent(ctx, entry)) return result('原生图要求已撤回，本次不会生成。');
      const sourceId = entry.mid ?? entry.id;
      if (sourceId === null || sourceId === undefined || !/^-?\d{1,20}$/u.test(String(sourceId))) return result('无法确认生图请求的原消息，本次不会生成。');
      const requestKey = `${ctx.chatKey}:${entry.senderId}:${entry.mid !== null && entry.mid !== undefined ? 'mid' : 'id'}:${sourceId}`;
      const imageSessionKey = createHash('sha256').update(`qq-chat-image-v1:${ctx.chatKey}:${entry.senderId}`).digest('hex').slice(0, 32);
      try { ledger ??= new ImageRequestLedger(); } catch { return result(ERRORS.storage); }
      if (ledger.get(requestKey)) return result('这条消息的生图请求已经处理过或结果尚未确认，不会重复生成；需要新图请另发一条要求。');
      if (busy) return result('正在处理另一张图片，请等它完成后再重新发送要求。');
      const timestamp = now();
      if (lastStarted.has(ctx.chatKey) && timestamp - lastStarted.get(ctx.chatKey) < cooldownMs) return result('这个会话刚刚请求过生图，请间隔30秒后再发送新要求。');
      busy = true;
      let sent = false;
      let stage = 'started';
      let savedFile = null;
      let jobId = null;
      let referenceCount = 0;
      const model=provider==='chat'?'chatgpt-chat-image':provider==='gpt'?'gpt-image-2':DEFAULT_IMAGE_MODEL;
      const remember = (status, extra = {}) => ledger.set(requestKey, { status, at: now(), provider, model, stage,
        promptSource: 'original_message', promptSha256: createHash('sha256').update(prompt).digest('hex'),
        referenceCount,
        ...(jobId?{jobId}:{}), ...extra });
      try {
        // Persist before the paid request: an interrupted or hot-reloaded skill
        // must not generate again for the same QQ message.
        remember('started');
        lastStarted.set(ctx.chatKey, timestamp);
        const inputImages = await loadReferences(ctx, references);
        referenceCount = inputImages.length;
        if (!requestStillPresent(ctx, entry) || !referencesStillPresent(ctx, references)) { remember('cancelled'); return result('生图要求或参考图片已撤回，本次不提交生成。'); }
        if (!chatAllowed(ctx, getConfig(), entry)) return result('当前会话生图权限已变更，本次不提交生成。');
        remember('started', { referenceCount: inputImages.length });
        const image = await (provider==='chat'?generateChat:provider==='gpt'?generateGpt:generate)({ prompt, inputImages, aspectRatio: args.aspectRatio ?? '1:1', requestKey, ...(provider==='chat'?{imageSessionKey}:{}), signal: ctx.signal });
        if(/^[a-f0-9]{12}$/.test(image?.jobId||''))jobId=image.jobId;
        if (ctx.signal?.aborted) throw imageError('aborted');
        if (!requestStillPresent(ctx, entry) || !referencesStillPresent(ctx, references)) { remember('cancelled'); return result('生图要求或参考图片已撤回，图片不会发送。'); }
        const verified = validateImage(image?.buffer, image?.mime);
        verified.model=model;
        stage = 'generated';
        if (!chatAllowed(ctx, getConfig(), entry)) return result('生图期间会话权限已变更，图片不会发送。');
        let file;
        try { file = await saveImage(verified, requestKey); } catch { throw imageError('storage'); }
        if (typeof file !== 'string' || !path.isAbsolute(file)) throw imageError('storage');
        savedFile = file;
        remember('generated', { file });
        if (ctx.signal?.aborted) throw imageError('aborted');
        if (!requestStillPresent(ctx, entry) || !referencesStillPresent(ctx, references)) { remember('cancelled', { file }); return result('生图要求或参考图片已撤回，图片不会发送。'); }
        if (!chatAllowed(ctx, getConfig(), entry)) return result('生图期间会话权限已变更，图片不会发送。');
        stage = 'sending';
        const segments = [];
        if (entry.mid !== null && entry.mid !== undefined) segments.push({ type: 'reply', data: { id: String(entry.mid) } });
        // QQ runs in a separate container and cannot read this host path.
        // Inline the validated bytes on the first and only send attempt.
        segments.push({ type: 'image', data: { file: 'base64://' + verified.buffer.toString('base64') } });
        // A missing receipt never causes a retry or a second generation.
        const send = await ctx.sender.sendMedia(ctx.chatKey, segments, {
          label: '[AI生图] ' + prompt.slice(0, 160),
          dedupeKey: 'ai-image:' + requestKey
        });
        if (!/^-?[1-9][0-9]*$/u.test(String(send?.message_id ?? ''))) throw new Error('missing_image_receipt');
        sent = true;
        try { remember('sent', { file, messageId: send?.message_id ?? null }); } catch { /* started already prevents regeneration */ }
        try {
          if (Array.isArray(ctx.session?.sent)) ctx.session.sent.push({ type: 'image', text: '[AI生图]', at: new Date().toLocaleTimeString('zh-CN', { hour12: false }) });
          if (typeof ctx.emit === 'function' && ctx.session?.id) ctx.emit('session-update', ctx.session.id);
        } catch { /* A successful QQ send must remain successful. */ }
        return { content: JSON.stringify({ sent: true, messageId: send?.message_id ?? null, model: verified.model, provider, note: '生成图片已发送，不要重复发送图片或提示词。' }) };
      } catch (error) {
        if(/^[a-f0-9]{12}$/.test(error?.jobId||''))jobId=error.jobId;
        // Persist a bounded diagnostic code, never a raw provider response,
        // token, prompt, signed URL or arbitrary exception message.
        const code=stage==='sending'?'send_uncertain':Object.hasOwn(ERRORS,error?.code)?error.code:'unavailable';
        if (!sent) { try { remember(stage === 'sending' ? 'send-uncertain' : 'failed', {code,...(savedFile ? { file: savedFile } : {})}); } catch { /* Never retry if a receipt is uncertain. */ } }
        return result(stage === 'sending' ? '图片已生成，但QQ发送结果未确认，请勿自动重发或重新生成，以免重复。'
          : ERRORS[error?.code] || ERRORS.unavailable);
      } finally { busy = false; }
    }
  };
}

export function available() {
  return fs.existsSync(KEY_FILE)||fs.existsSync('/etc/qq-harness/qq-token') ? { ok: true } : { ok: false, reason: '未找到本机生图服务凭证。' };
}

export function setup(api) {
  api.registerTool(createImageTool({ generate: createGeminiImageClient({ fetchImpl: api.fetch }) }));
}
