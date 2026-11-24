import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigStore } from '../src/config/schema.js';
import { BridgeEngine } from '../src/engine/bridge-engine.js';
import { StickerStore, extract2Grams } from '../src/stickers/sticker-store.js';
import { VisionStickerCurator, parseCuratorJson } from '../src/stickers/vision-curator.js';

const TINY_PNG_A = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const TINY_PNG_B = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

test('extract2Grams produces Chinese 2-grams and short word tokens', () => {
  const grams = extract2Grams('摸鱼中 喝奶茶');
  assert.ok(grams.includes('摸鱼'));
  assert.ok(grams.includes('鱼中'));
  assert.ok(grams.includes('喝奶'));
  assert.ok(grams.includes('奶茶'));
});

test('StickerStore performs SHA-256 deduplication, 2-gram search, and 60s cooldown', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyqq-stk-'));
  const storeCfg = new ConfigStore(dir);
  storeCfg.load();
  storeCfg.update({ stickers: { cooldownSec: 60 } });
  const stickers = new StickerStore(dir, storeCfg);

  try {
    const a1 = stickers.addSticker({ buffer: TINY_PNG_A, ext: '.png', mimeType: 'image/png', tags: ['摸鱼', '奶茶'] });
    assert.equal(a1.deduplicated, false);

    // Duplicate same image with extra tag -> merges tags without creating 2nd row
    const a2 = stickers.addSticker({ buffer: TINY_PNG_A, ext: '.png', mimeType: 'image/png', tags: ['周五下午'] });
    assert.equal(a2.deduplicated, true);
    assert.match(a2.sticker.tags, /摸鱼/);
    assert.match(a2.sticker.tags, /周五下午/);

    stickers.addSticker({ buffer: TINY_PNG_B, ext: '.png', mimeType: 'image/png', tags: ['震惊', '救大命'] });
    assert.equal(stickers.getStats().count, 2);

    const hits = stickers.search('周五下午了，还有谁在认真写代码？我要摸鱼喝奶茶');
    assert.ok(hits.length >= 1);
    assert.equal(hits[0].id, a1.sticker.id);

    // Pick respects 60s cooldown on second immediate attempt
    const p1 = stickers.pickForReply({ sessionKey: 'group:1', queryText: '摸鱼喝奶茶' });
    assert.ok(p1?.buffer);
    const p2 = stickers.pickForReply({ sessionKey: 'group:1', queryText: '摸鱼喝奶茶' });
    assert.equal(p2, null);

    // Explicit command bypasses cooldown
    const p3 = stickers.pickForReply({ sessionKey: 'group:1', queryText: '救大命', bypassCooldown: true });
    assert.ok(p3?.buffer);
  } finally {
    stickers.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('VisionStickerCurator parses JSON verdicts, enriches isSelf tags, and caches rejections', async () => {
  const parsed = parseCuratorJson('```json\n{"steal": true, "score": 9, "isSelf": true, "reason": "超可爱的双子座星喵", "tags": ["卖萌", "贴贴"]}\n```');
  assert.equal(parsed.steal, true);
  assert.equal(parsed.score, 9);
  assert.equal(parsed.isSelf, true);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyqq-curate-'));
  const storeCfg = new ConfigStore(dir);
  storeCfg.load();
  storeCfg.update({
    acp: { persona: { name: '星喵', selfTags: ['星喵', '双子座星', 'Gemini猫娘'], referenceImagePath: '' } },
    stickers: { minReviewScore: 7, reviewCooldownSec: 0, compareWithSelfAvatar: false }
  });
  const stickers = new StickerStore(dir, storeCfg);

  let visionCalls = 0;
  const fakeSessionManager = {
    async runOneShotVision({ promptText }) {
      visionCalls += 1;
      if (promptText.includes('好图')) {
        return {
          text: '{"steal": true, "score": 9, "isSelf": true, "reason": "很像星喵本人", "tags": ["摸鱼"]}',
          latencyMs: 320,
          usage: { totalTokens: 100 }
        };
      }
      return {
        text: '{"steal": false, "score": 3, "isSelf": false, "reason": "糊图无意义", "tags": []}',
        latencyMs: 280,
        usage: { totalTokens: 90 }
      };
    }
  };

  const curator = new VisionStickerCurator({
    configStore: storeCfg,
    sessionManager: fakeSessionManager,
    stickerStore: stickers
  });

  try {
    // 1. Approved + isSelf enrichment
    const r1 = await curator.reviewAndStore(
      { buffer: TINY_PNG_A, base64: TINY_PNG_A.toString('base64'), mimeType: 'image/png', originalMimeType: 'image/png', ext: '.png', sha256: 'hash_good_1' },
      { contextText: '好图' }
    );
    assert.equal(r1.approved, true);
    assert.equal(r1.stored, true);
    assert.equal(r1.isSelf, true);
    assert.ok(r1.sticker.tags.includes('星喵'));
    assert.ok(r1.sticker.tags.includes('Gemini猫娘'));
    assert.equal(r1.sticker.review_score, 9);
    assert.equal(r1.sticker.is_self, 1);

    // 2. Rejected image -> stored in rejected_stickers -> 2nd encounter skips with 0 vision calls!
    const badImg = { buffer: TINY_PNG_B, base64: TINY_PNG_B.toString('base64'), mimeType: 'image/png', originalMimeType: 'image/png', ext: '.png', sha256: 'hash_bad_2' };
    const r2 = await curator.reviewAndStore(badImg, { contextText: '烂图' });
    assert.equal(r2.approved, false);
    assert.equal(r2.stored, false);
    assert.equal(visionCalls, 2);

    const r3 = await curator.reviewAndStore(badImg, { contextText: '烂图' });
    assert.equal(r3.skipped, true);
    assert.equal(r3.skipReason, 'previously-rejected');
    assert.equal(visionCalls, 2); // Zero repeat token spend!
  } finally {
    stickers.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('deleteSticker permanently blacklists SHA-256 to block QQ favorite sync resurrection, while manual re-add clears it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyqq-stk-bl-'));
  const storeCfg = new ConfigStore(dir);
  storeCfg.load();
  storeCfg.update({ onebot: { enabled: false }, tts: { enabled: false } });
  const engine = new BridgeEngine({ rootDir: dir, configStore: storeCfg });

  const localFavPath = path.join(dir, 'fav-other-ai.png');
  fs.writeFileSync(localFavPath, TINY_PNG_A);

  try {
    // 1. Add sticker & then delete it -> permanently blacklisted
    const added = engine.stickerStore.addSticker({
      buffer: TINY_PNG_A,
      ext: '.png',
      mimeType: 'image/png',
      tags: ['大肥鱼'],
      source: 'qq-favorite'
    });
    const sha = added.sticker.sha256;
    assert.equal(engine.stickerStore.deleteSticker(added.sticker.id, { reason: 'other-ai-girl-blacklisted' }), true);
    assert.equal(engine.stickerStore.getStats().count, 0);

    // Permanent blacklist does not expire even with 1ms maxAge, and survives default clearRejections()
    engine.stickerStore.recordRejection({ sha256: 'temp_hash', score: 3, reason: 'temp', permanent: false });
    engine.stickerStore.clearRejections();
    assert.equal(engine.stickerStore.isRejected('temp_hash'), null);
    const blk = engine.stickerStore.isRejected(sha, 1);
    assert.ok(blk);
    assert.equal(blk.permanent, 1);

    // 2. Simulate QQ favorite sync returning the deleted sticker -> must be skipped!
    engine.onebotClient.connected = true;
    engine.onebotClient.fetchCustomFaceDetail = async () => [{ emoId: 1, emoPath: localFavPath, desc: '大肥鱼' }];
    const syncRes = await engine.syncQqFavoriteStickers({ count: 10, silent: true });
    assert.equal(syncRes.blacklisted, 1);
    assert.equal(syncRes.imported, 0);
    assert.equal(engine.stickerStore.getStats().count, 0);

    // 3. Explicit manual re-upload clears the permanent blacklist
    const readded = engine.stickerStore.addSticker({
      buffer: TINY_PNG_A,
      ext: '.png',
      mimeType: 'image/png',
      tags: ['手动加回'],
      source: 'command'
    });
    assert.equal(readded.deduplicated, false);
    assert.equal(engine.stickerStore.isRejected(sha), null);
    assert.equal(engine.stickerStore.getStats().count, 1);
  } finally {
    engine.stickerStore.close();
    engine.lorebookStore.close();
    engine.memeWikiStore.close();
    engine.tokenStore.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
