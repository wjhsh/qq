import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig } from '../../src/config.js';
import { registerVoiceTool } from '../../src/gemini-voice.mjs';

const SKILL_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEPLOY_DIR = path.resolve(SKILL_DIR, '../../..');
const DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural';
const VOICES = Object.freeze([DEFAULT_VOICE, 'zh-CN-YunxiNeural']);
export const MAX_AUDIO_BYTES = 5 * 1024 * 1024;
const SYNTHESIS_TIMEOUT_MS = 60_000;

const ERRORS = Object.freeze({
  missing_python: '语音运行环境尚未准备好，本次没有发送语音。',
  missing_dependency: '语音合成组件尚未准备好，本次没有发送语音。',
  missing_ffmpeg: '语音转换组件尚未准备好，本次没有发送语音。',
  invalid_request: '语音参数无效，本次没有发送语音。',
  timeout: '语音生成超时，已取消，本次没有发送语音。',
  audio_too_large: '生成的语音超过5MB，本次没有发送语音。',
  invalid_audio: '没有生成有效语音，本次没有发送语音。',
  ffmpeg_failed: '语音转换失败，本次没有发送语音。',
  tts_failed: '语音合成服务暂时不可用，本次没有发送语音。'
});

function voiceError(code) {
  const error = new Error(ERRORS[code] || ERRORS.tts_failed);
  error.code = code;
  return error;
}

function validateRequest(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)
      || Object.keys(args).some((key) => !['text','voice','finishAfterSend'].includes(key))
      || (args.finishAfterSend!==undefined&&typeof args.finishAfterSend!=='boolean')) {
    return { error: '只接受text和voice两个参数。' };
  }
  if (typeof args.text !== 'string' || !args.text.trim()) {
    return { error: '请提供要说的简短文字。' };
  }
  const text = args.text.trim();
  if (Array.from(text).length > 200) return { error: '语音内容最多200字，请缩短后再试。' };
  const voice = args.voice === undefined ? DEFAULT_VOICE : args.voice;
  if (!VOICES.includes(voice)) return { error: '音色只支持zh-CN-XiaoxiaoNeural或zh-CN-YunxiNeural。' };
  return { text, voice };
}

/** Collect only bounded WAV output; helper diagnostics never reach the model. */
export function collectSpeechOutput(child, { timeoutMs = SYNTHESIS_TIMEOUT_MS, maxBytes = MAX_AUDIO_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let size = 0;
    let diagnostics = '';
    const chunks = [];
    const finishError = (code, stop = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chunks.length = 0;
      if (stop) {
        try { child.kill('SIGKILL'); } catch { /* The helper may already have exited. */ }
      }
      reject(voiceError(code));
    };
    const timer = setTimeout(() => finishError('timeout', true), timeoutMs);
    child.stdout.on('data', (chunk) => {
      if (settled) return;
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += data.length;
      if (size > maxBytes) return finishError('audio_too_large', true);
      chunks.push(data);
    });
    child.stderr.on('data', (chunk) => {
      if (!settled && diagnostics.length < 8192) diagnostics += String(chunk).slice(0, 8192 - diagnostics.length);
    });
    child.once('error', () => finishError('missing_python'));
    child.once('close', (code) => {
      if (settled) return;
      if (code !== 0) {
        const reported = diagnostics.match(/VOICE_ERROR:([a-z_]+)/)?.[1];
        return finishError(Object.hasOwn(ERRORS, reported) ? reported : 'tts_failed');
      }
      settled = true;
      clearTimeout(timer);
      resolve(Buffer.concat(chunks, size));
    });
  });
}

async function synthesizeSpeech(request) {
  const python = String(process.env.PYTHON_SPEECH_EXECUTABLE
    || path.join(DEPLOY_DIR, 'voice-runtime', 'Scripts', 'python.exe')).trim();
  if (!path.isAbsolute(python)) throw voiceError('missing_python');
  try { await access(python); } catch { throw voiceError('missing_python'); }
  let child;
  try {
    child = spawn(python, [path.join(SKILL_DIR, 'speak.py')], {
      cwd: SKILL_DIR,
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' }
    });
  } catch { throw voiceError('missing_python'); }
  const output = collectSpeechOutput(child);
  // A failed helper can close stdin before its exit event; the exit code remains authoritative.
  child.stdin.on('error', () => {});
  child.stdin.end(JSON.stringify(request));
  return output;
}

function validateAudio(audio) {
  if (!Buffer.isBuffer(audio) || audio.length <= 44) throw voiceError('invalid_audio');
  if (audio.length > MAX_AUDIO_BYTES) throw voiceError('audio_too_large');
  if (audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE'
      || audio.readUInt32LE(4) + 8 !== audio.length) throw voiceError('invalid_audio');
  return audio;
}

/** Injection supports offline tests; callers exposed to the model only see text/voice. */
export function createVoiceTool({ synthesize = synthesizeSpeech } = {}) {
  return {
    id: 'send_voice',
    name: '说一句语音',
    description: '把最多200字的短句合成为语音发到当前聊天。用户要求语音或适合简短语音回应时使用；成功后不要重复发送同文。voice可选，晓晓为女声，云希为男声。',
    category: 'media',
    icon: '🎙️',
    defaultEnabled: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', minLength: 1, maxLength: 200, description: '要说出的自然中文短句，最多200字。' },
        voice: { type: 'string', enum: VOICES, description: '可选音色：zh-CN-XiaoxiaoNeural（女声，默认）或zh-CN-YunxiNeural（男声）。' }
      },
      required: ['text']
    },
    async execute(ctx, args) {
      const request = validateRequest(args);
      if (request.error) return { content: request.error, isError: true };
      if (!ctx?.sender || typeof ctx.sender.sendMedia !== 'function'
          || !/^(?:group|private):[1-9]\d*$/.test(String(ctx.chatKey || ''))) {
        return { content: '当前聊天暂时不能发送语音。', isError: true };
      }
      let audio;
      try { audio = validateAudio(await synthesize({ text: request.text, voice: request.voice })); }
      catch (error) {
        return { content: ERRORS[error?.code] || ERRORS.tts_failed, isError: true };
      }
      const label = '[语音] ' + request.text;
      const dedupeKey = createHash('sha256').update(request.text, 'utf8').digest('hex');
      let result;
      try {
        result = await ctx.sender.sendMedia(ctx.chatKey, [{ type: 'record', data: { file: 'base64://' + audio.toString('base64') } }], { label, dedupeKey });
      } catch {
        return { content: '语音发送未确认成功，请勿自动重发，以免重复。', isError: true };
      }
      // Mark a real send so the agent does not classify this turn as unanswered and retry.
      try {
        if (Array.isArray(ctx.session?.sent)) ctx.session.sent.push({ type: 'voice', text: label, at: new Date().toLocaleTimeString('zh-CN', { hour12: false }) });
        if (typeof ctx.emit === 'function' && ctx.session?.id) ctx.emit('session-update', ctx.session.id);
      } catch { /* UI bookkeeping must not turn a successful send into a retry. */ }
      return { content: JSON.stringify({ sent: true, messageId: result?.message_id ?? null, note: '语音已发送，不要重复发送相同文字。' }) };
    }
  };
}

export function setup(api) {
  if(getConfig().voice?.provider==='gemini')registerVoiceTool(api.registerTool,{getConfig});
  else api.registerTool(createVoiceTool());
}
