import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigStore } from '../src/config/schema.js';
import { SmartMergeWindow } from '../src/guard/merge-window.js';
import { RateLimiter, splitNaturalChunks } from '../src/guard/rate-limiter.js';

test('SmartMergeWindow bundles 3 rapid messages into 1 inference batch and deduplicates repeats', async () => {
  const batches = [];
  const win = new SmartMergeWindow({
    getWindowMs: () => 80,
    getDedupWindowMs: () => 90000,
    onFlush: (b) => batches.push(b)
  });

  assert.equal(win.isDuplicate('group:1', 'u1', '在吗'), false);
  assert.equal(win.isDuplicate('group:1', 'u1', '在吗'), true);

  win.push('private:1', { messageType: 'private', userId: 'u1', text: '在吗！！', images: [] });
  win.push('private:1', { messageType: 'private', userId: 'u1', text: '今天写完代码好累啊', images: [] });
  win.push('private:1', { messageType: 'private', userId: 'u1', text: '快来夸夸我顺便发张图~', images: [{ url: 'https://a/1.png' }] });

  await new Promise((r) => setTimeout(r, 160));
  assert.equal(batches.length, 1);
  assert.equal(batches[0].count, 3);
  assert.equal(batches[0].text, '在吗！！ / 今天写完代码好累啊 / 快来夸夸我顺便发张图~');
  assert.equal(batches[0].images.length, 1);
  win.clearAll();
});

test('splitNaturalChunks splits long replies naturally and preserves code blocks', () => {
  const longText = '辛苦啦主人！今天居然一口气推进了这么多功能~。\n先别继续熬夜了去休息十分钟吧，我去给你泡杯热可可。\n明天记得早点起床，不然我就要在桌面闹腾你啦！';
  const chunks = splitNaturalChunks(longText, { maxChunkChars: 40, maxChunksPerReply: 6 });
  assert.equal(chunks.length, 3);
  assert.match(chunks[0], /辛苦啦主人/);

  const codeReply = '看看这段代码：\n```js\nconsole.log("hello");\n```';
  const codeChunks = splitNaturalChunks(codeReply, { maxChunkChars: 20, maxChunksPerReply: 6 });
  assert.equal(codeChunks.some((c) => c.includes('```js')), true);
});

test('RateLimiter triggers 90s backoff on QQ wind control error', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyqq-rate-'));
  try {
    const store = new ConfigStore(dir);
    store.load();
    store.update({ guard: { chunkDelaySec: 0.01, riskBackoffSec: 90 } });
    const limiter = new RateLimiter(store);

    let backoffNotified = false;
    const res = await limiter.sendChunked(
      'group:123',
      '第一段\n第二段',
      async (_chunk, idx) => {
        if (idx === 1) throw new Error('send failed: retcode 1200 wind control 风控');
      },
      { onBackoff: () => { backoffNotified = true; } }
    );

    assert.equal(res.sent, 1);
    assert.equal(res.triggeredBackoff, true);
    assert.equal(backoffNotified, true);
    assert.equal(limiter.isInBackoff('group:123').active, true);

    const skipped = await limiter.sendChunked('group:123', '再发一条', async () => {
      throw new Error('should not call sendFn during backoff');
    });
    assert.equal(skipped.skippedBackoff, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
