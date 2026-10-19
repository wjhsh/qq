// 图片压缩：把过大的图片缩到模型可接受的尺寸/体积，降低 token 成本与传输开销。
//
// 背景：QQ 图床的原图可能几 MB 甚至十几 MB，直接 base64 给模型既贵又慢，
// 很多视觉模型对超大图还会拒收或报错。这里在下载后、给模型前做一道压缩。
//
// 实现：项目没有图像处理库（无 sharp/jimp），用 ffmpeg（video-reader 已探测）做缩放。
//   - 有 ffmpeg：按最长边缩到 maxDim，并重编码为 JPEG（质量可调）
//   - GIF：先转最多九帧的 JPEG 联系图，让不接收 GIF 的视觉 API 也能看动态表情
//   - 无 ffmpeg：非 GIF 原样返回；GIF 明确报错，避免把不支持的格式发给模型
// 判断"是否过大"：优先按像素（需 ffprobe/ffmpeg 读尺寸），读不到尺寸时按字节数兜底。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { detectImageType, mimeToExt } from './image-type.js';
import { spawn } from 'node:child_process';

function run(cmd, args, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (val) => { if (!done) { done = true; resolve(val); } };
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch {
      return finish(null);
    }
    let timedOut = false;
    // 等待进程真正退出再返回，Windows 上才能可靠删除仍由 ffmpeg 打开的临时文件。
    const timer = setTimeout(() => { timedOut = true; try { child.kill(); } catch { finish(null); } }, timeoutMs);
    child.on('error', () => { clearTimeout(timer); finish(null); });
    child.on('close', (code) => { clearTimeout(timer); finish(!timedOut && code === 0 ? true : null); });
  });
}

let _ffmpeg = null;
let _ffprobe = null;
let _checked = false;
let _ffmpegCheck = null;
async function ensureFfmpeg() {
  // GIF 预览不依赖 ffprobe；同时收到多张图时共享同一次探测。
  if (!_ffmpegCheck) _ffmpegCheck = (async () => {
    for (const name of ['ffmpeg', 'ffmpeg.exe']) {
      if (await run(name, ['-version'], 5000)) { _ffmpeg = name; break; }
    }
    return _ffmpeg;
  })();
  return _ffmpegCheck;
}
async function ensureFf() {
  if (_checked) return { ffmpeg: _ffmpeg, ffprobe: _ffprobe };
  _checked = true;
  await ensureFfmpeg();
  for (const name of ['ffprobe', 'ffprobe.exe']) {
    if (await run(name, ['-version'], 5000)) { _ffprobe = name; break; }
  }
  return { ffmpeg: _ffmpeg, ffprobe: _ffprobe };
}

const GIF_SECONDS = 8;
const GIF_CELLS = 9;
const GIF_CELL_DIM = 384;

/** 只读 GIF 块结构/帧延时，不解压像素，也不需要 ffprobe。 */
function gifPreviewTiming(buffer) {
  const fail = () => { throw new Error('GIF 动图预览失败：文件结构不完整或没有可解码的帧。'); };
  if (buffer.length < 13) return fail();
  let at = 13;
  if (buffer[10] & 0x80) at += 3 * (2 ** ((buffer[10] & 7) + 1));
  let delayCs = 10;
  let seconds = 0;
  let frames = 0;
  const skipSubBlocks = () => {
    while (at < buffer.length) {
      const length = buffer[at++];
      if (!length) return;
      if (at + length > buffer.length) return fail();
      at += length;
    }
    return fail();
  };
  while (at < buffer.length && seconds < GIF_SECONDS) {
    const marker = buffer[at++];
    if (marker === 0x3b) break;
    if (marker === 0x21) {
      if (at >= buffer.length) return fail();
      const label = buffer[at++];
      if (label === 0xf9) {
        if (at + 6 > buffer.length || buffer[at] !== 4 || buffer[at + 5] !== 0) return fail();
        const rawDelay = buffer.readUInt16LE(at + 2);
        // ffmpeg 的 GIF 解码器把低于 2cs 的延时按默认 10cs 处理。
        delayCs = rawDelay >= 2 ? rawDelay : 10;
        at += 6;
      } else {
        skipSubBlocks();
      }
      continue;
    }
    if (marker !== 0x2c || at + 9 > buffer.length) return fail();
    const flags = buffer[at + 8];
    at += 9;
    if (flags & 0x80) at += 3 * (2 ** ((flags & 7) + 1));
    if (at >= buffer.length) return fail();
    at++; // LZW minimum code size.
    skipSubBlocks();
    frames++;
    seconds += delayCs / 100;
    delayCs = 10; // 图形控制扩展只作用于紧随其后的图像。
  }
  if (!frames || !seconds) return fail();
  return { frames: Math.min(GIF_CELLS, frames), seconds: Math.min(GIF_SECONDS, seconds) };
}

/** 最多取前八秒，按时间抽至多九帧，从左到右、从上到下排成 3×3 JPEG。 */
async function gifContactSheet(buffer, quality) {
  const timing = gifPreviewTiming(buffer);
  const ffmpeg = await ensureFfmpeg();
  if (!ffmpeg) throw new Error('GIF 动图预览不可用：未找到 ffmpeg，请配置本机媒体运行环境后重试。');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa_gif_preview_'));
  const tmpIn = path.join(tmpDir, 'input.gif');
  const tmpOut = path.join(tmpDir, 'preview.jpg');
  try {
    fs.writeFileSync(tmpIn, buffer);
    const filters = [
      `trim=duration=${GIF_SECONDS}`,
      'setpts=PTS-STARTPTS',
      `fps=${(timing.frames / timing.seconds).toFixed(6)}:start_time=0:round=up`,
      `scale=${GIF_CELL_DIM}:${GIF_CELL_DIM}:force_original_aspect_ratio=decrease`,
      'setsar=1',
      `pad=${GIF_CELL_DIM}:${GIF_CELL_DIM}:(ow-iw)/2:(oh-ih)/2:color=white`,
      `tile=3x3:nb_frames=${GIF_CELLS}:padding=0:margin=0:color=white`,
    ].join(',');
    const converted = await run(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-ignore_loop', '1', '-t', String(GIF_SECONDS), '-i', tmpIn,
      '-map', '0:v:0', '-an', '-sn', '-dn', '-vf', filters,
      '-frames:v', '1', '-q:v', String(quality), '-update', '1', tmpOut,
    ], 20000);
    if (!converted || !fs.existsSync(tmpOut)) {
      throw new Error('GIF 动图预览转换失败或超过 20 秒，请换一张表情后重试。');
    }
    const jpeg = fs.readFileSync(tmpOut);
    if (detectMime(jpeg) !== 'image/jpeg' || jpeg.length > 4 * 1024 * 1024) {
      throw new Error('GIF 动图预览输出异常，未向模型发送原始 GIF。');
    }
    // 即使 JPEG 比小 GIF 大也要使用它：这里是格式兼容转换，不是仅节省字节。
    return { buffer: jpeg, mime: 'image/jpeg', compressed: true, gifContactSheet: true };
  } finally {
    try { fs.unlinkSync(tmpIn); } catch { /* ignore */ }
    try { fs.unlinkSync(tmpOut); } catch { /* ignore */ }
    try { fs.rmdirSync(tmpDir); } catch { /* ignore */ }
  }
}

/** 用 ffprobe 读图片尺寸。 */
async function imageSize(ffprobe, filePath) {
  const out = await new Promise((resolve) => {
    let txt = '';
    let child;
    try {
      child = spawn(ffprobe, ['-v', 'quiet', '-print_format', 'json', '-show_streams', filePath], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch {
      return resolve(null);
    }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } resolve(null); }, 10000);
    child.stdout.on('data', (d) => { txt += d; });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const j = JSON.parse(txt);
        const s = (j.streams || []).find((x) => x.codec_type === 'video' || x.width);
        resolve(s && s.width ? { width: Number(s.width), height: Number(s.height) } : null);
      } catch {
        resolve(null);
      }
    });
  });
  return out;
}

/**
 * 压缩一张图片（如需要）。
 * @param {Buffer} buffer 原始图片字节
 * @param {object} [opts]
 * @param {number} [opts.maxDim=1568] 最长边上限（像素），超过则等比缩小
 * @param {number} [opts.maxBytes=4*1024*1024] 字节上限，超过则尝试压缩
 * @param {number} [opts.quality=4] JPEG 质量（ffmpeg -q:v，2 最好 31 最差，4 是不错的平衡）
 * @returns {Promise<{buffer: Buffer, mime: string, compressed: boolean, gifContactSheet?: boolean}>}
 * @throws GIF 无法转换时抛出可向用户展示的错误，非 GIF 保持原有回退行为。
 */
export async function compressImage(buffer, { maxDim = 1568, maxBytes = 4 * 1024 * 1024, quality = 4 } = {}) {
  const mime = detectMime(buffer) || 'image/jpeg';
  // 必须早于“小图直接过”：常见动态表情只有几 KB，仍可能不被视觉 API 接受。
  if (mime === 'image/gif') return gifContactSheet(buffer, quality);
  // 小图直接过（字节数就很小，没必要压缩）
  if (buffer.length <= Math.min(maxBytes, 512 * 1024)) {
    return { buffer, mime, compressed: false };
  }
  const { ffmpeg, ffprobe } = await ensureFf();
  if (!ffmpeg) {
    // 无 ffmpeg：无法压缩，原样返回（保持旧行为）
    return { buffer, mime, compressed: false };
  }
  // 写到临时文件 → ffmpeg 缩放 → 读回
  const tmpIn = path.join(os.tmpdir(), `qqa_img_in_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}${extOf(mime)}`);
  const tmpOut = path.join(os.tmpdir(), `qqa_img_out_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}.jpg`);
  try {
    fs.writeFileSync(tmpIn, buffer);
    // 判断是否超过最长边（有 ffprobe 才读得到；读不到就按字节数决定压不压）
    let needResize = buffer.length > maxBytes;
    if (ffprobe) {
      const size = await imageSize(ffprobe, tmpIn);
      if (size && (size.width > maxDim || size.height > maxDim)) needResize = true;
    }
    if (!needResize) return { buffer, mime, compressed: false };
    // ffmpeg：等比缩放到最长边 maxDim，重编码 JPEG
    const okRun = await run(ffmpeg, [
      '-y', '-i', tmpIn,
      '-vf', `scale='min(${maxDim},iw)':'min(${maxDim},ih)':force_original_aspect_ratio=decrease`,
      '-q:v', String(quality),
      tmpOut
    ], 25000);
    if (okRun && fs.existsSync(tmpOut)) {
      const compressed = fs.readFileSync(tmpOut);
      // 只有真的变小了才用压缩结果（否则保留原图）
      if (compressed.length && compressed.length < buffer.length) {
        return { buffer: compressed, mime: 'image/jpeg', compressed: true };
      }
    }
    return { buffer, mime, compressed: false };
  } catch {
    return { buffer, mime, compressed: false };
  } finally {
    try { fs.unlinkSync(tmpIn); } catch { /* ignore */ }
    try { fs.unlinkSync(tmpOut); } catch { /* ignore */ }
  }
}

// 类型嗅探与 MIME→扩展名统一放在 image-type.js（曾经这里/tools.js/sticker-manager.js
// 各有一份实现，容易各自演化出不一致的行为）。
function detectMime(buf) {
  return detectImageType(buf)?.mime ?? null;
}

function extOf(mime) {
  return mimeToExt(mime);
}
