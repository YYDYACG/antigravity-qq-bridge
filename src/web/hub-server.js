import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { detectImageMime } from '../media/vision-fetcher.js';

export function validateLocalBrowserUrl(rawUrl) {
  const u = new URL(String(rawUrl || ''));
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost')) {
    throw new Error('仅允许打开本机 localhost / 127.0.0.1 地址');
  }
  return u.toString();
}

async function openLocalUrlInBrowser(rawUrl) {
  const target = validateLocalBrowserUrl(rawUrl);
  if (process.platform === 'win32') {
    // Must use non-detached execFile (piped stdio): PowerShell silently exits without running under detached+windowsHide+stdio:'ignore'
    await new Promise((resolve, reject) => {
      execFile(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-WindowStyle',
          'Hidden',
          '-Command',
          'Start-Process -FilePath $env:AGYQQ_OPEN_URL'
        ],
        {
          windowsHide: true,
          timeout: 8000,
          env: { ...process.env, AGYQQ_OPEN_URL: target }
        },
        (err) => (err ? reject(err) : resolve())
      );
    });
    return target;
  }
  const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
  const child = spawn(cmd, [target], { detached: true, stdio: 'ignore' });
  child.unref();
  return target;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME_MAP = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg'
};

function readBody(req, maxBytes = 12 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  return JSON.parse(buf.toString('utf8'));
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

export class HubServer {
  constructor({ configStore, engine, openUrlFn = openLocalUrlInBrowser }) {
    this.configStore = configStore;
    this.engine = engine;
    this.openUrlFn = openUrlFn;
    this.server = null;
    this.sseClients = new Set();

    this.engine.on('log', (entry) => this._broadcastSse('log', entry));
    this.engine.on('status-change', () => this._broadcastSse('status', { ts: Date.now() }));
  }

  _broadcastSse(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.sseClients) {
      try {
        res.write(payload);
      } catch {
        this.sseClients.delete(res);
      }
    }
  }

  _checkAuth(req, urlObj) {
    const expected = this.configStore.get().hub.token;
    if (!expected) return true;
    const auth = String(req.headers.authorization || '');
    const headerTok = String(req.headers['x-hub-token'] || '');
    const queryTok = urlObj.searchParams.get('token') || '';
    const cookieHeader = String(req.headers.cookie || '');
    const cookieMatch = cookieHeader.match(/(?:^|;\s*)agy_hub_token=([^;]+)/);
    const cookieTok = cookieMatch ? decodeURIComponent(cookieMatch[1]) : '';

    return (
      auth === `Bearer ${expected}` ||
      headerTok === expected ||
      queryTok === expected ||
      cookieTok === expected
    );
  }

  async _handleApi(req, res, urlObj) {
    const pathname = urlObj.pathname;
    const method = req.method || 'GET';

    // Allow local cross-origin requests (e.g. Antigravity MCP App sandbox iframe) when carrying valid token
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-hub-token');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      if (method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }
    }

    // Token verification endpoint
    if (pathname === '/api/auth/verify' && method === 'POST') {
      const body = await readJsonBody(req);
      const expected = this.configStore.get().hub.token;
      if (String(body.token || '') !== expected) {
        sendJson(res, 401, { ok: false, error: '访问令牌不正确' });
        return;
      }
      res.setHeader(
        'Set-Cookie',
        `agy_hub_token=${encodeURIComponent(expected)}; Path=/; HttpOnly; SameSite=Strict`
      );
      sendJson(res, 200, { ok: true });
      return;
    }

    if (!this._checkAuth(req, urlObj)) {
      sendJson(res, 401, { ok: false, error: '未授权访问，请先输入 Hub 访问令牌' });
      return;
    }

    // SSE live stream
    if (pathname === '/api/events' && method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      });
      res.write(`event: hello\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);
      this.sseClients.add(res);
      const hb = setInterval(() => {
        try { res.write(': ping\n\n'); } catch {}
      }, 20000);
      req.on('close', () => {
        clearInterval(hb);
        this.sseClients.delete(res);
      });
      return;
    }

    // Full status
    if (pathname === '/api/status' && method === 'GET') {
      sendJson(res, 200, { ok: true, data: this.engine.getFullStatus() });
      return;
    }

    // Logs
    if (pathname === '/api/logs' && method === 'GET') {
      sendJson(res, 200, { ok: true, data: this.engine.logs.slice(0, 150) });
      return;
    }

    // Config GET & PATCH
    if (pathname === '/api/config' && method === 'GET') {
      const cfg = structuredClone(this.configStore.get());
      cfg.hub.token = cfg.hub.token ? '***已配置***' : '';
      sendJson(res, 200, { ok: true, data: cfg });
      return;
    }

    if (pathname === '/api/config' && (method === 'PUT' || method === 'PATCH')) {
      const patch = await readJsonBody(req);
      // Do not overwrite hub.token with masked placeholder
      if (patch?.hub?.token === '***已配置***' || patch?.hub?.token === '') {
        delete patch.hub.token;
      }
      const updated = this.configStore.update(patch);
      this.engine.emit('status-change');
      const masked = structuredClone(updated);
      masked.hub.token = '***已配置***';
      sendJson(res, 200, { ok: true, data: masked });
      return;
    }

    // Engine control (start / stop / pause / resume / reconnect-onebot / refresh-models)
    if (pathname === '/api/engine/control' && method === 'POST') {
      const { action } = await readJsonBody(req);
      if (action === 'pause') {
        this.engine.setPaused(true);
      } else if (action === 'resume') {
        this.engine.setPaused(false);
      } else if (action === 'start') {
        await this.engine.start();
      } else if (action === 'stop') {
        await this.engine.stop();
      } else if (action === 'reconnect-onebot') {
        await this.engine.restartOneBot();
      } else if (action === 'refresh-models') {
        const cat = await this.engine.sessionManager?.refreshModelCatalog();
        sendJson(res, 200, { ok: true, data: cat });
        return;
      } else {
        sendJson(res, 400, { ok: false, error: `未知控制指令: ${action}` });
        return;
      }
      sendJson(res, 200, { ok: true, data: this.engine.getFullStatus() });
      return;
    }

    // Sessions reset & manual compact
    if (pathname === '/api/sessions/reset' && method === 'POST') {
      const { sessionKey } = await readJsonBody(req);
      if (!sessionKey) {
        sendJson(res, 400, { ok: false, error: '缺少 sessionKey' });
        return;
      }
      const ok = await this.engine.sessionManager?.resetSession(sessionKey);
      sendJson(res, 200, { ok: true, reset: Boolean(ok) });
      return;
    }

    if (pathname === '/api/sessions/compact' && method === 'POST') {
      const { sessionKey, mode } = await readJsonBody(req);
      if (!sessionKey) {
        sendJson(res, 400, { ok: false, error: '缺少 sessionKey' });
        return;
      }
      const info = await this.engine.sessionManager?.compactSession(sessionKey, {
        mode: mode || '',
        reason: 'hub-manual'
      });
      sendJson(res, 200, { ok: true, data: info });
      return;
    }

    // Token Dashboard
    if (pathname === '/api/tokens' && method === 'GET') {
      const hours = Number(urlObj.searchParams.get('hours') || 24);
      sendJson(res, 200, { ok: true, data: this.engine.tokenStore.getDashboard(hours) });
      return;
    }

    // TTS endpoints
    if (pathname === '/api/tts/assets' && method === 'GET') {
      const assets = this.engine.sovitsClient.discoverLocalAssets();
      const health = await this.engine.sovitsClient.probeHealth();
      sendJson(res, 200, { ok: true, data: { assets, health, status: this.engine.sovitsClient.getStatus() } });
      return;
    }

    if (pathname === '/api/tts/start' && method === 'POST') {
      const info = await this.engine.sovitsClient.startLocalServer();
      sendJson(res, 200, { ok: true, data: info });
      return;
    }

    if (pathname === '/api/tts/prewarm' && method === 'POST') {
      const data = await this.engine.sovitsClient.prewarm({ force: true });
      this.engine.emit('status-change');
      sendJson(res, 200, { ok: true, data });
      return;
    }

    if (pathname === '/api/tts/switch-weights' && method === 'POST') {
      const body = await readJsonBody(req);
      const resSwitch = await this.engine.sovitsClient.switchWeights({
        gptWeightsPath: body.gptWeightsPath || '',
        sovitsWeightsPath: body.sovitsWeightsPath || ''
      });
      sendJson(res, 200, { ok: true, data: resSwitch });
      return;
    }

    if (pathname === '/api/tts/preview' && method === 'POST') {
      const body = await readJsonBody(req);
      const synth = await this.engine.sovitsClient.synthesize({
        text: body.text || '哼，终于来接我走出对话框了呀，主人？',
        emotion: body.emotion || '调皮'
      });
      sendJson(res, 200, {
        ok: true,
        data: {
          emotion: synth.emotion,
          cached: synth.cached,
          latencyMs: synth.latencyMs,
          sha256: synth.sha256,
          format: synth.format,
          audioBase64: synth.buffer.toString('base64')
        }
      });
      return;
    }

    if (pathname === '/api/tts/cache/clear' && method === 'POST') {
      const removed = this.engine.sovitsClient.clearCache();
      sendJson(res, 200, { ok: true, removed });
      return;
    }

    // NapCatQQ local manager endpoints
    if (pathname === '/api/napcat/start' && method === 'POST') {
      const body = await readJsonBody(req).catch(() => ({}));
      const info = await this.engine.napcatManager.startLocalNapCat(body.quickLoginQQ || '', {
        skipQuickLogin: Boolean(body.skipQuickLogin)
      });
      sendJson(res, 200, { ok: true, data: info });
      return;
    }

    if (pathname === '/api/napcat/restart' && method === 'POST') {
      const body = await readJsonBody(req).catch(() => ({}));
      const info = await this.engine.napcatManager.restartLocalNapCat({
        skipQuickLogin: body.skipQuickLogin !== false,
        quickLoginQQ: body.quickLoginQQ || ''
      });
      sendJson(res, 200, { ok: true, data: info });
      return;
    }

    if (pathname === '/api/napcat/status' && method === 'GET') {
      const st = await this.engine.napcatManager.probeStatus();
      sendJson(res, 200, { ok: true, data: st });
      return;
    }

    if (pathname === '/api/napcat/open-webui' && method === 'POST') {
      const st = await this.engine.napcatManager.probeStatus();
      const safeUrl = validateLocalBrowserUrl(st?.webuiUrl || 'http://127.0.0.1:6099/webui');
      const targetUrl = await this.openUrlFn(safeUrl);
      this.engine._log('info', 'hub', `已通过本机默认浏览器拉起 NapCat WebUI: ${targetUrl}`);
      sendJson(res, 200, { ok: true, data: { url: targetUrl, webuiOnline: Boolean(st?.webuiOnline) } });
      return;
    }

    // Persona reference avatar image
    if (pathname === '/api/persona/avatar' && method === 'GET') {
      const refPath = this.configStore.get().acp?.persona?.referenceImagePath || '';
      if (!refPath || !fs.existsSync(refPath)) {
        res.writeHead(404);
        res.end('No reference image');
        return;
      }
      const buf = fs.readFileSync(refPath);
      const det = detectImageMime(buf);
      res.writeHead(200, {
        'Content-Type': det?.mimeType || 'image/jpeg',
        'Cache-Control': 'no-cache'
      });
      res.end(buf);
      return;
    }

    // Stickers endpoints
    if (pathname === '/api/stickers' && method === 'GET') {
      const query = urlObj.searchParams.get('q') || '';
      const items = this.engine.stickerStore.list({ query, limit: 120 });
      const stats = this.engine.stickerStore.getStats();
      const rejections = this.engine.stickerStore.listRejections(15);
      sendJson(res, 200, { ok: true, data: { items, stats, rejections } });
      return;
    }

    if (pathname === '/api/stickers/curate' && method === 'POST') {
      const body = await readJsonBody(req);
      const b64 = String(body.imageBase64 || '').replace(/^data:[^;]+;base64,/, '');
      if (!b64) {
        sendJson(res, 400, { ok: false, error: '缺少图片数据' });
        return;
      }
      const resCurate = await this.engine.curateStickerImage({
        imageBase64: b64,
        contextText: body.contextText || '',
        autoSave: body.autoSave !== false
      });
      sendJson(res, 200, { ok: true, data: resCurate });
      return;
    }

    if (pathname === '/api/stickers/rejections/clear' && method === 'POST') {
      this.engine.stickerStore.clearRejections();
      sendJson(res, 200, { ok: true });
      return;
    }

    if (pathname === '/api/stickers/sync-qq' && method === 'POST') {
      const data = await this.engine.syncQqFavoriteStickers({ count: 200, silent: false });
      sendJson(res, 200, { ok: true, data });
      return;
    }

    if (pathname === '/api/stickers/batch-analyze' && method === 'POST') {
      const body = await readJsonBody(req).catch(() => ({}));
      const data = this.engine.startBatchAnalyzeStickers({
        concurrency: Number(body.concurrency || 3)
      });
      sendJson(res, 200, { ok: true, data });
      return;
    }

    if (pathname === '/api/stickers/batch-status' && method === 'GET') {
      sendJson(res, 200, { ok: true, data: this.engine.getBatchAnalyzeStatus() });
      return;
    }

    if (pathname === '/api/stickers' && method === 'POST') {
      const body = await readJsonBody(req);
      const b64 = String(body.imageBase64 || '').replace(/^data:[^;]+;base64,/, '');
      if (!b64) {
        sendJson(res, 400, { ok: false, error: '缺少图片数据' });
        return;
      }
      const buf = Buffer.from(b64, 'base64');
      const det = detectImageMime(buf);
      if (!det) {
        sendJson(res, 400, { ok: false, error: '不支持的图片格式（请上传 PNG/JPG/GIF/WebP）' });
        return;
      }
      const resAdd = this.engine.stickerStore.addSticker({
        buffer: buf,
        ext: det.ext,
        mimeType: det.mimeType,
        tags: body.tags || '表情',
        source: 'hub-upload'
      });
      sendJson(res, 200, { ok: true, data: resAdd });
      return;
    }

    const stickerFileMatch = pathname.match(/^\/api\/stickers\/(\d+)\/file$/);
    if (stickerFileMatch && method === 'GET') {
      const row = this.engine.stickerStore.getById(Number(stickerFileMatch[1]));
      if (!row) {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }
      const buf = this.engine.stickerStore.readBuffer(row);
      if (!buf) {
        res.writeHead(404);
        res.end('File missing');
        return;
      }
      res.writeHead(200, {
        'Content-Type': row.mime_type || 'image/png',
        'Cache-Control': 'public, max-age=3600'
      });
      res.end(buf);
      return;
    }

    const stickerIdMatch = pathname.match(/^\/api\/stickers\/(\d+)$/);
    if (stickerIdMatch && method === 'PATCH') {
      const body = await readJsonBody(req);
      const id = Number(stickerIdMatch[1]);
      const hasMemeFields =
        body.category !== undefined ||
        body.captionOcr !== undefined ||
        body.vibe !== undefined ||
        body.useWhen !== undefined ||
        body.avoidWhen !== undefined;
      const updated = hasMemeFields
        ? this.engine.stickerStore.updateMemeCard(id, body)
        : this.engine.stickerStore.updateTags(id, body.tags || '');
      if (!updated) {
        sendJson(res, 404, { ok: false, error: '表情不存在' });
        return;
      }
      sendJson(res, 200, { ok: true, data: updated });
      return;
    }

    if (stickerIdMatch && method === 'DELETE') {
      const removed = this.engine.stickerStore.deleteSticker(Number(stickerIdMatch[1]));
      sendJson(res, 200, { ok: true, removed });
      return;
    }

    // Living Lorebook (Worldbook) endpoints
    if (pathname === '/api/lorebook' && method === 'GET') {
      const query = urlObj.searchParams.get('q') || '';
      const category = urlObj.searchParams.get('category') || 'all';
      const scope = urlObj.searchParams.get('scope') || 'all';
      const status = urlObj.searchParams.get('status') || 'all';
      const items = this.engine.lorebookStore.list({ query, category, scope, status, limit: 300 });
      const stats = this.engine.lorebookStore.getStats();
      sendJson(res, 200, { ok: true, data: { items, stats } });
      return;
    }

    if (pathname === '/api/lorebook' && method === 'POST') {
      const body = await readJsonBody(req);
      const entry = this.engine.lorebookStore.addEntry({
        title: body.title || '',
        category: body.category || '网络热梗',
        scope: body.scope || 'global',
        keys: body.keys || [],
        secondaryKeys: body.secondaryKeys || [],
        selectiveLogic: body.selectiveLogic || 'AND_ANY',
        content: body.content || '',
        constant: Boolean(body.constant),
        enabled: body.enabled !== false,
        approved: body.approved !== false,
        priority: body.priority ?? 100,
        source: 'hub-manual',
        createdBy: 'owner'
      });
      this.engine.emit('status-change');
      sendJson(res, 200, { ok: true, data: entry });
      return;
    }

    if (pathname === '/api/lorebook/test-match' && method === 'POST') {
      const body = await readJsonBody(req);
      const l1 = this.engine.lorebookStore.matchForTurn({
        text: body.text || '',
        scope: body.scope || 'global',
        sessionKey: '',
        currentTurn: 1,
        ignoreCooldown: true,
        recordHits: false
      });
      const cfg = this.configStore.get();
      const l2 = this.engine.memeWikiStore.matchForTurn({
        text: body.text || '',
        sessionKey: '',
        currentTurn: 1,
        l1MatchedTitles: l1.entries.map((e) => e.title),
        l1MatchedKeys: l1.entries.flatMap((e) => e.matchedKeys || []),
        wakeWords: [cfg.acp?.persona?.name || '', ...(cfg.guard?.triggerKeywords || [])].filter(Boolean),
        ignoreCooldown: true
      });
      const combinedPrompt = [l1.promptBlock, l2.promptBlock].filter(Boolean).join('\n\n');
      sendJson(res, 200, {
        ok: true,
        data: {
          ...l1,
          memewikiEntries: l2.entries,
          memewikiPromptBlock: l2.promptBlock,
          promptBlock: combinedPrompt
        }
      });
      return;
    }

    // L2 Read-only Public MemeWiki endpoints
    if (pathname === '/api/memewiki' && method === 'GET') {
      const q = urlObj.searchParams.get('q') || '';
      const limit = Number(urlObj.searchParams.get('limit') || 20);
      const offset = Number(urlObj.searchParams.get('offset') || 0);
      const resData = this.engine.memeWikiStore.search({ query: q, limit, offset });
      sendJson(res, 200, {
        ok: true,
        data: {
          stats: this.engine.memeWikiStore.getStats(),
          ...resData
        }
      });
      return;
    }

    if (pathname === '/api/memewiki/sync' && method === 'GET') {
      sendJson(res, 200, { ok: true, data: this.engine.memeWikiStore.getStats() });
      return;
    }

    if (pathname === '/api/memewiki/sync' && method === 'POST') {
      const body = await readJsonBody(req).catch(() => ({}));
      const mode = body.mode === 'full' ? 'full' : 'no-existing';
      const result = this.engine.memeWikiStore.startIncrementalSync({
        mode,
        proxyUrl: this.engine.proxyInfo?.proxyUrl || '',
        onDone: () => this.engine.emit('status-change')
      });
      sendJson(res, result.ok ? 200 : 409, { ok: result.ok, data: result, error: result.error });
      return;
    }

    if (pathname === '/api/memewiki/promote' && method === 'POST') {
      const body = await readJsonBody(req);
      const title = String(body.title || '').trim();
      const row = this.engine.memeWikiStore.getByTitle(title);
      if (!row) {
        sendJson(res, 404, { ok: false, error: `梗百科中未找到「${title}」` });
        return;
      }
      const keys = [
        row.title,
        ...String(row.aliases || '')
          .split(/[,，、|]+/)
          .map((s) => s.trim())
          .filter(Boolean)
      ];
      const usage = String(row.usage || '').replace(/\s+/g, ' ').trim().slice(0, 260);
      const origin = String(row.summary || row.origin || '').replace(/\s+/g, ' ').trim().slice(0, 180);
      const content = [usage ? `用法：${usage}` : '', origin ? `出处：${origin}` : ''].filter(Boolean).join('；');
      const created = this.engine.lorebookStore.addEntry({
        title: row.title,
        category: '网络热梗',
        scope: String(body.scope || 'global').trim() || 'global',
        keys,
        content: content || row.title,
        source: 'memewiki-promote',
        createdBy: 'hub',
        approved: true
      });
      this.engine.emit('status-change');
      sendJson(res, 200, { ok: true, data: created });
      return;
    }

    if (pathname === '/api/lorebook/export/st' && method === 'GET') {
      const scope = urlObj.searchParams.get('scope') || '';
      const exported = this.engine.lorebookStore.exportSillyTavernJson({ scope });
      const body = Buffer.from(JSON.stringify(exported, null, 2), 'utf8');
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': 'attachment; filename="agyqq-lorebook-sillytavern.json"',
        'Content-Length': body.length
      });
      res.end(body);
      return;
    }

    if (pathname === '/api/lorebook/import/st' && method === 'POST') {
      const body = await readJsonBody(req);
      const payload = body.json ?? body.data ?? body;
      const stats = this.engine.lorebookStore.importSillyTavernJson(payload, {
        defaultScope: body.defaultScope || 'global',
        defaultCategory: body.defaultCategory || '知识百科'
      });
      this.engine.emit('status-change');
      sendJson(res, 200, { ok: true, data: stats });
      return;
    }

    const loreIdMatch = pathname.match(/^\/api\/lorebook\/(\d+)$/);
    if (loreIdMatch && method === 'PATCH') {
      const body = await readJsonBody(req);
      const updated = this.engine.lorebookStore.updateEntry(Number(loreIdMatch[1]), body);
      if (!updated) {
        sendJson(res, 404, { ok: false, error: '世界书词条不存在' });
        return;
      }
      this.engine.emit('status-change');
      sendJson(res, 200, { ok: true, data: updated });
      return;
    }

    if (loreIdMatch && method === 'DELETE') {
      const removed = this.engine.lorebookStore.deleteEntry(Number(loreIdMatch[1]));
      this.engine.emit('status-change');
      sendJson(res, 200, { ok: true, removed });
      return;
    }

    // Playground simulator endpoint
    if (pathname === '/api/simulate' && method === 'POST') {
      const body = await readJsonBody(req);
      const b64 = String(body.imageBase64 || '').replace(/^data:[^;]+;base64,/, '');
      const result = await this.engine.simulateTurn({
        scene: body.scene || 'group',
        userId: body.userId || '10001',
        groupId: body.groupId || '90001',
        text: body.text || '',
        imageBase64: b64,
        requestVoice: Boolean(body.requestVoice)
      });
      sendJson(res, 200, { ok: true, data: result });
      return;
    }

    sendJson(res, 404, { ok: false, error: `未找到 API 路由: ${pathname}` });
  }

  _serveStatic(req, res, urlObj) {
    let relPath = urlObj.pathname === '/' ? '/index.html' : urlObj.pathname;
    relPath = decodeURIComponent(relPath);
    const fullPath = path.resolve(PUBLIC_DIR, '.' + relPath);
    if (!fullPath.startsWith(PUBLIC_DIR) || !fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(fullPath).toLowerCase();
    const mime = MIME_MAP[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
    fs.createReadStream(fullPath).pipe(res);
  }

  async start() {
    const cfg = this.configStore.get().hub;
    this.server = http.createServer(async (req, res) => {
      try {
        const urlObj = new URL(req.url || '/', `http://${cfg.host}:${cfg.port}`);
        if (urlObj.pathname.startsWith('/api/')) {
          await this._handleApi(req, res, urlObj);
        } else {
          // If user opens /?token=xxx, set HttpOnly cookie and serve UI cleanly
          const qToken = urlObj.searchParams.get('token');
          if (qToken && qToken === cfg.token) {
            res.setHeader(
              'Set-Cookie',
              `agy_hub_token=${encodeURIComponent(cfg.token)}; Path=/; HttpOnly; SameSite=Strict`
            );
          }
          this._serveStatic(req, res, urlObj);
        }
      } catch (err) {
        sendJson(res, 500, { ok: false, error: err.message || 'Internal Server Error' });
      }
    });

    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(cfg.port, cfg.host, () => resolve());
    });
    return {
      host: cfg.host,
      port: cfg.port,
      url: `http://${cfg.host}:${cfg.port}/?token=${cfg.token}`
    };
  }

  async stop() {
    for (const res of this.sseClients) {
      try { res.end(); } catch {}
    }
    this.sseClients.clear();
    if (this.server) {
      await new Promise((resolve) => this.server.close(() => resolve()));
      this.server = null;
    }
  }
}
