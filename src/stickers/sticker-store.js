import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const STOP_NGRAMS = new Set(['表情', '情包', '好图', '高清', '清版', '图片', '发张', '发个', '你的', '自己', '应该']);

export function extract2Grams(text) {
  const cleaned = String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .trim();
  if (!cleaned) return [];

  const grams = new Set();
  for (const token of cleaned.split(/\s+/)) {
    if (!token) continue;
    if (token.length === 1) {
      grams.add(token);
      continue;
    }
    // Keep exact short ASCII/word tokens as well
    if (/^[a-z0-9]+$/.test(token) && token.length <= 16) {
      grams.add(token);
    }
    // Character 2-gram sliding window
    const chars = [...token];
    for (let i = 0; i < chars.length - 1; i++) {
      const g = chars[i] + chars[i + 1];
      if (!STOP_NGRAMS.has(g)) grams.add(g);
    }
  }
  return [...grams];
}

function normalizeTagList(tags) {
  const raw = Array.isArray(tags) ? tags : String(tags || '').split(/[\s,，、/|]+/);
  return [...new Set(raw.map((t) => String(t || '').trim()).filter(Boolean))];
}

export class StickerStore {
  constructor(rootDir, configStore) {
    this.rootDir = rootDir;
    this.configStore = configStore;
    this.repoDir = path.join(rootDir, 'data', 'stickers');
    this.dbPath = path.join(rootDir, 'data', 'stickers.db');
    this.catalogPath = path.join(rootDir, 'data', 'sticker-catalog.md');
    fs.mkdirSync(this.repoDir, { recursive: true });

    this.db = new DatabaseSync(this.dbPath);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS stickers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sha256 TEXT NOT NULL UNIQUE,
        filename TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        tags TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT 'manual',
        use_count INTEGER NOT NULL DEFAULT 0,
        review_score INTEGER DEFAULT NULL,
        review_reason TEXT NOT NULL DEFAULT '',
        is_self INTEGER NOT NULL DEFAULT 0,
        category TEXT NOT NULL DEFAULT '',
        caption_ocr TEXT NOT NULL DEFAULT '',
        vibe TEXT NOT NULL DEFAULT '',
        use_when TEXT NOT NULL DEFAULT '',
        avoid_when TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sticker_ngrams (
        ngram TEXT NOT NULL,
        sticker_id INTEGER NOT NULL,
        PRIMARY KEY (ngram, sticker_id),
        FOREIGN KEY (sticker_id) REFERENCES stickers(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_sticker_ngrams_ngram ON sticker_ngrams(ngram);
      CREATE TABLE IF NOT EXISTS rejected_stickers (
        sha256 TEXT PRIMARY KEY,
        score INTEGER NOT NULL DEFAULT 0,
        reason TEXT NOT NULL DEFAULT '',
        permanent INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
    `);

    // Safe migration for existing databases created before vision curation / meme card / permanent blacklist columns
    const cols = new Set(this.db.prepare('PRAGMA table_info(stickers)').all().map((c) => c.name));
    if (!cols.has('review_score')) this.db.exec('ALTER TABLE stickers ADD COLUMN review_score INTEGER DEFAULT NULL');
    if (!cols.has('review_reason')) this.db.exec("ALTER TABLE stickers ADD COLUMN review_reason TEXT NOT NULL DEFAULT ''");
    if (!cols.has('is_self')) this.db.exec('ALTER TABLE stickers ADD COLUMN is_self INTEGER NOT NULL DEFAULT 0');
    if (!cols.has('category')) this.db.exec("ALTER TABLE stickers ADD COLUMN category TEXT NOT NULL DEFAULT ''");
    if (!cols.has('caption_ocr')) this.db.exec("ALTER TABLE stickers ADD COLUMN caption_ocr TEXT NOT NULL DEFAULT ''");
    if (!cols.has('vibe')) this.db.exec("ALTER TABLE stickers ADD COLUMN vibe TEXT NOT NULL DEFAULT ''");
    if (!cols.has('use_when')) this.db.exec("ALTER TABLE stickers ADD COLUMN use_when TEXT NOT NULL DEFAULT ''");
    if (!cols.has('avoid_when')) this.db.exec("ALTER TABLE stickers ADD COLUMN avoid_when TEXT NOT NULL DEFAULT ''");

    const rejCols = new Set(this.db.prepare('PRAGMA table_info(rejected_stickers)').all().map((c) => c.name));
    if (!rejCols.has('permanent')) {
      this.db.exec('ALTER TABLE rejected_stickers ADD COLUMN permanent INTEGER NOT NULL DEFAULT 0');
    }

    this.cooldowns = new Map(); // sessionKey -> lastSendTs
    this.stickerCooldowns = new Map(); // stickerId -> lastSendTs (15m anti-repeat)
    if (!fs.existsSync(this.catalogPath)) {
      this.exportCatalogMarkdown();
    }
  }

  _reindexSticker(stickerId, textFields) {
    this.db.prepare('DELETE FROM sticker_ngrams WHERE sticker_id = ?').run(stickerId);
    const combined = Array.isArray(textFields) ? textFields.filter(Boolean).join(' ') : String(textFields || '');
    const grams = extract2Grams(combined);
    const ins = this.db.prepare('INSERT OR IGNORE INTO sticker_ngrams (ngram, sticker_id) VALUES (?, ?)');
    for (const g of grams) {
      ins.run(g, stickerId);
    }
  }

  rebuildAllNgrams() {
    const rows = this.db.prepare('SELECT id, tags, category, caption_ocr FROM stickers').all();
    for (const r of rows) {
      this._reindexSticker(r.id, [r.tags, r.category, r.caption_ocr]);
    }
    return rows.length;
  }

  exportCatalogMarkdown() {
    const rows = this.db
      .prepare(`
        SELECT id, tags, is_self, category, caption_ocr, vibe, use_when, avoid_when
        FROM stickers
        ORDER BY is_self DESC, category ASC, id ASC
      `)
      .all();

    const clean = (s) => String(s || '').replace(/[\r\n|]+/g, ' ').trim();
    const groups = new Map();
    for (const r of rows) {
      const cat = clean(r.category) || (Number(r.is_self) === 1 ? '星喵本尊' : '待补充维度');
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat).push(r);
    }

    const lines = [
      `# 星喵表情包多维度手册（共 ${rows.length} 张）`,
      '',
      '> 用法：决定发哪张图时，在回复里输出 `[表情:#ID]`（例如 `[表情:#64]`）。',
      '> 技巧：优先选 [星喵本尊] 或通用非 AI 拟人表情，严禁发送 DeepSeek（大肥鱼/鲸鱼娘）、Claude（小克）、ChatGPT（龙娘）、Grok 等其他 AI 娘表情；发反差梗图时文字不要剧透笑点；觉得一张图就能绝杀时可直接只发 `[表情:#ID]`；普通闲聊不必强行配图。',
      ''
    ];

    for (const [cat, list] of groups.entries()) {
      lines.push(`## ${cat}（${list.length} 张）`);
      for (const r of list) {
        const selfMark = Number(r.is_self) === 1 ? '[星喵本尊] ' : '';
        const name = clean(r.tags) || `表情#${r.id}`;
        const parts = [`- **#${r.id}** ${selfMark}${name}`];
        if (clean(r.caption_ocr)) parts.push(`图字：「${clean(r.caption_ocr)}」`);
        if (clean(r.vibe)) parts.push(`笑点/基调：${clean(r.vibe)}`);
        if (clean(r.use_when)) parts.push(`适用：${clean(r.use_when)}`);
        if (clean(r.avoid_when)) parts.push(`避雷：${clean(r.avoid_when)}`);
        lines.push(parts.join(' | '));
      }
      lines.push('');
    }

    const tmp = `${this.catalogPath}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, lines.join('\n'), 'utf8');
    fs.renameSync(tmp, this.catalogPath);
    return this.catalogPath;
  }

  hasSha256(sha256) {
    return Boolean(this.db.prepare('SELECT 1 FROM stickers WHERE sha256 = ?').get(String(sha256 || '')));
  }

  isRejected(sha256, maxAgeMs = 7 * 24 * 3600 * 1000) {
    const row = this.db.prepare('SELECT * FROM rejected_stickers WHERE sha256 = ?').get(String(sha256 || ''));
    if (!row) return null;
    if (Number(row.permanent) === 1) {
      return row;
    }
    if (maxAgeMs > 0 && Date.now() - Number(row.created_at || 0) > maxAgeMs) {
      this.db.prepare('DELETE FROM rejected_stickers WHERE sha256 = ?').run(row.sha256);
      return null;
    }
    return row;
  }

  recordRejection({ sha256, score = 0, reason = '', permanent = false }) {
    this.db
      .prepare(`
        INSERT OR REPLACE INTO rejected_stickers (sha256, score, reason, permanent, created_at)
        VALUES (?, ?, ?, ?, ?)
      `)
      .run(String(sha256), Number(score || 0), String(reason || '').slice(0, 240), permanent ? 1 : 0, Date.now());
  }

  unreject(sha256) {
    if (!sha256) return;
    this.db.prepare('DELETE FROM rejected_stickers WHERE sha256 = ?').run(String(sha256));
  }

  listRejections(limit = 20) {
    return this.db
      .prepare('SELECT sha256, score, reason, permanent, created_at FROM rejected_stickers ORDER BY created_at DESC LIMIT ?')
      .all(Math.max(1, Number(limit || 20)));
  }

  clearRejections({ includePermanent = false } = {}) {
    if (includePermanent) {
      this.db.exec('DELETE FROM rejected_stickers');
    } else {
      this.db.exec('DELETE FROM rejected_stickers WHERE permanent = 0');
    }
  }

  addSticker({
    buffer,
    ext = '.png',
    mimeType = 'image/png',
    tags = [],
    source = 'manual',
    reviewScore = null,
    reviewReason = '',
    isSelf = false,
    category = '',
    captionOcr = '',
    vibe = '',
    useWhen = '',
    avoidWhen = ''
  }) {
    if (!Buffer.isBuffer(buffer) || !buffer.length) {
      throw new Error('表情包数据为空');
    }
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    // Explicit user manual/command/hub upload overrides any prior rejection or blacklist
    if (source === 'manual' || source === 'command' || source === 'hub-upload' || source === 'hub-gemini-curate') {
      this.unreject(sha256);
    }
    const tagList = normalizeTagList(tags);
    const existing = this.db.prepare('SELECT * FROM stickers WHERE sha256 = ?').get(sha256);

    if (existing) {
      const mergedTags = normalizeTagList([...existing.tags.split(/\s+/), ...tagList]).join(' ');
      const nextScore = reviewScore !== null && reviewScore !== undefined ? Number(reviewScore) : existing.review_score;
      const nextReason = reviewReason ? String(reviewReason).slice(0, 240) : existing.review_reason || '';
      const nextIsSelf = isSelf ? 1 : existing.is_self || 0;
      const nextCategory = category ? String(category).slice(0, 40) : existing.category || '';
      const nextOcr = captionOcr ? String(captionOcr).slice(0, 160) : existing.caption_ocr || '';
      const nextVibe = vibe ? String(vibe).slice(0, 160) : existing.vibe || '';
      const nextUseWhen = useWhen ? String(useWhen).slice(0, 240) : existing.use_when || '';
      const nextAvoidWhen = avoidWhen ? String(avoidWhen).slice(0, 160) : existing.avoid_when || '';

      this.db
        .prepare(`
          UPDATE stickers
          SET tags = ?, review_score = ?, review_reason = ?, is_self = ?,
              category = ?, caption_ocr = ?, vibe = ?, use_when = ?, avoid_when = ?
          WHERE id = ?
        `)
        .run(
          mergedTags,
          nextScore,
          nextReason,
          nextIsSelf,
          nextCategory,
          nextOcr,
          nextVibe,
          nextUseWhen,
          nextAvoidWhen,
          existing.id
        );
      this._reindexSticker(existing.id, [mergedTags, nextCategory, nextOcr]);
      this.exportCatalogMarkdown();
      return {
        deduplicated: true,
        sticker: this.getById(existing.id)
      };
    }

    const safeExt = ext.startsWith('.') ? ext : `.${ext}`;
    const filename = `${sha256.slice(0, 16)}${safeExt}`;
    const absPath = path.join(this.repoDir, filename);
    fs.writeFileSync(absPath, buffer);

    const tagsStr = tagList.join(' ');
    const now = Date.now();
    const res = this.db
      .prepare(`
        INSERT INTO stickers (
          sha256, filename, mime_type, byte_size, tags, source, use_count,
          review_score, review_reason, is_self,
          category, caption_ocr, vibe, use_when, avoid_when, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        sha256,
        filename,
        mimeType,
        buffer.length,
        tagsStr,
        source,
        reviewScore !== null && reviewScore !== undefined ? Number(reviewScore) : null,
        String(reviewReason || '').slice(0, 240),
        isSelf ? 1 : 0,
        String(category || '').slice(0, 40),
        String(captionOcr || '').slice(0, 160),
        String(vibe || '').slice(0, 160),
        String(useWhen || '').slice(0, 240),
        String(avoidWhen || '').slice(0, 160),
        now
      );

    const id = Number(res.lastInsertRowid);
    this._reindexSticker(id, [tagsStr, category, captionOcr]);
    this.exportCatalogMarkdown();

    return {
      deduplicated: false,
      sticker: this.getById(id)
    };
  }

  getById(id) {
    return this.db.prepare('SELECT * FROM stickers WHERE id = ?').get(Number(id)) || null;
  }

  getFilePath(sticker) {
    if (!sticker?.filename) return null;
    return path.join(this.repoDir, path.basename(sticker.filename));
  }

  readBuffer(sticker) {
    const fp = this.getFilePath(sticker);
    if (!fp || !fs.existsSync(fp)) return null;
    return fs.readFileSync(fp);
  }

  updateTags(id, tags) {
    const row = this.getById(id);
    if (!row) return null;
    const tagsStr = normalizeTagList(tags).join(' ');
    this.db.prepare('UPDATE stickers SET tags = ? WHERE id = ?').run(tagsStr, row.id);
    this._reindexSticker(row.id, [tagsStr, row.category, row.caption_ocr]);
    this.exportCatalogMarkdown();
    return this.getById(row.id);
  }

  updateMemeCard(id, patch = {}) {
    const row = this.getById(id);
    if (!row) return null;
    const tagsStr = patch.tags !== undefined ? normalizeTagList(patch.tags).join(' ') : row.tags;
    const category = patch.category !== undefined ? String(patch.category || '').slice(0, 40) : row.category;
    const captionOcr = patch.captionOcr !== undefined ? String(patch.captionOcr || '').slice(0, 160) : row.caption_ocr;
    const vibe = patch.vibe !== undefined ? String(patch.vibe || '').slice(0, 160) : row.vibe;
    const useWhen = patch.useWhen !== undefined ? String(patch.useWhen || '').slice(0, 240) : row.use_when;
    const avoidWhen = patch.avoidWhen !== undefined ? String(patch.avoidWhen || '').slice(0, 160) : row.avoid_when;
    const isSelf = patch.isSelf !== undefined ? (patch.isSelf ? 1 : 0) : row.is_self;
    const reviewScore =
      patch.reviewScore !== undefined && patch.reviewScore !== null ? Number(patch.reviewScore) : row.review_score;
    const reviewReason = patch.reviewReason !== undefined ? String(patch.reviewReason || '').slice(0, 240) : row.review_reason;

    this.db
      .prepare(`
        UPDATE stickers
        SET tags = ?, category = ?, caption_ocr = ?, vibe = ?, use_when = ?, avoid_when = ?,
            is_self = ?, review_score = ?, review_reason = ?
        WHERE id = ?
      `)
      .run(tagsStr, category, captionOcr, vibe, useWhen, avoidWhen, isSelf, reviewScore, reviewReason, row.id);
    this._reindexSticker(row.id, [tagsStr, category, captionOcr]);
    this.exportCatalogMarkdown();
    return this.getById(row.id);
  }

  listUnanalyzed(limit = 200) {
    return this.db
      .prepare("SELECT * FROM stickers WHERE TRIM(use_when) = '' ORDER BY id ASC LIMIT ?")
      .all(Math.max(1, Number(limit || 200)));
  }

  deleteSticker(id, { blacklist = true, reason = 'manual-deleted' } = {}) {
    const row = this.getById(id);
    if (!row) return false;
    if (blacklist && row.sha256) {
      this.recordRejection({
        sha256: row.sha256,
        score: 0,
        reason: reason || 'manual-deleted',
        permanent: true
      });
    }
    this.db.prepare('DELETE FROM sticker_ngrams WHERE sticker_id = ?').run(row.id);
    this.db.prepare('DELETE FROM stickers WHERE id = ?').run(row.id);
    const fp = this.getFilePath(row);
    if (fp && fs.existsSync(fp)) {
      try { fs.unlinkSync(fp); } catch {}
    }
    this.exportCatalogMarkdown();
    return true;
  }

  search(queryText, { limit = 5, minScore = 1, preferSelf = false } = {}) {
    const grams = extract2Grams(queryText);
    if (!grams.length) return [];

    const placeholders = grams.map(() => '?').join(',');
    const rows = this.db
      .prepare(`
        SELECT s.*, COUNT(DISTINCT n.ngram) AS ngram_hits
        FROM sticker_ngrams n
        JOIN stickers s ON s.id = n.sticker_id
        WHERE n.ngram IN (${placeholders})
        GROUP BY s.id
        HAVING ngram_hits >= ?
        ORDER BY ngram_hits DESC, s.is_self DESC, s.use_count DESC, s.id DESC
        LIMIT ?
      `)
      .all(...grams, Math.max(1, minScore), Math.max(1, limit * 3));

    const qLower = String(queryText || '').toLowerCase();
    const wantsSelf = preferSelf || /星喵|星猫|本喵|你自己|gemini|猫娘/i.test(qLower);

    return rows
      .map((r) => {
        const tagTokens = r.tags.toLowerCase().split(/\s+/).filter(Boolean);
        const exactBonus = tagTokens.some((t) => qLower.includes(t) || t.includes(qLower)) ? 3 : 0;
        const selfBonus = wantsSelf && Number(r.is_self) === 1 ? 4 : 0;
        return {
          ...r,
          score: Number(r.ngram_hits) + exactBonus + selfBonus
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, limit));
  }

  getPromptCatalogSummary(limit = 45) {
    const rows = this.db
      .prepare(`
        SELECT tags, is_self
        FROM stickers
        WHERE TRIM(tags) != ''
        ORDER BY is_self DESC, use_count DESC, id DESC
        LIMIT ?
      `)
      .all(Math.max(1, limit));
    if (!rows.length) return '';
    const selfList = [];
    const otherList = [];
    for (const r of rows) {
      const label = String(r.tags || '').trim().slice(0, 26);
      if (!label) continue;
      if (Number(r.is_self) === 1) selfList.push(label);
      else otherList.push(label);
    }
    const parts = [];
    if (selfList.length) parts.push(`星喵本喵专属表情(${selfList.length}张): ${selfList.join('、')}`);
    if (otherList.length) parts.push(`其他群聊斗图表情(${otherList.length}张): ${otherList.slice(0, 25).join('、')}`);
    return parts.join('\n');
  }

  isOnCooldown(sessionKey) {
    const cdSec = this.configStore.get().stickers.cooldownSec ?? 60;
    if (cdSec <= 0) return false;
    const last = this.cooldowns.get(sessionKey) || 0;
    return Date.now() - last < cdSec * 1000;
  }

  pickById(id, { sessionKey = null } = {}) {
    const cfg = this.configStore.get().stickers;
    if (!cfg.enabled) return null;
    const row = this.getById(id);
    if (!row) return null;
    const buffer = this.readBuffer(row);
    if (!buffer) return null;
    this.db.prepare('UPDATE stickers SET use_count = use_count + 1 WHERE id = ?').run(row.id);
    const now = Date.now();
    if (sessionKey) this.cooldowns.set(sessionKey, now);
    this.stickerCooldowns.set(row.id, now);
    return { sticker: row, buffer, score: 99, byId: true };
  }

  pickForReply({ sessionKey, queryText, bypassCooldown = false, preferSelf = false, minScoreOverride = null }) {
    const cfg = this.configStore.get().stickers;
    if (!cfg.enabled) return null;
    if (!bypassCooldown && this.isOnCooldown(sessionKey)) {
      return null;
    }

    const matches = this.search(queryText, {
      limit: 6,
      minScore: minScoreOverride ?? cfg.minScore ?? 1,
      preferSelf
    });
    if (!matches.length) return null;

    // Prefer stickers not used within the last 15 minutes to avoid repeating the exact same meme
    const now = Date.now();
    const fresh = matches.filter((m) => now - (this.stickerCooldowns.get(m.id) || 0) > 15 * 60 * 1000);
    const poolBase = fresh.length ? fresh : matches;

    const topScore = poolBase[0].score;
    const topPool = poolBase.filter((m) => m.score >= topScore - 1).slice(0, 3);
    const chosen = topPool[Math.floor(Math.random() * topPool.length)];
    const buffer = this.readBuffer(chosen);
    if (!buffer) return null;

    this.db.prepare('UPDATE stickers SET use_count = use_count + 1 WHERE id = ?').run(chosen.id);
    if (sessionKey) this.cooldowns.set(sessionKey, now);
    this.stickerCooldowns.set(chosen.id, now);
    return { sticker: chosen, buffer, score: chosen.score };
  }

  pickRandom() {
    const row = this.db.prepare('SELECT * FROM stickers ORDER BY RANDOM() LIMIT 1').get();
    if (!row) return null;
    const buffer = this.readBuffer(row);
    if (!buffer) return null;
    this.db.prepare('UPDATE stickers SET use_count = use_count + 1 WHERE id = ?').run(row.id);
    return { sticker: row, buffer };
  }

  list({ query = '', limit = 100, offset = 0 } = {}) {
    if (query && query.trim()) {
      return this.search(query, { limit, minScore: 1 });
    }
    return this.db
      .prepare('SELECT * FROM stickers ORDER BY id DESC LIMIT ? OFFSET ?')
      .all(limit, offset);
  }

  getStats() {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count, COALESCE(SUM(byte_size), 0) AS totalBytes, SUM(CASE WHEN TRIM(use_when) != '' THEN 1 ELSE 0 END) AS analyzedCount FROM stickers")
      .get();
    const idx = this.db.prepare('SELECT COUNT(*) AS ngramCount FROM sticker_ngrams').get();
    return {
      count: Number(row.count || 0),
      analyzedCount: Number(row.analyzedCount || 0),
      totalMb: Number((Number(row.totalBytes || 0) / (1024 * 1024)).toFixed(2)),
      ngramCount: Number(idx.ngramCount || 0),
      catalogPath: this.catalogPath
    };
  }

  close() {
    try {
      this.db.close();
    } catch {}
  }
}
