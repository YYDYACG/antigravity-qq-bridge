import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { resolveProxyUrl } from '../config/proxy-detect.js';
import { SessionManager } from '../acp/session-manager.js';
import { OwnerGuard } from '../guard/owner-guard.js';
import { SmartMergeWindow } from '../guard/merge-window.js';
import { RateLimiter, splitNaturalChunks } from '../guard/rate-limiter.js';
import { OneBotClient } from '../onebot/client.js';
import { NapCatManager } from '../onebot/napcat-manager.js';
import { parseOneBotMessageEvent } from '../onebot/message-parser.js';
import { resolveForwardMessages } from '../onebot/forward-resolver.js';
import { VisionFetcher, extractLocalGifPaths, buildAnimatedStoryboardHint } from '../media/vision-fetcher.js';
import { BilibiliResolver } from '../media/bilibili-resolver.js';
import { SoVitsClient } from '../tts/sovits-client.js';
import {
  parseAssistantReply,
  normalizeEmotion,
  sanitizeVoiceText,
  isGoodForSpontaneousVoice,
  hasSpontaneousVoiceCue
} from '../tts/reply-parser.js';
import { StickerStore } from '../stickers/sticker-store.js';
import { VisionStickerCurator } from '../stickers/vision-curator.js';
import { LorebookStore, resolveCanonicalScope, detectPromptInjection } from '../lorebook/lorebook-store.js';
import { MemeWikiStore } from '../lorebook/memewiki-store.js';
import { TokenStore } from '../metrics/token-store.js';
import path from 'node:path';

const AMBIENT_TTL_MS = 6 * 60 * 60 * 1000;
const BACKREF_VISUAL_CUE_RE =
  /(?:上面|前面|刚才|刚刚|这张|那张|这图|那图|这俩|那俩|什么梗|啥梗|什么意思|啥意思|怎么看|啥情况|什么情况|看不懂|解释一下|讲讲|说说|谁呀|哪位|他|她|他们|她们)/;

function formatAmbientClock(ts) {
  const d = new Date(Number(ts) || Date.now());
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

export class BridgeEngine extends EventEmitter {
  constructor({ rootDir, configStore }) {
    super();
    this.rootDir = rootDir;
    this.configStore = configStore;

    this.tokenStore = new TokenStore(path.join(rootDir, 'data', 'metrics.db'));
    this.stickerStore = new StickerStore(rootDir, configStore);
    this.lorebookStore = new LorebookStore(rootDir, configStore);
    this.memeWikiStore = new MemeWikiStore(rootDir, configStore);
    this.ownerGuard = new OwnerGuard(configStore, {
      readonlyAllowedFiles: [this.stickerStore.catalogPath, this.lorebookStore.catalogPath]
    });
    this.visionFetcher = new VisionFetcher(configStore, rootDir);
    this.bilibiliResolver = new BilibiliResolver(configStore);
    this.sovitsClient = new SoVitsClient(configStore, rootDir);
    this.onebotClient = new OneBotClient(configStore);
    this.napcatManager = new NapCatManager(rootDir);
    this.rateLimiter = new RateLimiter(configStore);

    this.sessionManager = null;
    this.visionCurator = null;
    this.proxyInfo = { proxyUrl: '', source: 'unresolved' };
    this.running = false;
    this.paused = false;
    this.startedAt = null;
    this.ttsHealthTimer = null;
    this.logs = [];
    this.maxLogs = 250;
    this.groupAmbientBuffer = new Map(); // groupId -> [{ senderName, userId, text, hasImage, ts }]
    this.botSentMessageIds = new Set(); // recent message_ids sent by this bot (for instant reply-to-self detection)
    this._quoteCache = new Map(); // messageId -> { raw, ts }
    this.lastAutoVoiceAt = new Map(); // sessionKey -> last spontaneous/ai voice timestamp
    this._voiceQueue = Promise.resolve(); // serialized async GPU synthesis + post-text voice delivery queue

    this.mergeWindow = new SmartMergeWindow({
      getWindowMs: () => (this.configStore.get().guard.mergeWindowSec ?? 2.5) * 1000,
      getDedupWindowMs: () => (this.configStore.get().guard.dedupWindowSec ?? 90) * 1000,
      onFlush: (batch) => this._handleMergedBatch(batch)
    });

    this._wireEvents();
  }

  _log(level, source, message, extra = null) {
    const entry = {
      ts: Date.now(),
      level,
      source,
      message,
      ...(extra ? { extra } : {})
    };
    this.logs.unshift(entry);
    if (this.logs.length > this.maxLogs) this.logs.length = this.maxLogs;
    this.emit('log', entry);
    const prefix = `[${new Date(entry.ts).toLocaleTimeString('zh-CN', { hour12: false })}][${level.toUpperCase()}][${source}]`;
    if (level === 'error') console.error(prefix, message);
    else if (level === 'warn') console.warn(prefix, message);
    else if (level !== 'debug') console.log(prefix, message);
  }

  _wireEvents() {
    this.onebotClient.on('log', (e) => this._log(e.level, 'onebot', e.message));
    this.onebotClient.on('connected', () => {
      this.emit('status-change');
      if (this.configStore.get().stickers.enabled) {
        setTimeout(() => {
          this.syncQqFavoriteStickers({ silent: true }).catch(() => {});
        }, 1500);
      }
    });
    this.onebotClient.on('disconnected', () => this.emit('status-change'));
    this.onebotClient.on('message', (msg) => {
      this._handleIncomingMessage(msg).catch((err) => {
        this._log('error', 'engine', `处理消息异常: ${err.message}`);
      });
    });

    this.sovitsClient.on('log', (e) => this._log(e.level, 'sovits', e.message));
    this.sovitsClient.on('prewarmed', () => this.emit('status-change'));
  }

  async start() {
    if (this.running) return;
    const cfg = this.configStore.get();
    this.proxyInfo = await resolveProxyUrl(cfg.network.proxyUrl);
    this._log(
      'info',
      'engine',
      this.proxyInfo.proxyUrl
        ? `网络代理已就绪: ${this.proxyInfo.proxyUrl} (${this.proxyInfo.source})`
        : `未启用代理，直连模式 (${this.proxyInfo.source})`
    );

    this.sessionManager = new SessionManager({
      rootDir: this.rootDir,
      configStore: this.configStore,
      ownerGuard: this.ownerGuard,
      tokenStore: this.tokenStore,
      stickerStore: this.stickerStore,
      lorebookStore: this.lorebookStore,
      memeWikiStore: this.memeWikiStore,
      proxyUrl: this.proxyInfo.proxyUrl
    });
    this.visionCurator = new VisionStickerCurator({
      configStore: this.configStore,
      sessionManager: this.sessionManager,
      stickerStore: this.stickerStore
    });
    this.sessionManager.on('log', (e) => this._log(e.level, e.worker || 'acp', e.message));
    this.sessionManager.on('permission', (e) => {
      this._log(
        e.allowed ? 'info' : 'warn',
        'owner-guard',
        `${e.allowed ? '放行' : '拦截'} ACP 工具调用: ${e.toolName} (${e.worker}, ${e.reason})`
      );
      this.emit('status-change');
    });
    this.sessionManager.on('worker-ready', () => this.emit('status-change'));
    this.sessionManager.on('compacted', () => this.emit('status-change'));

    // Start ACP persistent workers (non-blocking error capture so Hub still stays online)
    try {
      await this.sessionManager.start();
    } catch (err) {
      this._log('error', 'acp', `ACP 引擎初始化失败（可在 Hub 重试）: ${err.message}`);
    }

    // Probe GPT-SoVITS v5 & trigger background CUDA prewarm when online
    const ttsHealth = await this.sovitsClient.probeHealth();
    this._log(
      ttsHealth.online ? 'info' : 'warn',
      'sovits',
      ttsHealth.online
        ? `GPT-SoVITS v5 已连通: ${ttsHealth.baseUrl} (${ttsHealth.probeMs}ms)`
        : `GPT-SoVITS v5 当前离线 (${ttsHealth.baseUrl})，可稍后在 Hub 一键启动`
    );
    if (ttsHealth.online && cfg.tts.enabled && cfg.tts.prewarmOnStart) {
      this.sovitsClient.prewarm().catch(() => {});
    }

    // Probe NapCatQQ project-local status
    const ncStatus = await this.napcatManager.probeStatus();
    if (ncStatus.installed) {
      this._log(
        ncStatus.webuiOnline ? 'info' : 'warn',
        'napcat',
        ncStatus.webuiOnline
          ? `项目内置 NapCatQQ 已在线，扫码面板: ${ncStatus.webuiUrl}`
          : `项目内置 NapCatQQ 未运行，可在 Hub 点击「启动 NapCatQQ」一键拉起`
      );
    }

    if (this.ttsHealthTimer) clearInterval(this.ttsHealthTimer);
    this.ttsHealthTimer = setInterval(() => {
      const wasOnline = this.sovitsClient.online;
      Promise.all([
        this.sovitsClient.probeHealth().catch(() => null),
        this.napcatManager.probeStatus().catch(() => null)
      ]).then(([ttsRes]) => {
        const curCfg = this.configStore.get();
        if (ttsRes?.online && !wasOnline && curCfg.tts.enabled && curCfg.tts.prewarmOnStart && !this.sovitsClient.prewarmed) {
          this.sovitsClient.prewarm().catch(() => {});
        }
        this.emit('status-change');
      });
    }, 15000);

    await this.onebotClient.start();
    this.running = true;
    this.paused = false;
    this.startedAt = Date.now();
    this.emit('status-change');
    this._log('info', 'engine', 'Antigravity QQ Bridge 守护引擎已启动');
  }

  async stop() {
    this.running = false;
    this.mergeWindow.clearAll();
    if (this.ttsHealthTimer) {
      clearInterval(this.ttsHealthTimer);
      this.ttsHealthTimer = null;
    }
    await this.onebotClient.stop();
    if (this.sessionManager) {
      await this.sessionManager.stop();
    }
    this.emit('status-change');
    this._log('info', 'engine', 'Antigravity QQ Bridge 守护引擎已停止');
  }

  async restartOneBot() {
    await this.onebotClient.stop();
    await this.onebotClient.start();
    this.emit('status-change');
  }

  setPaused(flag) {
    this.paused = Boolean(flag);
    this._log('info', 'engine', this.paused ? '已暂停自动响应 QQ 消息' : '已恢复自动响应 QQ 消息');
    this.emit('status-change');
  }

  _extractCommand(text) {
    const t = String(text || '').trim();
    if (!t.startsWith('/')) return null;
    const parts = t.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const argsText = t.slice(parts[0].length).trim();
    const recognized = [
      '/new',
      '/reset',
      '/压缩',
      '/compact',
      '/安静',
      '/闭麦',
      '/潜水',
      '/status',
      '/存表情',
      '/表情库',
      '/救大命',
      '/语音',
      '/记梗',
      '/记黑话',
      '/记词条',
      '/查书',
      '/世界书',
      '/删词条'
    ];
    if (!recognized.includes(cmd)) return null;
    return { cmd, argsText, args: parts.slice(1) };
  }

  _rememberBotMessage(sendRes) {
    const id = sendRes?.message_id ?? sendRes?.data?.message_id;
    if (id === undefined || id === null) return;
    this.botSentMessageIds.add(String(id));
    if (this.botSentMessageIds.size > 500) {
      const first = this.botSentMessageIds.values().next().value;
      if (first !== undefined) this.botSentMessageIds.delete(first);
    }
  }

  async _getQuotedMessageCached(messageId) {
    const id = String(messageId || '').trim();
    if (!id) return null;
    const now = Date.now();
    const cached = this._quoteCache.get(id);
    if (cached && now - cached.ts < 60000) return cached.raw;
    try {
      const raw = await this.onebotClient.getMessage(id);
      this._quoteCache.set(id, { raw, ts: now });
      if (this._quoteCache.size > 100) {
        const firstKey = this._quoteCache.keys().next().value;
        if (firstKey !== undefined) this._quoteCache.delete(firstKey);
      }
      return raw;
    } catch {
      return null;
    }
  }

  _recordAmbientGroupMessage(msg) {
    if (msg.messageType !== 'group' || !msg.groupId) return;
    const maxSize = Number(this.configStore.get().guard?.groupAmbientBufferSize ?? 8);
    if (maxSize <= 0) return;
    const text = String(msg.text || '').trim();
    if (!text && !msg.images?.length && !msg.forwards?.length) return;
    const now = Number(msg.timestamp) || Date.now();
    const arr = (this.groupAmbientBuffer.get(msg.groupId) || []).filter((item) => Date.now() - item.ts < AMBIENT_TTL_MS);
    arr.push({
      senderName: msg.senderName || msg.userId || '群友',
      userId: msg.userId,
      text: text.slice(0, 220),
      hasImage: Boolean(msg.images?.length),
      images: (msg.images || []).slice(0, 2),
      links: Array.isArray(msg.links) ? msg.links.slice(0, 4) : [],
      forwards: Array.isArray(msg.forwards) ? msg.forwards.slice(0, 2) : [],
      cardImages: (msg.images || []).filter((i) => i.isCardPreview).slice(0, 1),
      ts: now
    });
    while (arr.length > maxSize) arr.shift();
    this.groupAmbientBuffer.set(msg.groupId, arr);
  }

  _drainAmbientGroupMessages(groupId) {
    if (!groupId) return [];
    const arr = this.groupAmbientBuffer.get(groupId) || [];
    this.groupAmbientBuffer.delete(groupId);
    const now = Date.now();
    return arr.filter((item) => now - item.ts < AMBIENT_TTL_MS);
  }

  async _handleIncomingMessage(msg) {
    if (this.paused) return;

    const command = this._extractCommand(msg.text);

    // Detect if a group user directly quoted/replied to one of the bot's own messages
    let isReplyToSelf = false;
    if (msg.messageType === 'group' && msg.replyToId && !msg.isAtSelf) {
      if (this.botSentMessageIds.has(String(msg.replyToId))) {
        isReplyToSelf = true;
      } else if (this.onebotClient.connected && msg.selfId) {
        const quotedRaw = await this._getQuotedMessageCached(msg.replyToId);
        const quotedSender = String(quotedRaw?.sender?.user_id || quotedRaw?.user_id || '');
        if (quotedSender && quotedSender === String(msg.selfId)) {
          isReplyToSelf = true;
        }
      }
    }

    const isAtOtherOnly =
      msg.messageType === 'group' &&
      !msg.isAtSelf &&
      Array.isArray(msg.ats) &&
      msg.ats.some((target) => target && target !== 'all' && target !== String(msg.selfId || ''));

    const decision = this.ownerGuard.evaluateIncoming({
      messageType: msg.messageType,
      userId: msg.userId,
      groupId: msg.groupId,
      isAtSelf: msg.isAtSelf,
      isReplyToSelf,
      isAtOtherOnly,
      text: msg.text,
      isCommand: Boolean(command)
    });

    // Passive 0-cost observation in whitelisted groups when not triggered:
    // 1. Keep recent group messages in local ring buffer so bot understands context once @mentioned
    // 2. Opportunistic passive sticker auto-steal
    if (!decision.allowed) {
      if (decision.passiveObserve) {
        this._recordAmbientGroupMessage(msg);
        if (msg.images.length) {
          this._autoStealStickers(msg.images, msg.text).catch(() => {});
        }
      }
      return;
    }

    // Commands execute immediately without waiting in the 2.5s merge window
    if (command) {
      await this._executeCommand(command, msg, decision);
      return;
    }

    // Deduplicate identical messages within 90s window
    if (this.mergeWindow.isDuplicate(msg.sessionKey, msg.userId, msg.text, msg.images.length > 0)) {
      this._log('debug', 'guard', `跳过 90s 内重复消息 (${msg.sessionKey})`);
      return;
    }

    const pushInfo = this.mergeWindow.push(msg.sessionKey, {
      ...msg,
      lane: decision.lane,
      isOwner: decision.isOwner,
      triggerMode: decision.triggerMode || 'open',
      activeRemainingSec: decision.activeRemainingSec || 0
    });

    if (pushInfo.merged) {
      this._log('info', 'guard', `Smart Merge Window 合流中 (${msg.sessionKey}, 当前 ${pushInfo.batchSize} 条)`);
    }
  }

  async _autoStealStickers(imagesMeta, contextText = '') {
    const cfg = this.configStore.get().stickers;
    if (!cfg.enabled || !cfg.autoSteal) return;
    const stickerImgs = imagesMeta.filter((i) => i.isSticker);
    const maxCheck = cfg.visionReviewEnabled ? 1 : 2;

    for (const meta of stickerImgs.slice(0, maxCheck)) {
      try {
        const fetched = await this.visionFetcher.fetchImageBuffer(meta, this.onebotClient);

        // Gemini visual curation mode: inspect image against stealRules & self-persona before storing!
        if (cfg.visionReviewEnabled && this.visionCurator) {
          const res = await this.visionCurator.reviewAndStore(fetched, {
            contextText,
            summary: meta.summary || '',
            source: 'gemini-steal'
          });
          if (res.skipped) {
            if (res.skipReason === 'previously-rejected') {
              this._log('debug', 'stickers', `跳过已拒图 (${fetched.sha256.slice(0, 8)}, ${res.score}/10: ${res.reason})`);
            }
            continue;
          }
          if (res.stored && !res.deduplicated) {
            this._log(
              'info',
              'stickers',
              `Gemini 鉴图通过 (${res.score}/10${res.isSelf ? ' · 认出是本喵' : ''}) 入库 #${res.sticker.id} [${res.sticker.tags}] — ${res.reason}`
            );
            // Also sync newly stolen great sticker into the bot's QQ favorite stickers!
            if (this.onebotClient.connected) {
              const fp = this.stickerStore.getFilePath(res.sticker);
              if (fp) {
                this.onebotClient.addCustomFace(fp).catch(() => {});
              }
            }
            this.emit('status-change');
          } else if (!res.approved) {
            this._log(
              'info',
              'stickers',
              `Gemini 鉴图跳过 (${res.score}/10): ${res.reason || '未达收藏标准'}`
            );
          }
          continue;
        }

        // Direct fallback steal mode (when visionReviewEnabled is off)
        const tagCandidates = [];
        if (meta.summary && !/^\[?动画表情\]?$/.test(meta.summary)) {
          tagCandidates.push(meta.summary.replace(/^\[|\]$/g, ''));
        }
        if (contextText && contextText.length <= 24) {
          tagCandidates.push(contextText);
        }
        if (!tagCandidates.length) tagCandidates.push('日常 表情');
        const res = this.stickerStore.addSticker({
          buffer: fetched.buffer,
          ext: fetched.ext,
          mimeType: fetched.originalMimeType,
          tags: tagCandidates,
          source: 'auto-steal'
        });
        if (!res.deduplicated) {
          this._log('info', 'stickers', `自动偷图入库 #${res.sticker.id} [${res.sticker.tags}] (${fetched.sha256.slice(0, 8)})`);
        }
      } catch (err) {
        this._log('debug', 'stickers', `自动偷图处理跳过: ${err.message}`);
      }
    }
  }

  async curateStickerImage({ imageBase64, contextText = '', autoSave = true }) {
    if (!this.visionCurator) {
      throw new Error('视觉鉴图引擎尚未启动');
    }
    const fetched = await this.visionFetcher.fetchImageBuffer({ base64: imageBase64 });
    if (autoSave) {
      const res = await this.visionCurator.reviewAndStore(fetched, {
        contextText,
        source: 'hub-gemini-curate',
        bypassCooldown: true,
        bypassCache: true
      });
      this.emit('status-change');
      return res;
    }
    return this.visionCurator.reviewImage(fetched, {
      contextText,
      bypassCooldown: true,
      bypassCache: true
    });
  }

  async syncQqFavoriteStickers({ count = 200, silent = false } = {}) {
    if (!this.onebotClient.connected) {
      if (silent) return { total: 0, imported: 0, updated: 0, failed: 0, offline: true };
      throw new Error('NapCatQQ OneBot 尚未连接，无法同步 QQ 收藏表情');
    }

    const items = await this.onebotClient.fetchCustomFaceDetail(count);
    let imported = 0;
    let updated = 0;
    let failed = 0;

    for (const item of items) {
      try {
        let fetched = null;
        if (item.emoPath && fs.existsSync(item.emoPath)) {
          fetched = await this.visionFetcher.fetchImageBuffer({ file: item.emoPath }, null);
        } else if (item.url) {
          fetched = await this.visionFetcher.fetchImageBuffer({ url: item.url }, this.onebotClient);
        }
        if (!fetched) {
          failed += 1;
          continue;
        }

        const rawDesc = String(item.desc || item.modifyWord || item.ocrWord || '').trim();
        const tags = rawDesc ? [rawDesc] : ['QQ收藏表情'];
        const selfName = this.configStore.get().acp?.persona?.name || '星喵';
        const isSelf = new RegExp(`${selfName}|星喵|星猫|双子|gemini`, 'i').test(rawDesc);

        const res = this.stickerStore.addSticker({
          buffer: fetched.buffer,
          ext: fetched.ext,
          mimeType: fetched.originalMimeType || fetched.mimeType,
          tags,
          source: 'qq-favorite',
          isSelf
        });
        if (res.deduplicated) updated += 1;
        else imported += 1;
      } catch {
        failed += 1;
      }
    }

    this._log(
      'info',
      'stickers',
      `已同步 QQ 收藏表情: 共 ${items.length} 张 (新增 ${imported}, 已有/合并 ${updated}, 跳过 ${failed})`
    );
    this.emit('status-change');
    return { total: items.length, imported, updated, failed };
  }

  startBatchAnalyzeStickers({ concurrency = 3 } = {}) {
    if (!this.visionCurator) {
      throw new Error('视觉鉴图引擎尚未启动');
    }
    const cur = this.visionCurator.getBatchStatus();
    if (cur.running) {
      return { alreadyRunning: true, ...cur };
    }
    this._log('info', 'stickers', '开始批量识图生成表情包多维度档案...');
    this.visionCurator
      .batchAnalyzeMissing({
        visionFetcher: this.visionFetcher,
        concurrency,
        onProgress: (st, row) => {
          if (st.done % 5 === 0 || st.done === st.total) {
            this._log(
              'info',
              'stickers',
              `表情维度建卡进度: ${st.done}/${st.total} (成功 ${st.succeeded}, 失败 ${st.failed}, 最新 #${row.id})`
            );
            this.emit('status-change');
          }
        }
      })
      .then((finalSt) => {
        this._log(
          'info',
          'stickers',
          `批量多维度建卡完成: 成功 ${finalSt.succeeded}/${finalSt.total}，已更新 sticker-catalog.md`
        );
        this.emit('status-change');
      })
      .catch((err) => {
        this._log('error', 'stickers', `批量建卡异常: ${err.message}`);
      });

    return { started: true, ...this.visionCurator.getBatchStatus() };
  }

  getBatchAnalyzeStatus() {
    return this.visionCurator ? this.visionCurator.getBatchStatus() : { running: false, total: 0, done: 0 };
  }

  async _executeCommand(command, msg, decision) {
    const replyTarget = {
      messageType: msg.messageType,
      userId: msg.userId,
      groupId: msg.groupId
    };

    switch (command.cmd) {
      case '/new':
      case '/reset': {
        if (msg.messageType === 'group' && msg.groupId) {
          this.ownerGuard.deactivateGroup(msg.groupId);
          this.groupAmbientBuffer.delete(msg.groupId);
        }
        const existed = this.sessionManager ? await this.sessionManager.resetSession(msg.sessionKey) : false;
        await this.onebotClient.sendText({
          ...replyTarget,
          text: existed ? '已清空当前会话上下文记忆，重新开始聊吧~' : '当前还没有活跃上下文，直接和我聊就行~'
        });
        return;
      }

      case '/安静':
      case '/闭麦':
      case '/潜水': {
        if (msg.messageType === 'group' && msg.groupId) {
          this.ownerGuard.deactivateGroup(msg.groupId);
        }
        await this.onebotClient.sendText({
          ...replyTarget,
          text: '好哒，本喵先乖乖潜水啦，有事再 @我 喵~'
        });
        return;
      }

      case '/压缩':
      case '/compact': {
        if (!this.sessionManager) {
          await this.onebotClient.sendText({ ...replyTarget, text: 'ACP 引擎尚未启动喵~' });
          return;
        }
        const info = await this.sessionManager.compactSession(msg.sessionKey, {
          mode: 'compact',
          reason: 'manual-command'
        });
        if (!info.compacted) {
          await this.onebotClient.sendText({ ...replyTarget, text: '当前还没有活跃会话可以压缩，直接和我聊就行喵~' });
          return;
        }
        await this.onebotClient.sendText({
          ...replyTarget,
          text: `星喵整理好《前情记忆交接单》啦喵~ 已释放原 ${info.prevContextUsed} tokens，保留 ${info.summaryChars} 字前情摘要 + 最近 ${info.carriedTurns} 轮原话，接下来继续自然聊就行！`
        });
        return;
      }

      case '/status': {
        const acpStatus = this.sessionManager?.getStatus();
        const worker = decision.lane === 'owner' ? acpStatus?.ownerWorker : acpStatus?.groupWorker;
        const sess = this.sessionManager?.getSessionInfo(msg.sessionKey);
        const ttsSt = this.sovitsClient.getStatus();
        const stkSt = this.stickerStore.getStats();
        const loreSt = this.lorebookStore.getStats();
        const memeSt = this.memeWikiStore.getStats();
        const cfg = this.configStore.get();
        const budget = cfg.acp.contextBudgetTokens || 0;
        const budgetLabel = budget > 0 ? `${Math.round(budget / 1000)}K (${cfg.acp.contextOverflowAction})` : '不限';
        const grpAct = msg.messageType === 'group' ? this.ownerGuard.getGroupActiveStatus(msg.groupId) : null;
        const trollLabel = cfg.memewiki?.trollModeEnabled !== false ? `${cfg.memewiki?.trollLevel ?? 100}/100` : '模型自决';
        const lines = [
          `[Antigravity QQ Bridge 状态]`,
          `通道模式: ${decision.lane === 'owner' ? '主人私聊 (工具已隔离授权)' : '群聊安全沙盒 (禁用本机工具)'}`,
          ...(grpAct
            ? [
                `群聊活跃: ${grpAct.active ? `活跃跟聊中 (剩余 ${grpAct.remainingSec}s, 续聊 ${grpAct.activeReplies}/${grpAct.maxReplies})` : `潜水待机 (被@后保持 ${grpAct.windowSec}s)`}`
              ]
            : []),
          `当前模型: ${sess?.model || (decision.lane === 'owner' ? cfg.acp.ownerModel : cfg.acp.groupModel)}`,
          `ACP 通道: ${worker?.ready ? `在线 (PID ${worker.pid}, 延迟 ${worker.lastLatencyMs ?? '-'}ms)` : '未就绪'}`,
          `会话记忆: ${sess ? `${sess.turnCount} 轮 (${sess.contextUsed || 0} / ${budgetLabel} tokens)` : `新会话 (预算 ${budgetLabel})`}`,
          `语音引擎: ${ttsSt.online ? `GPT-SoVITS 在线 (缓存命中率 ${ttsSt.cache.hitRate}%)` : '离线'}`,
          `表情包库: ${stkSt.count} 张 (${stkSt.totalMb} MB, ${stkSt.ngramCount} 索引词)`,
          `世界书库: L1 ${loreSt.enabled} 条生效 (🔵${loreSt.constant} 常驻 / 🟢${loreSt.keywordCount} 关键词 / 命中 ${loreSt.totalHits} 次) | L2 梗百科 ${memeSt.count} 条 (串子 ${trollLabel})`
        ];
        await this.onebotClient.sendText({ ...replyTarget, text: lines.join('\n') });
        return;
      }

      case '/存表情': {
        const tags = command.args;
        if (!tags.length) {
          await this.onebotClient.sendText({
            ...replyTarget,
            text: '用法：附带图片或引用带图消息发送「/存表情 摸鱼 奶茶」'
          });
          return;
        }
        let targetImages = [...msg.images];
        if (!targetImages.length && msg.replyToId) {
          try {
            const quoted = await this.onebotClient.getMessage(msg.replyToId);
            const parsedQuoted = parseOneBotMessageEvent(quoted);
            targetImages = parsedQuoted.images;
          } catch {}
        }
        if (!targetImages.length) {
          await this.onebotClient.sendText({
            ...replyTarget,
            text: '没找到要存的图片呀，请附带图片或引用一张图片再发 /存表情 标签'
          });
          return;
        }
        try {
          const fetched = await this.visionFetcher.fetchImageBuffer(targetImages[0], this.onebotClient);
          const added = this.stickerStore.addSticker({
            buffer: fetched.buffer,
            ext: fetched.ext,
            mimeType: fetched.originalMimeType,
            tags,
            source: 'command'
          });
          await this.onebotClient.sendText({
            ...replyTarget,
            text: added.deduplicated
              ? `这张图已在库里啦 (#${added.sticker.id})，已合并标签：${added.sticker.tags}`
              : `SHA-256 查重入库成功 (#${added.sticker.id})，2-gram 索引已就绪：${added.sticker.tags}`
          });
        } catch (err) {
          await this.onebotClient.sendText({ ...replyTarget, text: `存表情失败: ${err.message}` });
        }
        return;
      }

      case '/表情库': {
        const stats = this.stickerStore.getStats();
        const items = this.stickerStore.list({ query: command.argsText, limit: 8 });
        const preview = items.length
          ? items.map((s) => `#${s.id} [${s.tags || '无标签'}]`).join(' | ')
          : '暂无匹配表情';
        await this.onebotClient.sendText({
          ...replyTarget,
          text: `表情库共 ${stats.count} 张 (${stats.totalMb}MB)：${preview}`
        });
        return;
      }

      case '/救大命': {
        const picked =
          this.stickerStore.pickForReply({
            sessionKey: msg.sessionKey,
            queryText: '救大命 震惊 绷不住 救命',
            bypassCooldown: true
          }) || this.stickerStore.pickRandom();
        if (picked?.buffer) {
          await this.onebotClient.sendImageBuffer({ ...replyTarget, buffer: picked.buffer });
        } else {
          await this.onebotClient.sendText({ ...replyTarget, text: '表情库还是空的，先发「/存表情 救大命」投喂我几张吧~' });
        }
        return;
      }

      case '/语音': {
        const rawArg = command.argsText;
        if (!rawArg) {
          await this.onebotClient.sendText({ ...replyTarget, text: '用法：/语音 [情绪] 想听的话，例如：/语音 温柔 主人早安' });
          return;
        }
        const firstWord = command.args[0] || '';
        const maybeEmo = ['平静', '温柔', '开心', '调皮', '委屈', '疑问'].includes(firstWord) ? firstWord : null;
        const spokenText = maybeEmo ? rawArg.slice(firstWord.length).trim() : rawArg;
        const emotion = maybeEmo || this.configStore.get().tts.defaultEmotion;
        try {
          const synth = await this.sovitsClient.synthesize({ text: spokenText, emotion });
          await this.onebotClient.sendVoiceBuffer({ ...replyTarget, buffer: synth.buffer });
          if (this.configStore.get().tts.dualTrack) {
            await this.onebotClient.sendText({
              ...replyTarget,
              text: `♪ [${synth.emotion}${synth.cached ? ' · 秒回缓存' : ''}] ${spokenText}`
            });
          }
        } catch (err) {
          await this.onebotClient.sendText({ ...replyTarget, text: `语音合成失败: ${err.message}` });
        }
        return;
      }

      case '/记梗':
      case '/记黑话':
      case '/记词条': {
        const rawArg = command.argsText;
        const parts = rawArg
          .split(/[|｜]/)
          .map((s) => s.trim())
          .filter(Boolean);
        if (parts.length < 2) {
          await this.onebotClient.sendText({
            ...replyTarget,
            text: '用法：/记梗 关键词1,关键词2 | 释义（示例：/记梗 曼波,mambo | 赛马娘诗歌剧魔性口头禅改编热梗）'
          });
          return;
        }
        const defaultCat = command.cmd === '/记黑话' ? '群友黑话' : '网络热梗';
        let scope =
          command.cmd === '/记黑话' || msg.messageType === 'group'
            ? resolveCanonicalScope({ messageType: msg.messageType, groupId: msg.groupId, userId: msg.userId })
            : 'global';
        let category = defaultCat;
        let keysStr = parts[0];
        let content = parts.slice(1).join(' | ');
        if (parts.length >= 3 && /^(全局|global|本群|local|私聊)$/i.test(parts[0])) {
          if (/^(全局|global)$/i.test(parts[0])) {
            scope = msg.messageType === 'group' && !decision.isOwner ? scope : 'global';
          }
          keysStr = parts[1];
          content = parts.slice(2).join(' | ');
        }
        const inj = detectPromptInjection(`${keysStr} ${content}`);
        if (inj.flagged) {
          await this.onebotClient.sendText({ ...replyTarget, text: '检测到疑似越权指令内容，世界书已拒绝收录喵~' });
          return;
        }
        try {
          const entry = this.lorebookStore.addEntry({
            category,
            scope,
            keys: keysStr,
            content,
            source: 'command',
            createdBy: msg.senderName || msg.userId,
            approved: decision.isOwner || !this.configStore.get().lorebook?.groupRequireApproval
          });
          await this.onebotClient.sendText({
            ...replyTarget,
            text: `已收录进世界书 #${entry.id} [${entry.category} · ${entry.scope}] 关键词: ${entry.keys.join(', ')}${entry.approved ? '' : '（已入待审区）'}`
          });
          this.emit('status-change');
        } catch (err) {
          await this.onebotClient.sendText({ ...replyTarget, text: `记录失败: ${err.message}` });
        }
        return;
      }

      case '/查书':
      case '/世界书': {
        const chatScope = resolveCanonicalScope({ messageType: msg.messageType, groupId: msg.groupId, userId: msg.userId });
        const items = this.lorebookStore.listForChatScope({
          scope: chatScope,
          query: command.argsText,
          limit: 10
        });
        if (!items.length) {
          await this.onebotClient.sendText({
            ...replyTarget,
            text: command.argsText
              ? `世界书里没查到「${command.argsText}」相关词条，直接问我我可以联网查并记住喵~`
              : '世界书目前还没有生效词条，聊天遇到新梗我会自动记住，也可以用 /记梗 关键词 | 解释 手动添加喵~'
          });
          return;
        }
        const lines = items.map(
          (e) =>
            `#${e.id} ${e.constant ? '🔵' : '🟢'}[${e.category}] ${e.title} (${e.keys.slice(0, 3).join(',')})：${e.content.slice(0, 48)}`
        );
        await this.onebotClient.sendText({
          ...replyTarget,
          text: `[世界书词条 (${items.length})]\n${lines.join('\n')}`
        });
        return;
      }

      case '/删词条': {
        const id = Number(String(command.args[0] || '').replace(/^#/, ''));
        if (!Number.isInteger(id) || id <= 0) {
          await this.onebotClient.sendText({ ...replyTarget, text: '用法：/删词条 #ID（先用 /查书 查看编号）' });
          return;
        }
        const existing = this.lorebookStore.getById(id);
        if (!existing) {
          await this.onebotClient.sendText({ ...replyTarget, text: `没找到世界书词条 #${id}` });
          return;
        }
        const chatScope = resolveCanonicalScope({ messageType: msg.messageType, groupId: msg.groupId, userId: msg.userId });
        if (!decision.isOwner && existing.scope !== chatScope) {
          await this.onebotClient.sendText({ ...replyTarget, text: '只能删除本群专属词条，公共词条请联系主人删除喵~' });
          return;
        }
        this.lorebookStore.deleteEntry(id);
        await this.onebotClient.sendText({ ...replyTarget, text: `已删除世界书词条 #${id} (${existing.title})` });
        this.emit('status-change');
        return;
      }
    }
  }

  async _handleMergedBatch(batch) {
    const last = batch.lastItem;
    const batchItems = batch.items || [last];
    const directTriggerItem = batchItems.find(
      (it) => it.triggerMode === 'at' || it.isAtSelf || it.triggerMode === 'reply-to-self' || it.triggerMode === 'keyword'
    );
    const primaryItem = directTriggerItem || last;
    const lane = last.lane;
    const replyTarget = {
      messageType: last.messageType,
      userId: primaryItem.userId || last.userId,
      groupId: last.groupId
    };

    const backoff = this.rateLimiter.isInBackoff(batch.sessionKey);
    if (backoff.active) {
      this._log('warn', 'guard', `会话 ${batch.sessionKey} 处于风控退避期，剩余 ${backoff.remainingSec}s，跳过本轮回复`);
      return;
    }

    // Resolve quoted message if present (reuses short cache from _handleIncomingMessage)
    let quotedPrefix = '';
    const quotedLinks = [];
    const quotedForwards = [];
    const extraImages = [];
    const quoteRefId = primaryItem.replyToId || last.replyToId;
    if (quoteRefId) {
      try {
        const quotedRaw = await this._getQuotedMessageCached(quoteRefId);
        if (quotedRaw) {
          const quoted = parseOneBotMessageEvent(quotedRaw);
          if (quoted.text) {
            quotedPrefix = `[引用 ${quoted.senderName}：${quoted.text.slice(0, 180)}]\n`;
          }
          if (Array.isArray(quoted.links) && quoted.links.length) {
            quotedLinks.push(...quoted.links);
          }
          if (Array.isArray(quoted.forwards) && quoted.forwards.length) {
            quotedForwards.push(...quoted.forwards);
          }
          if (quoted.images.length) {
            extraImages.push(...quoted.images);
          }
        }
      } catch {
        // ignore quote lookup failure
      }
    }

    // Drain 0-cost ambient group messages heard while dormant (gives instant context without wasting LLM calls!)
    const ambient =
      last.messageType === 'group' && last.groupId ? this._drainAmbientGroupMessages(last.groupId) : [];

    // If current turn has no images, carry recent ambient image(s) (normal photos, GIFs, or card covers):
    // 1. Always: same sender within 90s (up to 2 images), or latest ambient entry within 60s
    // 2. Back-reference cue (e.g. "他在玩什么梗 / 上面那张图 / 怎么看"): carry latest 1~2 images from the last 3 ambient messages (up to 6h)
    const nowTs = Date.now();
    const hasBackRefCue = BACKREF_VISUAL_CUE_RE.test(batch.text || '');
    const ambientImageTagMap = new Map();
    if (!batch.images.length && !extraImages.length && ambient.length) {
      const getAmbientImgs = (m) => (Array.isArray(m.images) && m.images.length ? m.images : m.cardImages || []);
      const sameSenderRecent = ambient.filter(
        (m) => m.userId === primaryItem.userId && nowTs - m.ts <= 90000 && getAmbientImgs(m).length > 0
      );
      let chosenSources = sameSenderRecent.slice(-2);
      if (!chosenSources.length) {
        const latest = ambient[ambient.length - 1];
        if (latest && nowTs - latest.ts <= 60000 && getAmbientImgs(latest).length > 0) {
          chosenSources = [latest];
        }
      }
      if (!chosenSources.length && hasBackRefCue) {
        const tailWithImages = ambient
          .slice(-3)
          .filter((m) => nowTs - m.ts < AMBIENT_TTL_MS && getAmbientImgs(m).length > 0);
        chosenSources = tailWithImages.slice(-2);
      }
      const carriedCountBefore = extraImages.length;
      for (const src of chosenSources) {
        const tags = [];
        for (const img of getAmbientImgs(src)) {
          if (extraImages.length - carriedCountBefore >= 2) break;
          extraImages.push({
            ...img,
            isSticker: false,
            isAmbientImage: true
          });
          tags.push(`[图${extraImages.length}]`);
        }
        if (tags.length) {
          ambientImageTagMap.set(src, tags.join(''));
        }
      }
      if (extraImages.length > carriedCountBefore) {
        this._log(
          'info',
          'vision',
          `补带近期旁听图片 (${batch.sessionKey}): ${extraImages.length - carriedCountBefore} 张${hasBackRefCue ? ' (回指触发)' : ''}`
        );
      }
    }

    // Owner private lane convenience: if owner mentions a local .gif file path in text, auto-attach its storyboard preview!
    const visionCfg = this.configStore.get().vision || {};
    if (lane === 'owner' && visionCfg.enabled !== false && visionCfg.ownerLocalGifPreview !== false && batch.text) {
      const localGifs = extractLocalGifPaths(batch.text, {
        maxCount: 2,
        maxBytes: visionCfg.maxImageBytes || 8 * 1024 * 1024
      });
      for (const fp of localGifs) {
        extraImages.push({
          file: fp,
          summary: `[本地动图:${path.basename(fp)}]`,
          isSticker: false,
          isLocalGifPreview: true
        });
      }
    }

    // Resolve QQ merged-forward messages (direct, quoted, or a recent ambient forward within 90s)
    const forwardRefs = [
      ...batchItems.flatMap((it) => it.forwards || []),
      ...quotedForwards
    ];
    if (!forwardRefs.length && ambient.length) {
      const fwdWindowMs = hasBackRefCue ? AMBIENT_TTL_MS : 90000;
      const recentFwd = [...ambient]
        .reverse()
        .find(
          (m, idx) =>
            m.forwards?.length &&
            nowTs - m.ts <= fwdWindowMs &&
            (m.userId === primaryItem.userId || idx === 0 || (hasBackRefCue && idx <= 1))
        );
      if (recentFwd) {
        forwardRefs.push(...recentFwd.forwards);
      }
    }

    const maxVisionImgs = Math.max(1, Number(visionCfg.maxImagesPerTurn ?? 4));
    const existingImgCount = batch.images.length + extraImages.length;
    const forwardRes = forwardRefs.length
      ? await resolveForwardMessages({
          forwards: forwardRefs,
          onebotClient: this.onebotClient,
          maxDepth: 2,
          maxMessages: 25,
          maxChars: 2500,
          maxImages: Math.max(0, maxVisionImgs - existingImgCount),
          imageStartIndex: existingImgCount + 1
        }).catch((err) => {
          this._log('debug', 'forward', `合并转发展开跳过: ${err.message}`);
          return { promptBlock: '', images: [], links: [], messageCount: 0, truncatedCount: 0, failedIds: [] };
        })
      : { promptBlock: '', images: [], links: [], messageCount: 0, truncatedCount: 0, failedIds: [] };

    if (forwardRes.images.length) {
      extraImages.push(...forwardRes.images);
    }

    const allImageMetas = [...batch.images, ...extraImages];

    // Collect Bilibili link candidates (current turn + quoted + forwarded take priority; recent ambient card as fallback)
    const biliAmbientWindowMs = (this.configStore.get().bilibili?.ambientWindowSec ?? 90) * 1000;
    const biliPrimaryTexts = [
      batch.text,
      ...batchItems.flatMap((it) => it.links || []),
      quotedPrefix,
      ...quotedLinks,
      ...forwardRes.links
    ].filter(Boolean);
    const biliAmbientTexts = ambient
      .filter((m) => nowTs - m.ts <= biliAmbientWindowMs)
      .flatMap((m) => [m.text, ...(m.links || [])])
      .filter(Boolean);

    // Prepare images and resolve Bilibili public metadata + hot comments in parallel to minimize latency
    const [preparedImages, biliRes] = await Promise.all([
      this.visionFetcher.prepareImagesForTurn(allImageMetas, this.onebotClient),
      this.bilibiliResolver
        .resolveFromSources({ primaryTexts: biliPrimaryTexts, ambientTexts: biliAmbientTexts })
        .catch((err) => {
          this._log('debug', 'bilibili', `B站公开信息解析跳过: ${err.message}`);
          return { videos: [], promptBlock: '' };
        })
    ]);

    // Opportunistic auto-steal on sticker images seen in active chat
    if (allImageMetas.some((i) => i.isSticker)) {
      this._autoStealStickers(allImageMetas, batch.text).catch(() => {});
    }

    const isAtTrigger = batchItems.some((it) => it.triggerMode === 'at' || it.isAtSelf);
    const isReplyTrigger = batchItems.some((it) => it.triggerMode === 'reply-to-self');
    const isKeywordTrigger = batchItems.some((it) => it.triggerMode === 'keyword');
    const hasDirectTrigger = isAtTrigger || isReplyTrigger || isKeywordTrigger;
    const isActiveWindowOnly = last.messageType === 'group' && !hasDirectTrigger && last.triggerMode === 'active-window';

    // Skip truly empty messages (e.g. unsupported non-text event), except bare @-self summons!
    if (
      !batch.text &&
      !preparedImages.length &&
      !quotedPrefix &&
      !biliRes.videos.length &&
      !forwardRes.promptBlock &&
      !isAtTrigger
    ) {
      this._log('debug', 'engine', `跳过无正文无图片的空消息 (${batch.sessionKey})`);
      return;
    }

    const distinctGroupUsers =
      last.messageType === 'group'
        ? new Set(batchItems.map((it) => String(it.userId || '')).filter(Boolean))
        : new Set();
    const isMultiSenderBatch = last.messageType === 'group' && distinctGroupUsers.size > 1;

    const senderTag =
      last.messageType === 'group'
        ? isMultiSenderBatch
          ? '[群聊多条消息]\n'
          : isAtTrigger
            ? `[群友 ${last.senderName} @了你] `
            : isReplyTrigger
              ? `[群友 ${last.senderName} 回复了你] `
              : `[群友 ${last.senderName}] `
        : '';
    const fallbackBody = preparedImages.length
      ? '请看看这张图片'
      : isAtTrigger
        ? '（只 @了你，没打字）'
        : '';
    const promptText = `${quotedPrefix}${senderTag}${batch.text || fallbackBody}`;

    const contextPrefixParts = [];
    if (ambient.length) {
      const ambientLines = ambient.map((m) => {
        const carriedTag = ambientImageTagMap.get(m);
        const imgSuffix = carriedTag
          ? m.text
            ? ` ${carriedTag}（已附带该图）`
            : `${carriedTag}（已附带该图）`
          : m.hasImage
            ? m.text
              ? ' [图片]'
              : '[图片]'
            : '';
        const clock = formatAmbientClock(m.ts);
        return `- [${clock}] ${m.senderName}: ${m.text || ''}${imgSuffix}`;
      });
      contextPrefixParts.push(
        `[刚才本群你未发言前的背景聊天（仅助理解前因，无需逐条回复）]\n${ambientLines.join('\n')}\n[/群聊背景]`
      );
    }

    if (forwardRes.promptBlock) {
      if (forwardRes.messageCount > 0) {
        this._log(
          'info',
          'forward',
          `已展开合并转发 (${batch.sessionKey}): ${forwardRes.messageCount} 条记录, ${forwardRes.images.length} 张图${forwardRes.truncatedCount ? `, 省略 ${forwardRes.truncatedCount} 条` : ''}`
        );
      } else if (forwardRes.failedIds.length) {
        this._log('warn', 'forward', `合并转发拉取失败 (${batch.sessionKey}): ${forwardRes.failedIds.join(', ')}`);
      }
      contextPrefixParts.push(forwardRes.promptBlock);
    }

    if (biliRes.videos.length && biliRes.promptBlock) {
      this._log(
        'info',
        'bilibili',
        `已解析 B站视频 (${batch.sessionKey}): ${biliRes.videos
          .map((v) => `《${v.title.slice(0, 32)}》 UP:${v.ownerName} 热评:${v.hotComments.length}条`)
          .join(' | ')}`
      );
      contextPrefixParts.push(biliRes.promptBlock);
    }

    const storyboardHint = buildAnimatedStoryboardHint(preparedImages);
    if (storyboardHint) {
      const animList = preparedImages
        .filter((i) => i.animation?.isAnimated)
        .map((i) => `${i.animation.layout}(${i.animation.sampledFrames}/${i.animation.frameCount}帧)`);
      this._log('info', 'vision', `已生成动图时序分镜 (${batch.sessionKey}): ${animList.join(', ')}`);
      contextPrefixParts.push(storyboardHint);
    }

    // Direct address guarantee vs Active-window discretion hint
    if (last.messageType === 'group' && (isAtTrigger || isReplyTrigger || isKeywordTrigger)) {
      contextPrefixParts.push(
        `[群聊点名提示：群友刚才直接 @了你、回复了你或叫了你的名字，请自然回应对方，不要输出 [静默]。]`
      );
    } else if (isActiveWindowOnly) {
      contextPrefixParts.push(
        `[群聊活跃期提示：你当前正和熟人群友一起聊天（剩余约 ${last.activeRemainingSec || 0} 秒），不必非得指定叫你才开口——只要话题有趣、能接梗、吐槽、吃瓜或搭一句腔，就大方自然地聊起来！仅在对方明显在私下办正事、反复刷无意义水消息，或完全插不上嘴时才输出 [静默]。]`
      );
    }

    // Living Lorebook: 1ms local keyword/constant match BEFORE inference (search-only-if-missing!)
    const chatScope = resolveCanonicalScope({
      messageType: last.messageType,
      groupId: last.groupId,
      userId: last.userId
    });
    const currentTurn = (this.sessionManager?.getSessionInfo(batch.sessionKey)?.turnCount || 0) + 1;
    const loreMatch = this.lorebookStore.matchForTurn({
      text: `${quotedPrefix} ${batch.text}`,
      scope: chatScope,
      sessionKey: batch.sessionKey,
      currentTurn
    });
    if (loreMatch.entries.length || loreMatch.cooldownHits.length) {
      this._log(
        'info',
        'lorebook',
        `世界书命中 (${batch.sessionKey}): 注入 ${loreMatch.entries.length} 条 [${loreMatch.entries
          .map((e) => `#${e.id}:${e.title}`)
          .join(', ')}]${loreMatch.cooldownHits.length ? `，冷却免重复 ${loreMatch.cooldownHits.length} 条` : ''}`
      );
    }
    if (loreMatch.promptBlock) {
      contextPrefixParts.push(loreMatch.promptBlock);
    }

    // L2 Read-only Public MemeWiki (6792+ memes; L1 always takes priority on overlapping terms!)
    const l1MatchedTitles = [
      ...loreMatch.entries.map((e) => e.title),
      ...loreMatch.cooldownHits.map((e) => e.title)
    ];
    const l1MatchedKeys = loreMatch.entries.flatMap((e) => e.matchedKeys || []);
    const wakeWords = [
      this.configStore.get().acp?.persona?.name || '',
      ...(this.configStore.get().guard?.triggerKeywords || [])
    ].filter(Boolean);
    const memeMatch = this.memeWikiStore.matchForTurn({
      text: `${quotedPrefix} ${batch.text}`,
      sessionKey: batch.sessionKey,
      currentTurn,
      l1MatchedTitles,
      l1MatchedKeys,
      wakeWords
    });
    if (memeMatch.entries.length || memeMatch.cooldownHits.length) {
      this._log(
        'info',
        'memewiki',
        `L2 梗百科命中 (${batch.sessionKey}): 注入 ${memeMatch.entries.length} 条 [${memeMatch.entries
          .map((e) => e.title)
          .join(', ')}]${memeMatch.cooldownHits.length ? `，冷却免重复 ${memeMatch.cooldownHits.length} 条` : ''}`
      );
    }
    if (memeMatch.promptBlock) {
      contextPrefixParts.push(memeMatch.promptBlock);
    }

    this._log(
      'info',
      'engine',
      `收到 ${batch.sessionKey} (${lane}${isActiveWindowOnly ? '·活跃期跟聊' : ''}, 合并 ${batch.count} 条, ${preparedImages.length} 图): ${promptText.slice(0, 80)}`
    );

    let aiResult;
    try {
      aiResult = await this.sessionManager.ask({
        sessionKey: batch.sessionKey,
        lane,
        text: promptText,
        lorebookBlock: contextPrefixParts.join('\n\n'),
        images: preparedImages
      });
    } catch (err) {
      this._log('error', 'acp', `ACP 推理失败 (${batch.sessionKey}): ${err.message}`);
      await this.onebotClient
        .sendText({ ...replyTarget, text: `思考通道暂时卡了一下 (${err.message.slice(0, 60)})，稍后再试或发 /new 重置~` })
        .catch(() => {});
      return;
    }

    const cfg = this.configStore.get();
    const parsed = parseAssistantReply(aiResult.text, cfg.tts.defaultEmotion);

    // Living Lorebook: safely record any inline [词条:...] learned from web search or chat
    if (parsed.loreEntries?.length && cfg.lorebook?.enabled !== false && cfg.lorebook?.autoRecord !== false) {
      for (const rawEntry of parsed.loreEntries) {
        const saved = this.lorebookStore.recordFromAi(rawEntry, {
          messageType: last.messageType,
          groupId: last.groupId,
          userId: last.userId,
          senderName: last.senderName,
          lane
        });
        if (saved.saved) {
          this._log(
            'info',
            'lorebook',
            `AI 自动${saved.action === 'merged' ? '合并更新' : '入库'}世界书 #${saved.entry.id} [${saved.entry.category} · ${saved.entry.scope}] ${saved.entry.title} (${saved.entry.keys.join(',')})${saved.entry.approved ? '' : ' [待审]'}`
          );
        } else {
          this._log('warn', 'lorebook', `忽略/拦截 AI 词条写入 (${saved.reason}): ${rawEntry.content?.slice(0, 40) || ''}`);
        }
      }
    }

    if (parsed.silent) {
      if (last.messageType === 'group' && last.groupId) {
        const sil = this.ownerGuard.recordGroupSilent(last.groupId);
        if (sil.deactivated) {
          this._log(
            'info',
            'engine',
            `AI 连续静默 ${sil.consecutiveSilent} 次，已自动结束活跃跟聊窗口转入 0-Token 旁听 (${batch.sessionKey})`
          );
          return;
        }
      }
      this._log('info', 'engine', `AI 选择静默跳过回复 (${batch.sessionKey})`);
      return;
    }

    // 1. Optional Voice track (GPT-SoVITS v5 + SHA-256 cache + Scheme 1 smart situational voice + clean script)
    const userAskedVoice = /(?:发|来|说|念|听|给).{0,6}(?:语音|声音|听听)|(?:来句语音|发个语音|发条语音|读出来|念出来|说给我听)/i.test(
      batch.text
    );
    const maxVoiceChars = cfg.tts.maxVoiceChars || 120;
    let voiceReason = '';
    let voiceTargetText = '';

    if (cfg.tts.enabled) {
      if (userAskedVoice) {
        voiceReason = 'user-asked';
        voiceTargetText = sanitizeVoiceText(parsed.voiceText || parsed.displayText, maxVoiceChars);
      } else if (parsed.voiceText) {
        voiceReason = 'ai-tag';
        voiceTargetText = sanitizeVoiceText(parsed.voiceText, maxVoiceChars);
      } else if (
        (last.messageType === 'private' && cfg.tts.autoVoiceInPrivate) ||
        (last.messageType === 'group' && cfg.tts.autoVoiceInGroup)
      ) {
        voiceReason = 'auto-always';
        voiceTargetText = sanitizeVoiceText(parsed.displayText, maxVoiceChars);
      } else if (cfg.tts.smartVoiceEnabled) {
        const cooldownMs = Math.max(0, Number(cfg.tts.smartVoiceCooldownSec ?? 120)) * 1000;
        const lastAt = this.lastAutoVoiceAt.get(batch.sessionKey) || 0;
        const cooldownOk = Date.now() - lastAt >= cooldownMs;
        const maxSpontChars = Number(cfg.tts.smartVoiceMaxTextChars ?? 65);
        const chance =
          last.messageType === 'private'
            ? Number(cfg.tts.smartVoicePrivateChance ?? 0.45)
            : Number(cfg.tts.smartVoiceGroupChance ?? 0.25);

        if (
          cooldownOk &&
          chance > 0 &&
          isGoodForSpontaneousVoice(parsed.displayText, maxSpontChars) &&
          hasSpontaneousVoiceCue(parsed) &&
          Math.random() < chance
        ) {
          voiceReason = 'smart-situational';
          voiceTargetText = sanitizeVoiceText(parsed.displayText, maxSpontChars);
        }
      }
    }

    let releaseTextDone = () => {};
    const textAndStickerDone = new Promise((r) => {
      releaseTextDone = r;
    });

    let voiceSent = false;
    if (voiceReason && voiceTargetText) {
      if (cfg.tts.dualTrack) {
        // Non-blocking dual-track: start GPU synthesis right away on the serialized queue,
        // deliver text & sticker immediately, then append the voice bar cleanly right after!
        this.lastAutoVoiceAt.set(batch.sessionKey, Date.now());
        const voiceEmotion = parsed.emotion;
        const sessionKeyForVoice = batch.sessionKey;
        const targetForVoice = { ...replyTarget };
        const reasonForVoice = voiceReason;
        const textForVoice = voiceTargetText;

        this._voiceQueue = this._voiceQueue
          .catch(() => {})
          .then(async () => {
            const synth = await this.sovitsClient.synthesize({
              text: textForVoice,
              emotion: voiceEmotion
            });
            await textAndStickerDone;
            if (this.paused) return;
            const bo = this.rateLimiter.isInBackoff(sessionKeyForVoice);
            if (bo.active) {
              this._log('debug', 'sovits', `跳过异步语音补发 (${sessionKeyForVoice} 处于风控退避期)`);
              return;
            }
            const voiceRes = await this.onebotClient.sendVoiceBuffer({ ...targetForVoice, buffer: synth.buffer });
            this._rememberBotMessage(voiceRes);
            this.lastAutoVoiceAt.set(sessionKeyForVoice, Date.now());
            this._log(
              'info',
              'sovits',
              `已异步补发语音 [${synth.emotion} · ${reasonForVoice}] (${synth.cached ? 'SHA-256 秒回缓存' : `${synth.latencyMs}ms`})`
            );
          })
          .catch((err) => {
            this._log('warn', 'sovits', `异步语音合成失败（文字已送达）: ${err.message}`);
          });
      } else {
        // Voice-only mode (dualTrack=false): wait for synthesis first so we can fall back to text on error
        try {
          const synth = await this.sovitsClient.synthesize({
            text: voiceTargetText,
            emotion: parsed.emotion
          });
          const voiceRes = await this.onebotClient.sendVoiceBuffer({ ...replyTarget, buffer: synth.buffer });
          this._rememberBotMessage(voiceRes);
          this.lastAutoVoiceAt.set(batch.sessionKey, Date.now());
          voiceSent = true;
          this._log(
            'info',
            'sovits',
            `已发送语音 [${synth.emotion} · ${voiceReason}] (${synth.cached ? 'SHA-256 秒回缓存' : `${synth.latencyMs}ms`})`
          );
        } catch (err) {
          this._log('warn', 'sovits', `语音合成降级为纯文本: ${err.message}`);
        }
      }
    }

    try {
      // 2. Text chunks with natural cadence (0.45s delay) + 90s risk backoff (delivered immediately without waiting for TTS!)
      const shouldSendText = Boolean(parsed.displayText) && (!voiceSent || cfg.tts.dualTrack);
      if (shouldSendText) {
        const sendRes = await this.rateLimiter.sendChunked(
          batch.sessionKey,
          parsed.displayText,
          async (chunk, idx) => {
            const sent = await this.onebotClient.sendText({
              ...replyTarget,
              text: chunk,
              replyToId: idx === 0 && last.messageType === 'group' ? primaryItem.messageId : null
            });
            this._rememberBotMessage(sent);
          },
          {
            onBackoff: (info, err) => {
              this._log('warn', 'guard', `检测到 QQ 发送风控/限流 (${err.message})，触发 ${info.sec}s 自动退避`);
            }
          }
        );
        this._log(
          'info',
          'engine',
          `回复完成 (${batch.sessionKey}, ${aiResult.model}, ${aiResult.latencyMs}ms, 分 ${sendRes.sent} 段, ${aiResult.usage?.totalTokens || 0} tok)`
        );
      }

      // 3. Explicit AI-picked (#ID / keyword) or User-requested Sticker ONLY
      // (No longer runs blind 2-gram fallback on casual text so unrelated memes never hijack normal replies!)
      const userAskedSticker = /(?:表情包|表情|比心图|发张图|发个图|来张|斗图|发图)/i.test(batch.text);
      const aiPickedSticker = Boolean(parsed.stickerId || parsed.stickerQuery);
      const shouldSendSticker = cfg.stickers.enabled && (aiPickedSticker || userAskedSticker);
      if (shouldSendSticker) {
        const preferSelf = /星喵|星猫|本喵|你自己|自己|自设/i.test(`${batch.text} ${parsed.stickerQuery || ''}`);
        let picked = null;
        if (parsed.stickerId) {
          picked = this.stickerStore.pickById(parsed.stickerId, { sessionKey: batch.sessionKey });
        }
        if (!picked && (parsed.stickerQuery || userAskedSticker)) {
          const primaryQuery = parsed.stickerQuery || batch.text;
          picked = this.stickerStore.pickForReply({
            sessionKey: batch.sessionKey,
            queryText: primaryQuery,
            bypassCooldown: true,
            preferSelf,
            minScoreOverride: parsed.stickerQuery ? 1 : Math.max(2, cfg.stickers.minScore || 1)
          });
        }
        if (picked?.buffer) {
          const imgRes = await this.onebotClient.sendImageBuffer({ ...replyTarget, buffer: picked.buffer }).catch(() => null);
          this._rememberBotMessage(imgRes);
          this._log(
            'info',
            'stickers',
            `已发送表情 #${picked.sticker.id} [${picked.sticker.tags}] (${picked.byId ? 'AI精确点名#ID' : `score=${picked.score}`})`
          );
        }
      }
    } finally {
      releaseTextDone();
    }

    // Extend active window smoothly when bot actually replied in group chat (not [静默])
    if (last.messageType === 'group' && last.groupId) {
      this.ownerGuard.touchGroupActive(last.groupId, { countReply: isActiveWindowOnly });
    }

    // 4. Context Budget Guard (Scheme A: zero-latency post-reply background compaction relay)
    const ctxSt = aiResult.contextStatus;
    if (ctxSt?.overflowed) {
      if (ctxSt.action === 'compact' || ctxSt.action === 'rolling') {
        const scheduled = this.sessionManager.scheduleAutoCompact(batch.sessionKey, {
          mode: ctxSt.action,
          reason: `budget-${ctxSt.used}/${ctxSt.budget}`
        });
        if (scheduled) {
          this._log(
            'info',
            'compact',
            `会话 ${batch.sessionKey} 已达上下文预算 (${ctxSt.used}/${ctxSt.budget} tokens)，正在后台静默执行「${ctxSt.action === 'compact' ? '无感记忆压缩接力' : '保留近轮快切'}」...`
          );
        }
      } else if (ctxSt.action === 'warn') {
        this._log(
          'warn',
          'compact',
          `会话 ${batch.sessionKey} 已超过上下文预算 (${ctxSt.used}/${ctxSt.budget} tokens)，当前策略为仅提醒，建议发送 /压缩 或 /reset`
        );
      }
    }

    this.emit('status-change');
  }

  // Built-in end-to-end simulation used by Antigravity Hub Live Playground & automated verification
  async simulateTurn({
    scene = 'group',
    userId = '10001',
    groupId = '90001',
    text = '',
    imageBase64 = '',
    requestVoice = false
  }) {
    if (!this.sessionManager) {
      throw new Error('ACP 引擎尚未启动');
    }
    const cfg = this.configStore.get();
    const isOwner = scene === 'owner' || this.ownerGuard.isOwner(userId);
    const messageType = scene === 'owner' || scene === 'private' ? 'private' : 'group';
    const lane = messageType === 'private' && isOwner ? 'owner' : 'group';
    const sessionKey = `sim:${messageType}:${messageType === 'group' ? groupId : userId}`;

    const images = [];
    if (imageBase64) {
      const fetched = await this.visionFetcher.fetchImageBuffer({ base64: imageBase64 });
      images.push(fetched);
    }
    if (lane === 'owner' && cfg.vision?.enabled !== false && cfg.vision?.ownerLocalGifPreview !== false && text) {
      const localGifs = extractLocalGifPaths(text, {
        maxCount: 2,
        maxBytes: cfg.vision?.maxImageBytes || 8 * 1024 * 1024
      });
      for (const fp of localGifs) {
        try {
          const fetched = await this.visionFetcher.fetchImageBuffer({
            file: fp,
            summary: `[本地动图:${path.basename(fp)}]`,
            isLocalGifPreview: true
          });
          images.push(fetched);
        } catch {
          // ignore unreadable local gif
        }
      }
    }

    const simScope = resolveCanonicalScope({ messageType, groupId, userId });
    const simTurn = (this.sessionManager?.getSessionInfo(sessionKey)?.turnCount || 0) + 1;
    const simInputText = text || (images.length ? '请看看这张图片' : '你好');
    const [loreMatch, biliRes] = await Promise.all([
      Promise.resolve(
        this.lorebookStore.matchForTurn({
          text: simInputText,
          scope: simScope,
          sessionKey,
          currentTurn: simTurn
        })
      ),
      this.bilibiliResolver.resolveFromSources({ primaryTexts: [simInputText] }).catch((err) => {
        this._log('debug', 'bilibili', `演练 B站公开信息解析跳过: ${err.message}`);
        return { videos: [], promptBlock: '' };
      })
    ]);
    if (loreMatch.entries.length || loreMatch.cooldownHits.length) {
      this._log(
        'info',
        'lorebook',
        `演练世界书命中 (${sessionKey}): 注入 ${loreMatch.entries.length} 条 [${loreMatch.entries
          .map((e) => `#${e.id}:${e.title}`)
          .join(', ')}]${loreMatch.cooldownHits.length ? `，冷却免重复 ${loreMatch.cooldownHits.length} 条` : ''}`
      );
    }
    const simMemeMatch = this.memeWikiStore.matchForTurn({
      text: simInputText,
      sessionKey,
      currentTurn: simTurn,
      l1MatchedTitles: [
        ...loreMatch.entries.map((e) => e.title),
        ...loreMatch.cooldownHits.map((e) => e.title)
      ],
      l1MatchedKeys: loreMatch.entries.flatMap((e) => e.matchedKeys || []),
      wakeWords: [cfg.acp?.persona?.name || '', ...(cfg.guard?.triggerKeywords || [])].filter(Boolean)
    });
    if (simMemeMatch.entries.length || simMemeMatch.cooldownHits.length) {
      this._log(
        'info',
        'memewiki',
        `演练 L2 梗百科命中 (${sessionKey}): 注入 ${simMemeMatch.entries.length} 条 [${simMemeMatch.entries
          .map((e) => e.title)
          .join(', ')}]${simMemeMatch.cooldownHits.length ? `，冷却免重复 ${simMemeMatch.cooldownHits.length} 条` : ''}`
      );
    }
    if (biliRes.videos.length) {
      this._log(
        'info',
        'bilibili',
        `演练已解析 B站视频 (${sessionKey}): ${biliRes.videos
          .map((v) => `《${v.title.slice(0, 32)}》 UP:${v.ownerName} 热评:${v.hotComments.length}条`)
          .join(' | ')}`
      );
    }
    const simStoryboardHint = buildAnimatedStoryboardHint(images);
    if (simStoryboardHint) {
      const animList = images
        .filter((i) => i.animation?.isAnimated)
        .map((i) => `${i.animation.layout}(${i.animation.sampledFrames}/${i.animation.frameCount}帧)`);
      this._log('info', 'vision', `演练已生成动图时序分镜 (${sessionKey}): ${animList.join(', ')}`);
    }

    const simContextPrefix = [simStoryboardHint, biliRes.promptBlock, loreMatch.promptBlock, simMemeMatch.promptBlock]
      .filter(Boolean)
      .join('\n\n');
    const aiResult = await this.sessionManager.ask({
      sessionKey,
      lane,
      text: simInputText,
      lorebookBlock: simContextPrefix,
      images
    });

    const parsed = parseAssistantReply(aiResult.text, cfg.tts.defaultEmotion);
    const lorebookRecorded = [];
    if (parsed.loreEntries?.length && cfg.lorebook?.enabled !== false && cfg.lorebook?.autoRecord !== false) {
      for (const rawEntry of parsed.loreEntries) {
        const saved = this.lorebookStore.recordFromAi(rawEntry, {
          messageType,
          groupId,
          userId,
          senderName: `sim:${userId}`,
          lane
        });
        if (saved.saved) {
          lorebookRecorded.push({
            action: saved.action,
            id: saved.entry.id,
            title: saved.entry.title,
            category: saved.entry.category,
            scope: saved.entry.scope,
            keys: saved.entry.keys,
            approved: saved.entry.approved
          });
          this._log(
            'info',
            'lorebook',
            `AI 自动${saved.action === 'merged' ? '合并更新' : '入库'}世界书 #${saved.entry.id} [${saved.entry.category} · ${saved.entry.scope}] ${saved.entry.title}`
          );
        }
      }
    }

    const chunks = splitNaturalChunks(parsed.displayText, {
      maxChunkChars: cfg.guard.maxChunkChars,
      maxChunksPerReply: cfg.guard.maxChunksPerReply
    });

    let voice = null;
    const simVoiceTarget = sanitizeVoiceText(parsed.voiceText || parsed.displayText, cfg.tts.maxVoiceChars);
    if ((requestVoice || Boolean(parsed.voiceText)) && cfg.tts.enabled && simVoiceTarget) {
      try {
        const synth = await this.sovitsClient.synthesize({
          text: simVoiceTarget,
          emotion: parsed.emotion
        });
        voice = {
          emotion: synth.emotion,
          cached: synth.cached,
          latencyMs: synth.latencyMs,
          format: synth.format,
          sha256: synth.sha256,
          audioBase64: synth.buffer.toString('base64')
        };
      } catch (err) {
        voice = { error: err.message };
      }
    }

    let sticker = null;
    const simUserAskedSticker = /(?:表情包|表情|比心图|发张图|发个图|来张|斗图|发图)/i.test(text);
    if (cfg.stickers.enabled && (parsed.stickerId || parsed.stickerQuery || simUserAskedSticker)) {
      const picked = parsed.stickerId
        ? this.stickerStore.pickById(parsed.stickerId, { sessionKey })
        : this.stickerStore.pickForReply({
            sessionKey,
            queryText: parsed.stickerQuery || text,
            bypassCooldown: true
          });
      if (picked) {
        sticker = {
          id: picked.sticker.id,
          tags: picked.sticker.tags,
          score: picked.score,
          byId: Boolean(picked.byId),
          url: `/api/stickers/${picked.sticker.id}/file`
        };
      }
    }

    const simCtxSt = aiResult.contextStatus;
    let autoCompactScheduled = false;
    if (simCtxSt?.overflowed && (simCtxSt.action === 'compact' || simCtxSt.action === 'rolling')) {
      autoCompactScheduled = this.sessionManager.scheduleAutoCompact(sessionKey, {
        mode: simCtxSt.action,
        reason: `sim-budget-${simCtxSt.used}/${simCtxSt.budget}`
      });
    }

    this.emit('status-change');
    return {
      sessionKey,
      lane,
      model: aiResult.model,
      latencyMs: aiResult.latencyMs,
      usage: aiResult.usage,
      contextStatus: simCtxSt,
      autoCompactScheduled,
      rawReply: aiResult.text,
      displayText: parsed.displayText,
      chunks,
      emotion: parsed.emotion,
      toolCalls: aiResult.toolCalls,
      lorebookHits: loreMatch.entries.map((e) => ({
        id: e.id,
        title: e.title,
        category: e.category,
        scope: e.scope,
        constant: e.constant,
        matchedKeys: e.matchedKeys
      })),
      lorebookCooldownHits: loreMatch.cooldownHits.map((e) => ({ id: e.id, title: e.title })),
      lorebookRecorded,
      memewikiHits: simMemeMatch.entries.map((e) => ({
        title: e.title,
        tags: e.tags,
        matchReason: e.matchReason
      })),
      memewikiCooldownHits: simMemeMatch.cooldownHits.map((e) => e.title),
      trollLevel: cfg.memewiki?.trollModeEnabled !== false ? cfg.memewiki?.trollLevel ?? 100 : null,
      bilibiliVideos: biliRes.videos.map((v) => ({
        bvid: v.bvid,
        title: v.title,
        ownerName: v.ownerName,
        tname: v.tname,
        durationText: v.durationText,
        tags: v.tags,
        hotCommentCount: v.hotComments.length,
        hasPinned: Boolean(v.pinnedComment)
      })),
      animatedGifs: images.filter((i) => i.animation?.isAnimated).map((i) => i.animation),
      voice,
      sticker
    };
  }

  getFullStatus() {
    const cfg = this.configStore.get();
    return {
      running: this.running,
      paused: this.paused,
      startedAt: this.startedAt,
      proxy: this.proxyInfo,
      onebot: this.onebotClient.getStatus(),
      napcat: this.napcatManager.getStatus(),
      acp: this.sessionManager ? this.sessionManager.getStatus() : null,
      tts: this.sovitsClient.getStatus(),
      stickers: this.stickerStore.getStats(),
      lorebook: this.lorebookStore.getStats(),
      memewiki: this.memeWikiStore.getStats(),
      tokens: this.tokenStore.getDashboard(24),
      auditLog: this.ownerGuard.getAuditLog().slice(0, 30),
      sessions: this.sessionManager ? this.sessionManager.listSessions() : [],
      summary: {
        ownerModel: cfg.acp.ownerModel,
        groupModel: cfg.acp.groupModel,
        mergeWindowSec: cfg.guard.mergeWindowSec,
        chunkDelaySec: cfg.guard.chunkDelaySec,
        allowOwnerToolsInGroups: cfg.guard.allowOwnerToolsInGroups
      }
    };
  }
}
