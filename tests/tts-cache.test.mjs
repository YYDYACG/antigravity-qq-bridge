import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigStore } from '../src/config/schema.js';
import { SoVitsClient } from '../src/tts/sovits-client.js';
import { BridgeEngine } from '../src/engine/bridge-engine.js';
import { parseAssistantReply, normalizeEmotion, sanitizeVoiceText, isGoodForSpontaneousVoice, hasSpontaneousVoiceCue } from '../src/tts/reply-parser.js';

test('parseAssistantReply parses emotion, sticker, voice, and silent tags cleanly', () => {
  const r1 = parseAssistantReply('[情绪:傲娇] 哼，再多夸夸我也可以哦，主人~ [表情:开心]', '平静');
  assert.equal(r1.silent, false);
  assert.equal(r1.emotion, '调皮');
  assert.equal(r1.stickerQuery, '开心');
  assert.equal(r1.displayText, '哼，再多夸夸我也可以哦，主人~');

  const r2 = parseAssistantReply('[静默]', '平静');
  assert.equal(r2.silent, true);

  const r3 = parseAssistantReply('[表情:#64]', '平静');
  assert.equal(r3.silent, false);
  assert.equal(r3.stickerId, 64);
  assert.equal(r3.displayText, '');

  assert.equal(normalizeEmotion('贴贴', '平静'), '温柔');
});

test('Scheme 1 smart voice sanitizer strips Markdown/URLs and skips code/lists while catching emotional cues', () => {
  assert.equal(
    sanitizeVoiceText('**主人早安**呀~~~ 看这个 [链接](https://example.com) https://foo.bar/x'),
    '主人早安呀～ 看这个 链接'
  );
  assert.equal(
    sanitizeVoiceText('呜哇啊啊——！！TesterB 你怎么连这种赛博黑历史都掏出来公开处刑啊喵！！'),
    '哇，TesterB 你怎么连这种赛博黑历史都掏出来公开处刑喵！'
  );
  assert.equal(
    sanitizeVoiceText('呜呜呜，好委屈啊呜呜！！星喵最喜欢你啦喵~'),
    '呜，好委屈啊！星喵最喜欢你喵~'
  );
  assert.equal(isGoodForSpontaneousVoice('主人早安呀，今天也要元气满满喵~'), true);
  assert.equal(isGoodForSpontaneousVoice('```js\nconsole.log(1)\n```'), false);
  assert.equal(isGoodForSpontaneousVoice('1. 第一点\n2. 第二点'), false);
  assert.equal(isGoodForSpontaneousVoice('去看 https://example.com 吧'), false);
  assert.equal(
    hasSpontaneousVoiceCue({ displayText: '哼哼，本喵才没有想你呢喵~', emotion: '调皮', hasExplicitEmotion: true }),
    true
  );
  assert.equal(
    hasSpontaneousVoiceCue({ displayText: '好的，收到。', emotion: '平静', hasExplicitEmotion: false }),
    false
  );
});

test('SoVitsClient hits SHA-256 cache on repeated emotion synthesis with 0 backend calls', async () => {
  let ttsCalls = 0;
  let lastBody = null;
  const fakeWav = Buffer.from('RIFF\x24\x00\x00\x00WAVEfmt ', 'binary');

  const mockServer = http.createServer((req, res) => {
    if (req.url === '/openapi.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ openapi: '3.1.0', paths: { '/tts': {} } }));
      return;
    }
    if (req.url === '/tts' && req.method === 'POST') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        ttsCalls += 1;
        lastBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        res.writeHead(200, { 'Content-Type': 'audio/wav' });
        res.end(fakeWav);
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((r) => mockServer.listen(0, '127.0.0.1', r));
  const { port } = mockServer.address();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyqq-tts-'));
  const refPath = path.join(dir, 'ref.wav');
  fs.writeFileSync(refPath, fakeWav);

  try {
    const store = new ConfigStore(dir);
    store.load();
    store.update({
      tts: {
        baseUrl: `http://127.0.0.1:${port}`,
        autoProbePorts: [port],
        cacheEnabled: true,
        defaultEmotion: '温柔',
        emotions: {
          温柔: { refAudioPath: refPath, promptText: '参考句', promptLang: 'zh', speedFactor: 0.96 }
        }
      }
    });

    const client = new SoVitsClient(store, dir);

    // 1. Prewarm hits /tts with all 13 v5 params without polluting cache or cacheMisses
    const pw = await client.prewarm();
    assert.equal(pw.ok, true);
    assert.equal(pw.alreadyPrewarmed, false);
    assert.equal(client.prewarmed, true);
    assert.equal(ttsCalls, 1);
    assert.equal(client.getCacheStats().files, 0);
    assert.equal(lastBody.top_k, 15);
    assert.equal(lastBody.top_p, 1);
    assert.equal(lastBody.temperature, 1);
    assert.equal(lastBody.text_split_method, 'cut5');
    assert.equal(lastBody.batch_size, 1);
    assert.equal(lastBody.fragment_interval, 0.32);
    assert.equal(lastBody.sample_steps, 32);
    assert.equal(lastBody.use_cuda_graph, true);
    assert.equal(lastBody.use_flash_attention, true);
    assert.equal(lastBody.media_type, 'wav');
    assert.equal(lastBody.parallel_infer, true);
    assert.equal(lastBody.streaming_mode, false);

    // Calling prewarm again skips redundant inference
    const pw2 = await client.prewarm();
    assert.equal(pw2.alreadyPrewarmed, true);
    assert.equal(ttsCalls, 1);

    // 2. Synthesize caches via SHA-256 and invalidates when inferParams change
    const first = await client.synthesize({ text: '主人辛苦啦', emotion: '温柔' });
    assert.equal(first.cached, false);
    assert.equal(ttsCalls, 2);
    assert.equal(lastBody.ref_audio_path, refPath);
    assert.equal(lastBody.speed_factor, 0.96);

    const second = await client.synthesize({ text: '主人辛苦啦', emotion: '温柔' });
    assert.equal(second.cached, true);
    assert.equal(second.latencyMs, 0);
    assert.equal(ttsCalls, 2); // ZERO GPU / backend calls!
    assert.equal(client.getCacheStats().hitRate, 50);

    // Changing sample_steps must produce a new cache key
    store.update({ tts: { inferParams: { sample_steps: 16 } } });
    const third = await client.synthesize({ text: '主人辛苦啦', emotion: '温柔' });
    assert.equal(third.cached, false);
    assert.equal(ttsCalls, 3);
    assert.equal(lastBody.sample_steps, 16);
  } finally {
    mockServer.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('BridgeEngine delivers text immediately before slow async voice synthesis finishes in dualTrack mode', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyqq-async-voice-'));
  const store = new ConfigStore(dir);
  store.load();
  store.update({
    onebot: { enabled: false },
    tts: { enabled: true, dualTrack: true },
    stickers: { enabled: false },
    bilibili: { enabled: false },
    guard: { chunkDelaySec: 0 }
  });
  const engine = new BridgeEngine({ rootDir: dir, configStore: store });
  try {
    const events = [];
    const t0 = Date.now();
    engine.sessionManager = {
      getSessionInfo: () => ({ turnCount: 0 }),
      async ask() {
        return {
          text: '[情绪:调皮] 文字秒发出来啦喵~ [语音:语音稍后补上哦喵]',
          model: 'mock-model',
          latencyMs: 10,
          usage: { totalTokens: 100 },
          contextStatus: { used: 100, budget: 256000, overflowed: false }
        };
      }
    };
    engine.sovitsClient = {
      async synthesize({ text, emotion }) {
        await new Promise((r) => setTimeout(r, 220));
        return { buffer: Buffer.from('RIFF0000WAVE'), emotion, cached: false, latencyMs: 220, text };
      }
    };
    engine.onebotClient = {
      connected: true,
      async sendText({ text }) {
        events.push({ kind: 'text', text, atMs: Date.now() - t0 });
        return { message_id: 1 };
      },
      async sendVoiceBuffer() {
        events.push({ kind: 'voice', atMs: Date.now() - t0 });
        return { message_id: 2 };
      }
    };

    const lastItem = {
      messageType: 'group',
      groupId: '888888',
      userId: '100001',
      senderName: 'TesterA',
      messageId: '900',
      text: '你好',
      images: [],
      links: [],
      lane: 'group',
      triggerMode: 'at',
      isAtSelf: true
    };
    await engine._handleMergedBatch({
      sessionKey: 'group:888888',
      items: [lastItem],
      count: 1,
      text: '你好',
      images: [],
      lastItem
    });

    // Right when _handleMergedBatch returns, text MUST already be sent while voice is still synthesizing!
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'text');
    assert.ok(events[0].atMs < 150, `Expected fast text delivery, got ${events[0].atMs}ms`);

    // Wait for serialized async voice queue to finish
    await engine._voiceQueue;
    assert.equal(events.length, 2);
    assert.equal(events[1].kind, 'voice');
    assert.ok(events[1].atMs >= 180, `Expected async voice after synth delay, got ${events[1].atMs}ms`);
  } finally {
    engine.stickerStore.close();
    engine.lorebookStore.close();
    engine.memeWikiStore.close();
    engine.tokenStore.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
