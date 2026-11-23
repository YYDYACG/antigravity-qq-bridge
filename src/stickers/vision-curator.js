import fs from 'node:fs';
import { detectImageMime } from '../media/vision-fetcher.js';

export function parseCuratorJson(rawText) {
  const s = String(rawText || '').trim();
  if (!s) return null;

  const candidates = [];
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1].trim());
  const braceStart = s.indexOf('{');
  const braceEnd = s.lastIndexOf('}');
  if (braceStart !== -1 && braceEnd > braceStart) {
    candidates.push(s.slice(braceStart, braceEnd + 1));
  }
  candidates.push(s);

  for (const cand of candidates) {
    try {
      const obj = JSON.parse(cand);
      if (obj && typeof obj === 'object') {
        const score = Math.max(0, Math.min(10, Math.round(Number(obj.score ?? 0))));
        const tags = Array.isArray(obj.tags)
          ? obj.tags.map((t) => String(t || '').trim()).filter(Boolean)
          : String(obj.tags || '')
              .split(/[\s,，、/|]+/)
              .map((t) => t.trim())
              .filter(Boolean);
        return {
          steal: Boolean(obj.steal),
          score,
          isSelf: Boolean(obj.isSelf),
          category: String(obj.category || '').trim().slice(0, 40),
          captionOcr: String(obj.captionOcr ?? obj.caption_ocr ?? '').trim().slice(0, 160),
          vibe: String(obj.vibe || '').trim().slice(0, 160),
          useWhen: String(obj.useWhen ?? obj.use_when ?? '').trim().slice(0, 240),
          avoidWhen: String(obj.avoidWhen ?? obj.avoid_when ?? '').trim().slice(0, 160),
          reason: String(obj.reason || '').trim().slice(0, 200),
          tags: [...new Set(tags)].slice(0, 10)
        };
      }
    } catch {
      // try next candidate
    }
  }
  return null;
}

export class VisionStickerCurator {
  constructor({ configStore, sessionManager, stickerStore }) {
    this.configStore = configStore;
    this.sessionManager = sessionManager;
    this.stickerStore = stickerStore;

    this.inFlight = new Set(); // sha256
    this.lastReviewAt = 0;
    this.avatarCache = { path: '', mtimeMs: 0, image: null };
    this.batchState = {
      running: false,
      total: 0,
      done: 0,
      succeeded: 0,
      failed: 0,
      currentId: null,
      startedAt: null,
      finishedAt: null,
      lastError: null
    };
  }

  getBatchStatus() {
    return { ...this.batchState };
  }

  _loadSelfReferenceImage() {
    const refPath = this.configStore.get().acp?.persona?.referenceImagePath || '';
    if (!refPath || !fs.existsSync(refPath)) return null;
    try {
      const stat = fs.statSync(refPath);
      if (
        this.avatarCache.path === refPath &&
        this.avatarCache.mtimeMs === stat.mtimeMs &&
        this.avatarCache.image
      ) {
        return this.avatarCache.image;
      }
      const buf = fs.readFileSync(refPath);
      const det = detectImageMime(buf);
      if (!det) return null;
      const img = { base64: buf.toString('base64'), mimeType: det.mimeType };
      this.avatarCache = { path: refPath, mtimeMs: stat.mtimeMs, image: img };
      return img;
    } catch {
      return null;
    }
  }

  async reviewImage(
    fetchedImg,
    { contextText = '', summary = '', bypassCooldown = false, bypassCache = false, existingMode = false } = {}
  ) {
    const cfg = this.configStore.get();
    const stkCfg = cfg.stickers;
    const persona = cfg.acp.persona || {};
    const sha256 = fetchedImg.sha256;

    if (!bypassCache && !existingMode) {
      if (this.stickerStore.hasSha256(sha256)) {
        return { skipped: true, skipReason: 'already-in-library', sha256 };
      }
      const prevRej = this.stickerStore.isRejected(sha256);
      if (prevRej) {
        return {
          skipped: true,
          skipReason: 'previously-rejected',
          sha256,
          score: prevRej.score,
          reason: prevRej.reason
        };
      }
      if (this.inFlight.has(sha256)) {
        return { skipped: true, skipReason: 'in-flight', sha256 };
      }
    }

    const cdMs = (stkCfg.reviewCooldownSec ?? 15) * 1000;
    if (!bypassCooldown && !existingMode && cdMs > 0 && Date.now() - this.lastReviewAt < cdMs) {
      return { skipped: true, skipReason: 'review-cooldown', sha256 };
    }

    this.inFlight.add(sha256);
    if (!existingMode) this.lastReviewAt = Date.now();

    try {
      const selfRef = stkCfg.compareWithSelfAvatar ? this._loadSelfReferenceImage() : null;
      const images = [];
      let imageGuide =
        '下面附上【表情包原图】，请仔细读图中的文字、画面反差、情绪和梗，并结合上方的【你的自设外貌】与【你的自设标签】判断图中角色是否是你本人或高度相似的同款星喵猫娘（isSelf）。';
      if (selfRef) {
        images.push(selfRef);
        images.push({ base64: fetchedImg.base64, mimeType: fetchedImg.mimeType });
        imageGuide =
          '下面附上 2 张图：第 1 张是【你的本体角色自设参考图】，第 2 张是【目标表情包】。请只对第 2 张【目标表情包】做完整分析，并判断第 2 张里的角色是不是你本人或高度相似的同款星喵猫娘（isSelf）。';
      } else {
        images.push({ base64: fetchedImg.base64, mimeType: fetchedImg.mimeType });
      }
      if (fetchedImg.animation?.isAnimated) {
        const a = fetchedImg.animation;
        const dur = a.durationSec > 0 ? `，约 ${a.durationSec.toFixed(1)} 秒` : '';
        imageGuide += `\n【动图时序分镜提示】目标表情包是动态 GIF，已按时间先后拼成 ${a.cols}×${a.rows} 时序分镜连环画（原图共 ${a.frameCount} 帧${dur}，左上角标号 1→${a.sampledFrames} 按从左到右、从上到下顺序演变）。请务必看完整套动作变化、表情反转与最终定格姿势（例如起手动作→中途表情→结尾比心/反转/出字），切忌只看第 1 帧误判！`;
      }

      const selfName = persona.name || '星喵';
      const selfTagsText = (persona.selfTags || []).join('、');
      const promptText = [
        `你是「${selfName}」的表情包审美与梗学分析官。`,
        persona.selfAppearance ? `【你的自设外貌】${persona.selfAppearance}` : '',
        selfTagsText ? `【你的自设标签】${selfTagsText}` : '',
        existingMode
          ? '【任务】这是一张已收藏在表情库里的表情包，请深挖它的图中文字、反差笑点、最佳使用时机和避雷场景，帮星喵彻底学会怎么用它斗图（steal 固定为 true）。'
          : `【收藏与过滤规则】\n${stkCfg.stealRules || '画风可爱有趣、适合斗图就收藏，模糊水图广告隐私图坚决不偷。'}\n【及格分数线】score >= ${stkCfg.minReviewScore ?? 7}（满分 10 分）才收藏。`,
        contextText ? `【已知备注/群聊语境】${contextText.slice(0, 120)}` : '',
        summary && !/^\[?动画表情\]?$/.test(summary) ? `【QQ自带摘要】${summary}` : '',
        imageGuide,
        '请严格只输出一段合法 JSON（不要任何多余文字或 Markdown），格式如下：',
        JSON.stringify({
          steal: true,
          score: 8,
          isSelf: false,
          category: '六选一: 星喵本尊 / 反差警告 / 傲娇嘲讽 / 贴贴撒娇 / 震惊吐槽 / 群友角色梗',
          captionOcr: '图上完整配字，没字留空字符串',
          vibe: '15~30字点破笑点、反差机制或情绪基调（例如：微笑警告·嘴上温柔邀摸实际应激炸毛）',
          useWhen: '20~45字具体说明什么聊天语境发这张图最绝杀',
          avoidWhen: '10~25字说明什么场景千万别错发（无明显禁区留空）',
          reason: '20字以内简短点评',
          tags: ['3到6个检索关键词']
        })
      ]
        .filter(Boolean)
        .join('\n');

      const aiRes = await this.sessionManager.runOneShotVision({
        model: stkCfg.reviewModel || 'gemini-3.8-flash',
        thoughtLevel: 'low',
        systemPromptAppend:
          'You are a strict JSON meme/sticker analyst. Never call any tools. Output ONLY one valid JSON object matching the requested schema.',
        promptText,
        images,
        sessionKey: existingMode ? 'curator:batch' : 'curator:sticker',
        laneLabel: 'curator'
      });

      const verdict = parseCuratorJson(aiRes.text);
      if (!verdict) {
        return {
          skipped: false,
          approved: false,
          steal: false,
          score: 0,
          isSelf: false,
          category: '',
          captionOcr: '',
          vibe: '',
          useWhen: '',
          avoidWhen: '',
          reason: `鉴图模型未返回合法 JSON: ${String(aiRes.text || '').slice(0, 80)}`,
          tags: [],
          latencyMs: aiRes.latencyMs,
          usage: aiRes.usage
        };
      }

      const minScore = stkCfg.minReviewScore ?? 7;
      const approved = existingMode ? true : Boolean(verdict.steal) && verdict.score >= minScore;

      const finalTags = [...verdict.tags];
      if (verdict.isSelf) {
        if (selfName && !finalTags.includes(selfName)) finalTags.unshift(selfName);
        if (!finalTags.includes('Gemini猫娘')) finalTags.unshift('Gemini猫娘');
        for (const t of (persona.selfTags || []).slice(0, 2)) {
          if (t && !finalTags.includes(t)) finalTags.push(t);
        }
      }
      if (!finalTags.length) finalTags.push('可爱', '斗图');

      return {
        skipped: false,
        approved,
        steal: verdict.steal,
        score: verdict.score,
        minScore,
        isSelf: verdict.isSelf,
        category: verdict.category || (verdict.isSelf ? '星喵本尊' : '震惊吐槽'),
        captionOcr: verdict.captionOcr,
        vibe: verdict.vibe,
        useWhen: verdict.useWhen,
        avoidWhen: verdict.avoidWhen,
        reason: verdict.reason,
        tags: [...new Set(finalTags)].slice(0, 10),
        latencyMs: aiRes.latencyMs,
        usage: aiRes.usage,
        sha256
      };
    } finally {
      this.inFlight.delete(sha256);
    }
  }

  async reviewAndStore(
    fetchedImg,
    { contextText = '', summary = '', source = 'gemini-steal', bypassCooldown = false, bypassCache = false } = {}
  ) {
    const verdict = await this.reviewImage(fetchedImg, {
      contextText,
      summary,
      bypassCooldown,
      bypassCache
    });
    if (verdict.skipped) return verdict;

    if (!verdict.approved) {
      this.stickerStore.recordRejection({
        sha256: fetchedImg.sha256,
        score: verdict.score,
        reason: verdict.reason
      });
      return { ...verdict, stored: false };
    }

    const added = this.stickerStore.addSticker({
      buffer: fetchedImg.buffer,
      ext: fetchedImg.ext,
      mimeType: fetchedImg.originalMimeType || fetchedImg.mimeType,
      tags: verdict.tags,
      source,
      reviewScore: verdict.score,
      reviewReason: verdict.reason,
      isSelf: verdict.isSelf,
      category: verdict.category,
      captionOcr: verdict.captionOcr,
      vibe: verdict.vibe,
      useWhen: verdict.useWhen,
      avoidWhen: verdict.avoidWhen
    });

    return {
      ...verdict,
      stored: true,
      deduplicated: added.deduplicated,
      sticker: added.sticker
    };
  }

  async analyzeExistingSticker(row, visionFetcher) {
    const fp = this.stickerStore.getFilePath(row);
    if (!fp || !fs.existsSync(fp)) {
      throw new Error(`找不到表情文件: #${row.id}`);
    }
    const fetched = await visionFetcher.fetchImageBuffer({ file: fp }, null);
    const verdict = await this.reviewImage(fetched, {
      contextText: row.tags || '',
      existingMode: true,
      bypassCooldown: true,
      bypassCache: true
    });
    if (!verdict.useWhen && !verdict.vibe) {
      throw new Error(verdict.reason || '未返回有效维度');
    }

    // Preserve original user/QQ desc tags + merge new semantic keywords
    const mergedTags = [
      ...String(row.tags || '').split(/\s+/).filter(Boolean),
      ...(verdict.tags || [])
    ];
    const updated = this.stickerStore.updateMemeCard(row.id, {
      tags: mergedTags,
      category: verdict.category,
      captionOcr: verdict.captionOcr,
      vibe: verdict.vibe,
      useWhen: verdict.useWhen,
      avoidWhen: verdict.avoidWhen,
      isSelf: row.is_self ? true : verdict.isSelf,
      reviewScore: verdict.score || row.review_score,
      reviewReason: verdict.reason || row.review_reason
    });
    return { sticker: updated, verdict };
  }

  async batchAnalyzeMissing({ visionFetcher, concurrency = 3, onProgress } = {}) {
    if (this.batchState.running) {
      return { alreadyRunning: true, ...this.getBatchStatus() };
    }
    const queue = this.stickerStore.listUnanalyzed(500);
    this.batchState = {
      running: true,
      total: queue.length,
      done: 0,
      succeeded: 0,
      failed: 0,
      currentId: null,
      startedAt: Date.now(),
      finishedAt: null,
      lastError: null
    };

    if (!queue.length) {
      this.batchState.running = false;
      this.batchState.finishedAt = Date.now();
      this.stickerStore.exportCatalogMarkdown();
      return this.getBatchStatus();
    }

    let cursor = 0;
    const workerFn = async () => {
      while (cursor < queue.length) {
        const idx = cursor++;
        const row = queue[idx];
        this.batchState.currentId = row.id;
        try {
          await this.analyzeExistingSticker(row, visionFetcher);
          this.batchState.succeeded += 1;
        } catch (err) {
          this.batchState.failed += 1;
          this.batchState.lastError = `#${row.id}: ${err.message}`;
        } finally {
          this.batchState.done += 1;
          if (typeof onProgress === 'function') {
            try { onProgress(this.getBatchStatus(), row); } catch {}
          }
        }
      }
    };

    const workerCount = Math.max(1, Math.min(concurrency, queue.length));
    await Promise.all(Array.from({ length: workerCount }, () => workerFn()));

    this.batchState.running = false;
    this.batchState.currentId = null;
    this.batchState.finishedAt = Date.now();
    this.stickerStore.exportCatalogMarkdown();
    return this.getBatchStatus();
  }
}
