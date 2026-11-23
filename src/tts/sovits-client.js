import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import { normalizeEmotion } from './reply-parser.js';

const execFileAsync = promisify(execFile);

function canBindPort(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => {
      srv.close(() => resolve(true));
    });
    srv.listen(port, '127.0.0.1');
  });
}

function collectFilesRecursive(dir, exts, maxDepth = 4, depth = 0, out = []) {
  if (depth > maxDepth || !dir || !fs.existsSync(dir)) return out;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    if (ent.name === 'runtime' || ent.name === '__pycache__' || ent.name === 'node_modules') continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      collectFilesRecursive(full, exts, maxDepth, depth + 1, out);
    } else if (ent.isFile()) {
      const ext = path.extname(ent.name).toLowerCase();
      if (exts.includes(ext)) {
        out.push(full);
      }
    }
  }
  return out;
}

export class SoVitsClient extends EventEmitter {
  constructor(configStore, rootDir) {
    super();
    this.configStore = configStore;
    this.rootDir = rootDir;
    this.cacheDir = path.join(rootDir, 'data', 'voice-cache');
    this.logsDir = path.join(rootDir, 'data', 'logs');
    fs.mkdirSync(this.cacheDir, { recursive: true });
    fs.mkdirSync(this.logsDir, { recursive: true });

    this.online = false;
    this.resolvedBaseUrl = '';
    this.lastLatencyMs = null;
    this.lastCheckAt = null;
    this.lastError = null;
    this.cacheHits = 0;
    this.cacheMisses = 0;
    this.managedPid = null;
    this.prewarmed = false;
    this.prewarming = false;
    this.prewarmLatencyMs = null;
    this.prewarmedAt = null;
    this.prewarmingPromise = null;
  }

  async _pingUrl(url) {
    const clean = String(url || '').replace(/\/+$/, '');
    if (!clean) return false;
    try {
      const res = await fetch(`${clean}/openapi.json`, { signal: AbortSignal.timeout(1800) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async probeHealth() {
    const cfg = this.configStore.get().tts;
    const t0 = Date.now();
    this.lastCheckAt = t0;

    if (await this._pingUrl(cfg.baseUrl)) {
      this.online = true;
      this.resolvedBaseUrl = cfg.baseUrl.replace(/\/+$/, '');
      this.lastError = null;
      return { online: true, baseUrl: this.resolvedBaseUrl, probeMs: Date.now() - t0 };
    }

    // Auto-discover among candidate ports (Windows winnat port drift resilience)
    for (const port of cfg.autoProbePorts || [19880, 9880, 18880, 28880, 12880]) {
      const candidate = `http://127.0.0.1:${port}`;
      if (candidate === cfg.baseUrl.replace(/\/+$/, '')) continue;
      if (await this._pingUrl(candidate)) {
        this.online = true;
        this.resolvedBaseUrl = candidate;
        this.lastError = null;
        return { online: true, baseUrl: this.resolvedBaseUrl, probeMs: Date.now() - t0 };
      }
    }

    this.online = false;
    this.prewarmed = false;
    this.resolvedBaseUrl = cfg.baseUrl.replace(/\/+$/, '');
    this.lastError = `未检测到 GPT-SoVITS v5 服务 (${this.resolvedBaseUrl})`;
    return { online: false, baseUrl: this.resolvedBaseUrl, probeMs: Date.now() - t0, error: this.lastError };
  }

  async startLocalServer() {
    const health = await this.probeHealth();
    if (health.online) {
      return { alreadyRunning: true, baseUrl: health.baseUrl };
    }

    const cfg = this.configStore.get().tts;
    const gsvRoot = cfg.sovitsRoot;
    const pyExe = path.join(gsvRoot, 'runtime', 'python.exe');
    const apiPy = path.join(gsvRoot, 'api_v2.py');
    const yamlCfg = cfg.sovitsConfigYaml;

    if (!fs.existsSync(pyExe) || !fs.existsSync(apiPy)) {
      throw new Error(`找不到本机 GPT-SoVITS v5 运行环境: ${pyExe}`);
    }

    let chosenPort = null;
    for (const p of cfg.autoProbePorts || [19880, 9880, 18880, 28880, 12880]) {
      if (await canBindPort(p)) {
        chosenPort = p;
        break;
      }
    }
    if (!chosenPort) {
      throw new Error('所有候选端口均不可绑定（可能被 Windows 保留段占用）');
    }

    // Redirect stdout/stderr to files directly to avoid Python block-buffering deadlock!
    const outFd = fs.openSync(path.join(this.logsDir, 'sovits.out.log'), 'a');
    const errFd = fs.openSync(path.join(this.logsDir, 'sovits.err.log'), 'a');
    const args = ['-u', 'api_v2.py', '-a', '127.0.0.1', '-p', String(chosenPort)];
    if (yamlCfg && fs.existsSync(yamlCfg)) {
      args.push('-c', yamlCfg);
    }

    const child = spawn(pyExe, args, {
      cwd: gsvRoot,
      detached: true,
      stdio: ['ignore', outFd, errFd],
      windowsHide: true
    });
    child.unref();
    fs.closeSync(outFd);
    fs.closeSync(errFd);

    this.managedPid = child.pid;
    const targetUrl = `http://127.0.0.1:${chosenPort}`;
    this.configStore.update({ tts: { baseUrl: targetUrl } });
    this.emit('log', {
      level: 'info',
      message: `正在后台启动 GPT-SoVITS v5 (PID ${child.pid}, 端口 ${chosenPort})，模型加载约需 30~60 秒...`
    });
    return { alreadyRunning: false, pid: child.pid, baseUrl: targetUrl };
  }

  discoverLocalAssets() {
    const cfg = this.configStore.get().tts;
    const root = cfg.sovitsRoot || '';
    const gptWeights = [];
    const sovitsWeights = [];
    const sampleAudios = [];

    if (root && fs.existsSync(root)) {
      const scanDirs = [
        path.join(root, 'GPT_SoVITS', 'pretrained_models'),
        path.join(root, 'GPT_weights'),
        path.join(root, 'GPT_weights_v2'),
        path.join(root, 'GPT_weights_v2Pro'),
        path.join(root, 'GPT_weights_v2ProPlus'),
        path.join(root, 'GPT_weights_v3'),
        path.join(root, 'GPT_weights_v4'),
        path.join(root, 'GPT_weights_v5'),
        path.join(root, 'SoVITS_weights'),
        path.join(root, 'SoVITS_weights_v2'),
        path.join(root, 'SoVITS_weights_v2Pro'),
        path.join(root, 'SoVITS_weights_v2ProPlus'),
        path.join(root, 'SoVITS_weights_v3'),
        path.join(root, 'SoVITS_weights_v4'),
        path.join(root, 'SoVITS_weights_v5')
      ];
      for (const d of scanDirs) {
        for (const f of collectFilesRecursive(d, ['.ckpt', '.pth'], 3)) {
          if (f.endsWith('.ckpt')) gptWeights.push(f);
          else if (f.endsWith('.pth') && !path.basename(f).startsWith('s2D')) sovitsWeights.push(f);
        }
      }
    }

    const audioRoots = [
      path.join(this.rootDir, 'audio_clip'),
      path.join(this.rootDir, 'data', 'voice-refs'),
      cfg.sovitsRoot ? path.join(cfg.sovitsRoot, 'reference_audio') : ''
    ].filter(Boolean);
    for (const d of audioRoots) {
      for (const f of collectFilesRecursive(d, ['.wav', '.mp3', '.ogg', '.flac'], 5)) {
        sampleAudios.push(f);
      }
    }

    return {
      gptWeights: [...new Set(gptWeights)].slice(0, 60),
      sovitsWeights: [...new Set(sovitsWeights)].slice(0, 60),
      sampleAudios: [...new Set(sampleAudios)].slice(0, 80)
    };
  }

  async switchWeights({ gptWeightsPath = '', sovitsWeightsPath = '' }) {
    const health = await this.probeHealth();
    if (!health.online) {
      throw new Error('GPT-SoVITS v5 服务未运行，无法热切换音色权重');
    }
    const base = health.baseUrl;
    const results = {};

    if (gptWeightsPath) {
      const r = await fetch(`${base}/set_gpt_weights?weights_path=${encodeURIComponent(gptWeightsPath)}`, {
        signal: AbortSignal.timeout(30000)
      });
      const text = await r.text();
      if (!r.ok) throw new Error(`切换 GPT 权重失败: ${text}`);
      results.gpt = text;
    }

    if (sovitsWeightsPath) {
      const r = await fetch(`${base}/set_sovits_weights?weights_path=${encodeURIComponent(sovitsWeightsPath)}`, {
        signal: AbortSignal.timeout(30000)
      });
      const text = await r.text();
      if (!r.ok) throw new Error(`切换 SoVITS 权重失败: ${text}`);
      results.sovits = text;
    }

    this.prewarmed = false;
    this.configStore.update({
      tts: {
        activeGptWeights: gptWeightsPath || this.configStore.get().tts.activeGptWeights,
        activeSovitsWeights: sovitsWeightsPath || this.configStore.get().tts.activeSovitsWeights
      }
    });

    if (this.configStore.get().tts.prewarmOnStart) {
      this.prewarm({ force: true }).catch(() => {});
    }
    return results;
  }

  buildInferPayload({ text, textLang, refAudioPath, promptLang, promptText, speedFactor, inferParams }) {
    const ip = inferParams || {};
    return {
      text,
      text_lang: textLang,
      ref_audio_path: refAudioPath,
      prompt_lang: promptLang,
      prompt_text: promptText,
      top_k: Number(ip.top_k ?? 15),
      top_p: Number(ip.top_p ?? 1),
      temperature: Number(ip.temperature ?? 1),
      text_split_method: String(ip.text_split_method || 'cut5'),
      batch_size: Number(ip.batch_size ?? 1),
      speed_factor: Number(speedFactor ?? ip.speed_factor ?? 1),
      fragment_interval: Number(ip.fragment_interval ?? 0.32),
      sample_steps: Number(ip.sample_steps ?? 32),
      use_cuda_graph: Boolean(ip.use_cuda_graph ?? true),
      use_flash_attention: Boolean(ip.use_flash_attention ?? true),
      media_type: String(ip.media_type || 'wav'),
      parallel_infer: Boolean(ip.parallel_infer ?? true),
      streaming_mode: Boolean(ip.streaming_mode ?? false)
    };
  }

  async prewarm({ force = false } = {}) {
    if (!force && this.prewarmed) {
      return { ok: true, alreadyPrewarmed: true, latencyMs: this.prewarmLatencyMs };
    }
    if (this.prewarmingPromise) {
      return this.prewarmingPromise;
    }

    this.prewarming = true;
    this.prewarmingPromise = this._runPrewarm().finally(() => {
      this.prewarming = false;
      this.prewarmingPromise = null;
    });
    return this.prewarmingPromise;
  }

  async _runPrewarm() {
    const cfg = this.configStore.get().tts;
    const health = await this.probeHealth();
    if (!health.online) {
      return { ok: false, reason: 'offline', baseUrl: health.baseUrl };
    }

    const defaultEmo = normalizeEmotion(cfg.defaultEmotion, '平静');
    const emoProfile = cfg.emotions?.[defaultEmo] || Object.values(cfg.emotions || {})[0] || {};
    const refAudioPath = emoProfile.refAudioPath || '';
    if (!refAudioPath || !fs.existsSync(refAudioPath)) {
      const errMsg = `预热跳过：默认情感「${defaultEmo}」未配置有效参考音频`;
      this.emit('log', { level: 'warn', message: errMsg });
      return { ok: false, reason: errMsg };
    }

    const body = this.buildInferPayload({
      text: cfg.prewarmText || '你好，主人。',
      textLang: cfg.textLang || 'zh',
      refAudioPath,
      promptLang: emoProfile.promptLang || cfg.textLang || 'zh',
      promptText: emoProfile.promptText || '',
      speedFactor: emoProfile.speedFactor ?? cfg.inferParams?.speed_factor ?? 1,
      inferParams: cfg.inferParams
    });

    this.emit('log', {
      level: 'info',
      message: `开始预热 GPT-SoVITS v5 (CUDA Graph=${body.use_cuda_graph}, FlashAttn=${body.use_flash_attention}, steps=${body.sample_steps})...`
    });

    const t0 = Date.now();
    const res = await fetch(`${health.baseUrl}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90000)
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      const msg = `GPT-SoVITS v5 预热失败 (HTTP ${res.status}): ${errText.slice(0, 180)}`;
      this.lastError = msg;
      this.emit('log', { level: 'warn', message: msg });
      return { ok: false, reason: msg };
    }

    // Drain audio bytes cleanly without writing to voice-cache or bumping cacheMisses
    const buf = Buffer.from(await res.arrayBuffer());
    const latencyMs = Date.now() - t0;
    this.prewarmed = true;
    this.prewarmLatencyMs = latencyMs;
    this.prewarmedAt = Date.now();
    this.lastError = null;
    this.emit('log', {
      level: 'info',
      message: `GPT-SoVITS v5 预热完成 (${latencyMs}ms, ${Math.round(buf.length / 1024)}KB)，后续推理直享热态加速`
    });
    this.emit('prewarmed', { latencyMs });
    return { ok: true, alreadyPrewarmed: false, latencyMs, bytes: buf.length };
  }

  computeCacheKey({
    text,
    emotion,
    refAudioPath,
    promptText,
    promptLang,
    speedFactor,
    textLang,
    activeGptWeights,
    activeSovitsWeights,
    qqAudioFormat,
    inferParams
  }) {
    const payload = JSON.stringify({
      text,
      emotion,
      refAudioPath,
      promptText,
      promptLang,
      speedFactor,
      textLang,
      activeGptWeights,
      activeSovitsWeights,
      qqAudioFormat,
      inferParams
    });
    return crypto.createHash('sha256').update(payload).digest('hex');
  }

  async synthesize({ text, emotion }) {
    const cfg = this.configStore.get().tts;
    const cleanText = String(text || '').trim().slice(0, cfg.maxVoiceChars || 120);
    if (!cleanText) {
      throw new Error('语音合成文本为空');
    }

    const normEmotion = normalizeEmotion(emotion, cfg.defaultEmotion || '平静');
    const emoProfile = cfg.emotions?.[normEmotion] || cfg.emotions?.[cfg.defaultEmotion] || {};
    const refAudioPath = emoProfile.refAudioPath || '';
    if (!refAudioPath || !fs.existsSync(refAudioPath)) {
      throw new Error(`情感「${normEmotion}」未配置有效的参考音频文件: ${refAudioPath || '(未配置)'}`);
    }

    const promptText = emoProfile.promptText || '';
    const promptLang = emoProfile.promptLang || cfg.textLang || 'zh';
    const inferParams = cfg.inferParams || {};
    const speedFactor = emoProfile.speedFactor ?? inferParams.speed_factor ?? cfg.speedFactor ?? 1.0;
    const textLang = cfg.textLang || 'zh';
    const sourceFmt = String(inferParams.media_type || cfg.mediaType || 'wav').toLowerCase();
    const qqAudioFormat = (cfg.qqAudioFormat || sourceFmt || 'wav').toLowerCase();

    const hash = this.computeCacheKey({
      text: cleanText,
      emotion: normEmotion,
      refAudioPath,
      promptText,
      promptLang,
      speedFactor,
      textLang,
      activeGptWeights: cfg.activeGptWeights || '',
      activeSovitsWeights: cfg.activeSovitsWeights || '',
      qqAudioFormat,
      inferParams
    });

    const cachedFile = path.join(this.cacheDir, `${hash}.${qqAudioFormat}`);
    if (cfg.cacheEnabled && fs.existsSync(cachedFile)) {
      this.cacheHits += 1;
      const buffer = fs.readFileSync(cachedFile);
      return {
        buffer,
        filePath: cachedFile,
        sha256: hash,
        emotion: normEmotion,
        format: qqAudioFormat,
        cached: true,
        latencyMs: 0
      };
    }

    const health = await this.probeHealth();
    if (!health.online) {
      throw new Error(`GPT-SoVITS v5 服务离线 (${health.baseUrl})`);
    }

    const t0 = Date.now();
    const body = this.buildInferPayload({
      text: cleanText,
      textLang,
      refAudioPath,
      promptLang,
      promptText,
      speedFactor,
      inferParams
    });

    const res = await fetch(`${health.baseUrl}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000)
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`GPT-SoVITS /tts 失败 (HTTP ${res.status}): ${errText.slice(0, 240)}`);
    }

    let audioBuf = Buffer.from(await res.arrayBuffer());
    if (qqAudioFormat !== sourceFmt) {
      audioBuf = await this._transcodeAudio(audioBuf, sourceFmt, qqAudioFormat, hash);
    }

    const latencyMs = Date.now() - t0;
    this.lastLatencyMs = latencyMs;
    this.prewarmed = true;
    this.cacheMisses += 1;

    if (cfg.cacheEnabled) {
      const tmp = `${cachedFile}.tmp.${process.pid}`;
      fs.writeFileSync(tmp, audioBuf);
      fs.renameSync(tmp, cachedFile);
    }

    return {
      buffer: audioBuf,
      filePath: cachedFile,
      sha256: hash,
      emotion: normEmotion,
      format: qqAudioFormat,
      cached: false,
      latencyMs
    };
  }

  async _transcodeAudio(buf, fromExt, toExt, hash) {
    const ffmpeg = this.configStore.get().vision.ffmpegPath || 'ffmpeg';
    const inFile = path.join(this.cacheDir, `tmp_${hash.slice(0, 12)}.${fromExt}`);
    const outFile = path.join(this.cacheDir, `tmp_${hash.slice(0, 12)}.${toExt}`);
    try {
      fs.writeFileSync(inFile, buf);
      const args = toExt === 'amr'
        ? ['-y', '-i', inFile, '-ar', '8000', '-ac', '1', '-ab', '12.2k', outFile]
        : ['-y', '-i', inFile, outFile];
      await execFileAsync(ffmpeg, args, { timeout: 15000, windowsHide: true });
      return fs.readFileSync(outFile);
    } finally {
      try { fs.unlinkSync(inFile); } catch {}
      try { fs.unlinkSync(outFile); } catch {}
    }
  }

  getCacheStats() {
    let files = 0;
    let totalBytes = 0;
    try {
      for (const name of fs.readdirSync(this.cacheDir)) {
        if (name.startsWith('tmp_')) continue;
        const st = fs.statSync(path.join(this.cacheDir, name));
        if (st.isFile()) {
          files += 1;
          totalBytes += st.size;
        }
      }
    } catch {}
    const totalReq = this.cacheHits + this.cacheMisses;
    return {
      files,
      totalMb: Number((totalBytes / (1024 * 1024)).toFixed(2)),
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      hitRate: totalReq ? Number(((this.cacheHits / totalReq) * 100).toFixed(1)) : 0
    };
  }

  clearCache() {
    let removed = 0;
    for (const name of fs.readdirSync(this.cacheDir)) {
      try {
        fs.unlinkSync(path.join(this.cacheDir, name));
        removed += 1;
      } catch {}
    }
    this.cacheHits = 0;
    this.cacheMisses = 0;
    return removed;
  }

  getStatus() {
    const cfg = this.configStore.get().tts;
    return {
      enabled: cfg.enabled,
      online: this.online,
      prewarmed: this.prewarmed,
      prewarming: this.prewarming,
      prewarmLatencyMs: this.prewarmLatencyMs,
      prewarmedAt: this.prewarmedAt,
      baseUrl: this.resolvedBaseUrl || cfg.baseUrl,
      activeGptWeights: cfg.activeGptWeights || '',
      activeSovitsWeights: cfg.activeSovitsWeights || '',
      lastLatencyMs: this.lastLatencyMs,
      lastCheckAt: this.lastCheckAt,
      lastError: this.lastError,
      managedPid: this.managedPid,
      cache: this.getCacheStats()
    };
  }
}
