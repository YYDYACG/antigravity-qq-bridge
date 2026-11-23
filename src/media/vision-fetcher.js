import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function detectImageMime(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  // PNG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { mimeType: 'image/png', ext: '.png' };
  }
  // JPEG
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { mimeType: 'image/jpeg', ext: '.jpg' };
  }
  // GIF
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) {
    return { mimeType: 'image/gif', ext: '.gif' };
  }
  // WebP: RIFF....WEBP
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    return { mimeType: 'image/webp', ext: '.webp' };
  }
  return null;
}

function evenlySpacedIndices(totalFrames, count) {
  if (count <= 1 || totalFrames <= 1) return [0];
  if (count >= totalFrames) {
    return Array.from({ length: totalFrames }, (_, i) => i);
  }
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const idx = Math.round((i * (totalFrames - 1)) / (count - 1));
    if (!out.length || idx > out[out.length - 1]) {
      out.push(idx);
    } else {
      out.push(Math.min(totalFrames - 1, out[out.length - 1] + 1));
    }
  }
  return [...new Set(out)];
}

export function selectStoryboardLayout(frameCount, { maxFrames = 6 } = {}) {
  const total = Math.floor(Number(frameCount) || 0);
  if (total <= 1) return null;
  const cap = Math.max(2, Math.min(6, Math.floor(Number(maxFrames) || 6)));

  let cols = 3;
  let rows = 2;
  let targetCount = 6;

  if (total === 2 || cap === 2) {
    cols = 2;
    rows = 1;
    targetCount = 2;
  } else if (total === 3 || cap === 3) {
    cols = 3;
    rows = 1;
    targetCount = 3;
  } else if (total <= 5 || cap <= 5) {
    cols = 2;
    rows = 2;
    targetCount = 4;
  } else {
    cols = 3;
    rows = 2;
    targetCount = 6;
  }

  const indices = evenlySpacedIndices(total, targetCount);
  return {
    cols,
    rows,
    layout: `${cols}x${rows}`,
    indices,
    sampledFrames: indices.length
  };
}

export function computeTileDimensions(srcW, srcH, cols = 3, { maxTileSide } = {}) {
  const w = Math.max(1, Number(srcW) || 320);
  const h = Math.max(1, Number(srcH) || 320);
  const baseMax = Number(maxTileSide) || (cols <= 2 ? 360 : 320);
  const effectiveMax = cols <= 2 ? Math.max(baseMax, 320) : baseMax;
  const maxDim = Math.max(w, h);
  // Keep clarity without over-upscaling tiny icons past 2x
  const scale = Math.min(effectiveMax / maxDim, 2.0);
  const tw = Math.max(2, Math.round((w * scale) / 2) * 2);
  const th = Math.max(2, Math.round((h * scale) / 2) * 2);
  return { width: tw, height: th };
}

export function resolveFfprobePath(ffmpegPath = 'ffmpeg') {
  const raw = String(ffmpegPath || '').trim();
  if (!raw || raw.toLowerCase() === 'ffmpeg' || raw.toLowerCase() === 'ffmpeg.exe') {
    return process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';
  }
  const dir = path.dirname(raw);
  const ext = path.extname(raw);
  const candidate = path.join(dir, `ffprobe${ext}`);
  if (fs.existsSync(candidate)) return candidate;
  return process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';
}

function resolveDrawtextFontArg() {
  const candidates =
    process.platform === 'win32'
      ? [
          'C:\\Windows\\Fonts\\arialbd.ttf',
          'C:\\Windows\\Fonts\\arial.ttf',
          'C:\\Windows\\Fonts\\segoeui.ttf'
        ]
      : [
          '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
          '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf'
        ];
  for (const fp of candidates) {
    if (fs.existsSync(fp)) {
      const escaped = fp.replace(/\\/g, '/').replace(/:/g, '\\:');
      return `fontfile='${escaped}':`;
    }
  }
  return '';
}

export function extractLocalGifPaths(text, { maxCount = 2, maxBytes = 8 * 1024 * 1024 } = {}) {
  const s = String(text || '');
  if (!s || !/\.gif\b/i.test(s)) return [];
  const rawMatches = [];
  // 1. Quoted paths (allows spaces in filenames/folders)
  const quotedRe = /["'“‘]([A-Za-z]:[\\/][^"'”’\r\n]+?\.gif)["'”’]/gi;
  let m;
  while ((m = quotedRe.exec(s)) !== null) {
    rawMatches.push(m[1]);
  }
  // 2. Unquoted Windows paths without whitespace
  const bareRe = /(?:^|[\s(（[【])([A-Za-z]:[\\/][^\s"'<>|*?()（）[\]【】]+?\.gif)(?=$|[\s)）\]】,.，。！？!?])/gi;
  while ((m = bareRe.exec(s)) !== null) {
    rawMatches.push(m[1]);
  }

  const seen = new Set();
  const valid = [];
  for (const cand of rawMatches) {
    const cleaned = cand.trim();
    if (!cleaned) continue;
    const norm = path.normalize(cleaned);
    const key = process.platform === 'win32' ? norm.toLowerCase() : norm;
    if (seen.has(key)) continue;
    try {
      if (!fs.existsSync(norm)) continue;
      const st = fs.statSync(norm);
      if (!st.isFile() || st.size <= 0 || st.size > maxBytes) continue;
      seen.add(key);
      valid.push(norm);
      if (valid.length >= maxCount) break;
    } catch {
      // ignore inaccessible paths
    }
  }
  return valid;
}

export function buildAnimatedStoryboardHint(preparedImages = []) {
  if (!Array.isArray(preparedImages) || !preparedImages.length) return '';
  const animated = preparedImages
    .map((img, idx) => ({ img, idx: idx + 1 }))
    .filter(({ img }) => img?.animation?.isAnimated);
  if (!animated.length) return '';

  const singleImg = preparedImages.length === 1;
  const lines = animated.map(({ img, idx }) => {
    const a = img.animation;
    const durPart = a.durationSec > 0 ? `，约 ${a.durationSec.toFixed(1)} 秒` : '';
    const prefix = singleImg ? '附图' : `第 ${idx} 张附图`;
    const localTag = img.isLocalGifPreview ? '（来自主人发来的本地 GIF 路径）' : '';
    return `- ${prefix}${localTag}为动态 GIF 的时序分镜连环画（原图共 ${a.frameCount} 帧${durPart}，按 ${a.cols}×${a.rows} 网格均匀截取 ${a.sampledFrames} 个关键帧，左上角标号 1→${a.sampledFrames} 代表从开始到结束的时间顺序）。`;
  });

  return [
    '[动图时序分镜说明]',
    ...lines,
    '请务必按从左到右、从上到下（1→尾帧）的顺序看完整套动作演变、表情反转或字幕变化，切忌只看第 1 帧就下结论。',
    '[/动图时序分镜说明]'
  ].join('\n');
}

function isSafeImageUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    // Block cloud metadata & loopback SSRF targets
    if (host === '169.254.169.254' || host === 'metadata.google.internal') return false;
    return true;
  } catch {
    return false;
  }
}

export class VisionFetcher {
  constructor(configStore, rootDir) {
    this.configStore = configStore;
    this.tmpDir = path.join(rootDir, 'data', 'media-tmp');
    fs.mkdirSync(this.tmpDir, { recursive: true });
  }

  async fetchImageBuffer(imgMeta, onebotClient = null) {
    const cfg = this.configStore.get().vision;
    const maxBytes = cfg.maxImageBytes || 8 * 1024 * 1024;
    let url = String(imgMeta?.url || '').trim();
    const fileRef = String(imgMeta?.file || '').trim();

    // Base64 direct payload (e.g. Hub simulator upload)
    if (imgMeta?.base64) {
      const buf = Buffer.from(imgMeta.base64, 'base64');
      if (buf.length > maxBytes) throw new Error('图片超过大小限制');
      return this._finalizeBuffer(buf, imgMeta);
    }

    // Local file path if present directly
    if (!url && fileRef && fs.existsSync(fileRef)) {
      const stat = fs.statSync(fileRef);
      if (stat.size > maxBytes) throw new Error('本地图片超过大小限制');
      return this._finalizeBuffer(fs.readFileSync(fileRef), imgMeta);
    }

    // Fallback: ask OneBot get_image if only file id is provided
    if (!url && fileRef && onebotClient) {
      try {
        const res = await onebotClient.getImage(fileRef);
        if (res?.url) url = res.url;
        else if (res?.file && fs.existsSync(res.file)) {
          return this._finalizeBuffer(fs.readFileSync(res.file), imgMeta);
        }
      } catch {
        // fallback failed
      }
    }

    if (!url || !isSafeImageUrl(url)) {
      throw new Error(`无效或不允许的图片地址: ${url || fileRef}`);
    }

    const resp = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AntigravityQQBridge/1.0'
      }
    });
    if (!resp.ok) {
      throw new Error(`图片下载失败 HTTP ${resp.status}`);
    }
    const contentLen = Number(resp.headers.get('content-length') || 0);
    if (contentLen > maxBytes) {
      throw new Error(`图片体积过大 (${Math.round(contentLen / 1024 / 1024)}MB)`);
    }

    const arrayBuf = await resp.arrayBuffer();
    const buf = Buffer.from(arrayBuf);
    if (buf.length > maxBytes) {
      throw new Error(`图片体积过大 (${Math.round(buf.length / 1024 / 1024)}MB)`);
    }
    return this._finalizeBuffer(buf, imgMeta);
  }

  async _finalizeBuffer(buf, meta = {}) {
    const detected = detectImageMime(buf);
    if (!detected) {
      throw new Error('无法识别的图片格式（仅支持 PNG/JPEG/GIF/WebP）');
    }
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');

    // For vision input, turn animated GIF into a sequential storyboard contact sheet PNG (or single PNG if 1 frame)
    let visionBuf = buf;
    let visionMime = detected.mimeType;
    let animation = null;

    if (detected.mimeType === 'image/gif') {
      const rendered = await this._renderGifForVision(buf, sha256);
      if (rendered?.buffer) {
        visionBuf = rendered.buffer;
        visionMime = 'image/png';
        animation = rendered.animation || null;
      }
    }

    return {
      buffer: buf, // original bytes (keeps animated GIF intact for sticker storage!)
      mimeType: visionMime,
      originalMimeType: detected.mimeType,
      ext: detected.ext,
      sha256,
      base64: visionBuf.toString('base64'),
      summary: meta.summary || '',
      isSticker: Boolean(meta.isSticker),
      isCardPreview: Boolean(meta.isCardPreview),
      isLocalGifPreview: Boolean(meta.isLocalGifPreview),
      animation
    };
  }

  async _probeGifMeta(inPath, ffmpegPath) {
    const ffprobe = resolveFfprobePath(ffmpegPath);
    try {
      const { stdout } = await execFileAsync(
        ffprobe,
        [
          '-v', 'error',
          '-count_packets',
          '-select_streams', 'v:0',
          '-show_entries', 'stream=nb_read_packets,width,height,duration',
          '-show_entries', 'format=duration',
          '-of', 'json',
          inPath
        ],
        { timeout: 10000, windowsHide: true }
      );
      const parsed = JSON.parse(stdout || '{}');
      const st = Array.isArray(parsed.streams) ? parsed.streams[0] : null;
      if (!st) return null;
      const frameCount = Math.max(0, parseInt(st.nb_read_packets || '0', 10) || 0);
      const width = Math.max(0, Number(st.width || 0));
      const height = Math.max(0, Number(st.height || 0));
      const durationSec = Math.max(
        0,
        Number(st.duration || parsed.format?.duration || 0) || 0
      );
      return { frameCount, width, height, durationSec };
    } catch {
      return null;
    }
  }

  async _renderGifForVision(gifBuf, sha256) {
    const visionCfg = this.configStore.get().vision || {};
    const ffmpeg = visionCfg.ffmpegPath || 'ffmpeg';
    const storyboardEnabled = visionCfg.gifStoryboardEnabled !== false;
    const maxFrames = Number(visionCfg.gifMaxFrames ?? 6);
    const tileMaxSide = Number(visionCfg.gifTileMaxSide ?? 320);

    const uniq = `${sha256.slice(0, 12)}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const inPath = path.join(this.tmpDir, `${uniq}.gif`);
    const outPath = path.join(this.tmpDir, `${uniq}.png`);

    try {
      fs.writeFileSync(inPath, gifBuf);

      if (storyboardEnabled) {
        const meta = await this._probeGifMeta(inPath, ffmpeg);
        const layout = meta ? selectStoryboardLayout(meta.frameCount, { maxFrames }) : null;
        if (layout) {
          const tile = computeTileDimensions(meta.width, meta.height, layout.cols, {
            maxTileSide: tileMaxSide
          });
          const selExpr = layout.indices.map((i) => `eq(n,${i})`).join('+');
          const fontArg = resolveDrawtextFontArg();
          const fontSize = Math.max(16, Math.min(24, Math.round(Math.min(tile.width, tile.height) * 0.11)));

          const baseChain = [
            `[0:v]select='${selExpr}',setpts=N/TB,scale=${tile.width}:${tile.height}:flags=lanczos,format=rgba,split[bg0][fg]`,
            `[bg0]drawbox=x=0:y=0:w=iw:h=ih:color=#F4F6FA@1:t=fill:replace=1[bg]`
          ];
          const drawtextStep = `drawtext=${fontArg}text='%{eif\\:n+1\\:d}':x=8:y=8:fontsize=${fontSize}:fontcolor=white:box=1:boxcolor=0x1e293b@0.82:boxborderw=5`;
          const tileStep = `tile=${layout.cols}x${layout.rows}:padding=8:margin=8:color=#CBD5E1`;

          const fcWithLabels = `${baseChain.join(';')};[bg][fg]overlay=0:0:format=auto,format=rgb24,${drawtextStep},${tileStep}`;
          const fcPlain = `${baseChain.join(';')};[bg][fg]overlay=0:0:format=auto,format=rgb24,${tileStep}`;

          let ok = false;
          try {
            await execFileAsync(
              ffmpeg,
              ['-y', '-v', 'error', '-i', inPath, '-filter_complex', fcWithLabels, '-fps_mode', 'passthrough', '-frames:v', '1', outPath],
              { timeout: 15000, windowsHide: true }
            );
            ok = fs.existsSync(outPath) && fs.statSync(outPath).size > 0;
          } catch {
            ok = false;
          }

          if (!ok) {
            try {
              await execFileAsync(
                ffmpeg,
                ['-y', '-v', 'error', '-i', inPath, '-filter_complex', fcPlain, '-fps_mode', 'passthrough', '-frames:v', '1', outPath],
                { timeout: 15000, windowsHide: true }
              );
              ok = fs.existsSync(outPath) && fs.statSync(outPath).size > 0;
            } catch {
              ok = false;
            }
          }

          if (ok) {
            return {
              buffer: fs.readFileSync(outPath),
              animation: {
                isAnimated: true,
                frameCount: meta.frameCount,
                durationSec: Number(meta.durationSec.toFixed(2)),
                sampledFrames: layout.sampledFrames,
                cols: layout.cols,
                rows: layout.rows,
                layout: layout.layout
              }
            };
          }
        }
      }

      // Single-frame static GIF or fallback: composite first frame cleanly onto light background
      const singleFc =
        '[0:v]format=rgba,split[bg0][fg];[bg0]drawbox=x=0:y=0:w=iw:h=ih:color=#F4F6FA@1:t=fill:replace=1[bg];[bg][fg]overlay=0:0:format=auto,format=rgb24';
      try {
        await execFileAsync(
          ffmpeg,
          ['-y', '-v', 'error', '-i', inPath, '-filter_complex', singleFc, '-frames:v', '1', outPath],
          { timeout: 10000, windowsHide: true }
        );
      } catch {
        await execFileAsync(ffmpeg, ['-y', '-v', 'error', '-i', inPath, '-vframes', '1', outPath], {
          timeout: 10000,
          windowsHide: true
        });
      }
      if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
        return { buffer: fs.readFileSync(outPath), animation: null };
      }
      return null;
    } catch {
      return null;
    } finally {
      try { fs.unlinkSync(inPath); } catch {}
      try { fs.unlinkSync(outPath); } catch {}
    }
  }

  async prepareImagesForTurn(imagesMeta = [], onebotClient = null) {
    const cfg = this.configStore.get().vision;
    if (!cfg.enabled || !imagesMeta.length) return [];
    const maxCount = cfg.maxImagesPerTurn || 4;
    const picked = imagesMeta.slice(0, maxCount);
    const out = [];
    for (const meta of picked) {
      try {
        const fetched = await this.fetchImageBuffer(meta, onebotClient);
        out.push(fetched);
      } catch {
        // skip single bad image rather than failing the whole turn
      }
    }
    return out;
  }
}
