import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseOneBotMessageEvent, parseCqString } from '../src/onebot/message-parser.js';
import { resolveForwardMessages } from '../src/onebot/forward-resolver.js';
import { ConfigStore } from '../src/config/schema.js';
import { BridgeEngine } from '../src/engine/bridge-engine.js';

test('parseCqString parses CQ codes with escaped chars', () => {
  const segs = parseCqString('[CQ:at,qq=10086] 你好 [CQ:image,url=https://example.com/a.png,sub_type=1]');
  assert.equal(segs.length, 3);
  assert.equal(segs[0].type, 'at');
  assert.equal(segs[0].data.qq, '10086');
  assert.equal(segs[2].type, 'image');
  assert.equal(segs[2].data.sub_type, '1');
});

test('parseOneBotMessageEvent handles array segments, at-self, reply, and sticker detection', () => {
  const evt = {
    self_id: 777000,
    user_id: 123456,
    group_id: 987654,
    message_type: 'group',
    message_id: 555,
    sender: { card: '摸鱼群友', nickname: 'Alice' },
    message: [
      { type: 'reply', data: { id: 550 } },
      { type: 'at', data: { qq: '777000' } },
      { type: 'text', data: { text: ' 看看这张图 ' } },
      { type: 'image', data: { url: 'https://cdn.qq.com/pic.png', sub_type: 1, summary: '[动画表情]' } }
    ]
  };
  const parsed = parseOneBotMessageEvent(evt);
  assert.equal(parsed.sessionKey, 'group:987654');
  assert.equal(parsed.isAtSelf, true);
  assert.equal(parsed.replyToId, '550');
  assert.equal(parsed.senderName, '摸鱼群友');
  assert.equal(parsed.text, '看看这张图');
  assert.equal(parsed.images.length, 1);
  assert.equal(parsed.images[0].isSticker, true);
});

test('parseOneBotMessageEvent parses Bilibili QQ mini-app JSON card text and cover preview image', () => {
  const cardJson = JSON.stringify({
    app: 'com.tencent.miniapp_01',
    prompt: '[QQ小程序]哔哩哔哩',
    meta: {
      detail_1: {
        title: '哔哩哔哩',
        desc: '捡个猫家人们，她想和我回家',
        preview: 'i0.hdslb.com/bfs/archive/catgirl.jpg',
        qqdocurl: 'https://b23.tv/abc123',
        host: { nick: 'Yueあやめ' }
      }
    }
  });
  const evt = {
    self_id: 900001,
    user_id: 200002,
    group_id: 888888,
    message_type: 'group',
    message_id: 999,
    sender: { nickname: 'TesterB' },
    message: [{ type: 'json', data: { data: cardJson } }]
  };
  const parsed = parseOneBotMessageEvent(evt);
  assert.match(parsed.text, /\[分享卡片 · 哔哩哔哩\]/);
  assert.match(parsed.text, /捡个猫家人们，她想和我回家/);
  assert.match(parsed.text, /\(分享人: Yueあやめ\)/);
  assert.match(parsed.text, /https:\/\/b23\.tv\/abc123/);
  assert.equal(parsed.images.length, 1);
  assert.equal(parsed.images[0].url, 'https://i0.hdslb.com/bfs/archive/catgirl.jpg');
  assert.equal(parsed.images[0].isSticker, false);
  assert.equal(parsed.images[0].isCardPreview, true);
  assert.deepEqual(parsed.links, ['https://b23.tv/abc123']);
});

test('parseOneBotMessageEvent strips Bilibili tracking query in display text and normalizes mini-app path', () => {
  const cardJson = JSON.stringify({
    app: 'com.tencent.miniapp_01',
    prompt: '[QQ小程序]哔哩哔哩',
    meta: {
      detail_1: {
        title: '哔哩哔哩',
        desc: '测试小程序路径解析',
        url: 'pages/video/video?bvid=BV1GJ411x7h7',
        host: { nick: 'TesterB' }
      }
    }
  });
  const parsed = parseOneBotMessageEvent({
    self_id: 900001,
    user_id: 200002,
    group_id: 888888,
    message_type: 'group',
    message_id: 1000,
    sender: { nickname: 'TesterB' },
    message: [{ type: 'json', data: { data: cardJson } }]
  });
  assert.match(parsed.text, /https:\/\/www\.bilibili\.com\/video\/BV1GJ411x7h7/);
  assert.deepEqual(parsed.links, ['https://www.bilibili.com/video/BV1GJ411x7h7']);

  const xmlParsed = parseOneBotMessageEvent({
    self_id: 900001,
    user_id: 200002,
    group_id: 888888,
    message_type: 'group',
    message_id: 1001,
    sender: { nickname: 'TesterB' },
    message: [{ type: 'xml', data: { data: '<msg url="https://b23.tv/xyz999?share_source=qq&amp;bbid=1"><item><title>XML视频</title></item></msg>' } }]
  });
  assert.match(xmlParsed.text, /https:\/\/b23\.tv\/xyz999/);
  assert.ok(!xmlParsed.text.includes('share_source=qq'));
  assert.deepEqual(xmlParsed.links, ['https://b23.tv/xyz999?share_source=qq&bbid=1']);
});

test('parseOneBotMessageEvent and resolveForwardMessages expand multi-message forwards, images, nested forwards, and limits cleanly', async () => {
  const evt = {
    self_id: 900001,
    user_id: 100001,
    group_id: 888888,
    message_type: 'group',
    message_id: 2001,
    sender: { nickname: 'TesterA' },
    message: [{ type: 'forward', data: { id: 'fwd_root_1' } }]
  };
  const parsed = parseOneBotMessageEvent(evt);
  assert.equal(parsed.text, '[合并转发聊天记录]');
  assert.deepEqual(parsed.forwards, [{ id: 'fwd_root_1', content: null }]);

  const mockOnebot = {
    async getForwardMsg(id) {
      if (id === 'fwd_root_1') {
        return {
          messages: [
            // Shape A: NapCat direct message object with text + image + control tags
            {
              user_id: 100001,
              sender: { card: 'TesterA' },
              message: [
                { type: 'text', data: { text: '[情绪:生气] 看看这张图 [静默]' } },
                { type: 'image', data: { url: 'https://cdn.qq.com/img1.png', sub_type: 0 } }
              ]
            },
            // Shape B: OneBot node wrapper with 2 images (2nd hits maxImages=2? wait 3rd overflows!)
            {
              type: 'node',
              data: {
                nickname: 'TesterB',
                user_id: 200002,
                content: [
                  { type: 'image', data: { url: 'https://cdn.qq.com/img2.gif', sub_type: 1 } },
                  { type: 'image', data: { url: 'https://cdn.qq.com/img3.png', sub_type: 0 } },
                  { type: 'text', data: { text: '这两张笑死我了' } }
                ]
              }
            },
            // Nested forward reference
            {
              user_id: 300003,
              sender: { nickname: 'TesterC' },
              message: [{ type: 'forward', data: { id: 'fwd_nested_2' } }]
            }
          ]
        };
      }
      if (id === 'fwd_nested_2') {
        return {
          messages: [
            {
              user_id: 100001,
              sender: { nickname: 'TesterA' },
              message: [
                { type: 'text', data: { text: '嵌套里的消息' } },
                // Circular reference back to root must not infinite-loop
                { type: 'forward', data: { id: 'fwd_root_1' } }
              ]
            }
          ]
        };
      }
      throw new Error('expired');
    }
  };

  const res = await resolveForwardMessages({
    forwards: parsed.forwards,
    onebotClient: mockOnebot,
    maxDepth: 2,
    maxMessages: 25,
    maxChars: 2500,
    maxImages: 2,
    imageStartIndex: 1
  });

  assert.equal(res.images.length, 2);
  assert.equal(res.images[0].url, 'https://cdn.qq.com/img1.png');
  assert.equal(res.images[1].url, 'https://cdn.qq.com/img2.gif');
  assert.equal(res.images[1].isSticker, false);
  assert.equal(res.images[1].isForwardedImage, true);
  assert.match(res.promptBlock, /\[合并转发聊天记录（共展开 \d+ 条，附带 2 张图/);
  assert.match(res.promptBlock, /另有 1 张图超出看图上限未加载/);
  assert.match(res.promptBlock, /- TesterA: \[图1\] 看看这张图/);
  assert.doesNotMatch(res.promptBlock, /\[情绪:生气\]|\[静默\]/);
  assert.match(res.promptBlock, /- TesterB: \[图2\]\[图片·超出看图上限未加载\] 这两张笑死我了/);
  assert.match(res.promptBlock, /  - TesterA: 嵌套里的消息/);

  // Graceful fallback when forward is expired/unavailable
  const failed = await resolveForwardMessages({
    forwards: [{ id: 'fwd_expired', content: null }],
    onebotClient: mockOnebot
  });
  assert.equal(failed.messageCount, 0);
  assert.deepEqual(failed.failedIds, ['fwd_expired']);
  assert.match(failed.promptBlock, /合并转发聊天记录读取失败/);
});

test('BridgeEngine expands recent ambient merged-forward with its images when user subsequently @-mentions bot', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyqq-fwd-engine-'));
  const store = new ConfigStore(dir);
  store.load();
  store.update({
    onebot: { enabled: false },
    tts: { enabled: false },
    stickers: { enabled: false },
    bilibili: { enabled: false },
    memewiki: { enabled: false },
    guard: { allowGroups: ['888888'], chunkDelaySec: 0 }
  });
  const engine = new BridgeEngine({ rootDir: dir, configStore: store });
  const askPayloads = [];
  const fetchedMetas = [];

  try {
    engine.onebotClient = {
      connected: true,
      async getForwardMsg(id) {
        assert.equal(id, 'fwd_amb_9');
        return {
          messages: [
            {
              user_id: 100001,
              sender: { nickname: 'TesterA' },
              message: [
                { type: 'text', data: { text: '转发测试正文' } },
                { type: 'image', data: { url: 'https://cdn.qq.com/fwd_pic.png' } }
              ]
            }
          ]
        };
      },
      async sendText() {
        return { message_id: 1 };
      }
    };
    engine.visionFetcher = {
      async prepareImagesForTurn(metas) {
        fetchedMetas.push(...metas);
        return metas.map((m) => ({
          mimeType: 'image/png',
          base64: 'AA==',
          sha256: 'deadbeef',
          animation: null,
          sourceUrl: m.url
        }));
      }
    };
    engine.sessionManager = {
      getSessionInfo: () => ({ turnCount: 0 }),
      async ask(payload) {
        askPayloads.push(payload);
        return {
          text: '看到转发里的图和内容啦喵~',
          model: 'mock-model',
          latencyMs: 5,
          usage: { totalTokens: 20 },
          contextStatus: { used: 20, budget: 256000, overflowed: false }
        };
      }
    };

    // 1. User drops a merged forward while bot is dormant -> stored in ambient buffer
    engine._recordAmbientGroupMessage({
      messageType: 'group',
      groupId: '888888',
      userId: '100001',
      senderName: 'TesterA',
      text: '[合并转发聊天记录]',
      images: [],
      links: [],
      forwards: [{ id: 'fwd_amb_9', content: null }]
    });

    // 2. Seconds later user @-mentions bot to look at it
    const item = {
      messageType: 'group',
      groupId: '888888',
      userId: '100001',
      senderName: 'TesterA',
      messageId: '2010',
      text: '帮我看看上面那个转发',
      images: [],
      links: [],
      forwards: [],
      lane: 'group',
      triggerMode: 'at',
      isAtSelf: true
    };
    await engine._handleMergedBatch({
      sessionKey: 'group:888888',
      items: [item],
      count: 1,
      text: '帮我看看上面那个转发',
      images: [],
      lastItem: item
    });

    assert.equal(askPayloads.length, 1);
    assert.equal(fetchedMetas.length, 1);
    assert.equal(fetchedMetas[0].url, 'https://cdn.qq.com/fwd_pic.png');
    assert.equal(askPayloads[0].images.length, 1);
    assert.match(askPayloads[0].lorebookBlock, /\[合并转发聊天记录/);
    assert.match(askPayloads[0].lorebookBlock, /- TesterA: \[图1\] 转发测试正文/);
  } finally {
    engine.stickerStore.close();
    engine.lorebookStore.close();
    engine.memeWikiStore.close();
    engine.tokenStore.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('BridgeEngine carries recent ambient regular image when user sends image first and calls bot seconds later', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyqq-amb-img-'));
  const store = new ConfigStore(dir);
  store.load();
  store.update({
    onebot: { enabled: false },
    tts: { enabled: false },
    stickers: { enabled: false },
    bilibili: { enabled: false },
    memewiki: { enabled: false },
    guard: { allowGroups: ['888888'], chunkDelaySec: 0 }
  });
  const engine = new BridgeEngine({ rootDir: dir, configStore: store });
  const askPayloads = [];
  const fetchedMetas = [];

  try {
    engine.onebotClient = {
      connected: true,
      async sendText() {
        return { message_id: 2 };
      }
    };
    engine.visionFetcher = {
      async prepareImagesForTurn(metas) {
        fetchedMetas.push(...metas);
        return metas.map((m) => ({
          mimeType: 'image/png',
          base64: 'AA==',
          sha256: 'cafebabe',
          animation: null,
          sourceUrl: m.url
        }));
      }
    };
    engine.sessionManager = {
      getSessionInfo: () => ({ turnCount: 0 }),
      async ask(payload) {
        askPayloads.push(payload);
        return {
          text: '看到你刚才发的那张图啦喵~',
          model: 'mock-model',
          latencyMs: 5,
          usage: { totalTokens: 20 },
          contextStatus: { used: 20, budget: 256000, overflowed: false }
        };
      }
    };

    // 1. User drops a regular image while bot is dormant -> stored in ambient buffer
    engine._recordAmbientGroupMessage({
      messageType: 'group',
      groupId: '888888',
      userId: '100001',
      senderName: 'TesterA',
      text: '',
      images: [{ url: 'https://cdn.qq.com/neon_screenshot.png', isSticker: false, isCardPreview: false }],
      links: [],
      forwards: []
    });

    // 2. 30s later user sends "猫猫怎么看" without attaching the image again
    const item = {
      messageType: 'group',
      groupId: '888888',
      userId: '100001',
      senderName: 'TesterA',
      messageId: '3002',
      text: '猫猫怎么看',
      images: [],
      links: [],
      forwards: [],
      lane: 'group',
      triggerMode: 'keyword',
      isAtSelf: false
    };
    await engine._handleMergedBatch({
      sessionKey: 'group:888888',
      items: [item],
      count: 1,
      text: '猫猫怎么看',
      images: [],
      lastItem: item
    });

    assert.equal(askPayloads.length, 1);
    assert.equal(fetchedMetas.length, 1);
    assert.equal(fetchedMetas[0].url, 'https://cdn.qq.com/neon_screenshot.png');
    assert.equal(fetchedMetas[0].isAmbientImage, true);
    assert.equal(askPayloads[0].images.length, 1);
    assert.match(askPayloads[0].lorebookBlock, /- \[\d{2}:\d{2}\] TesterA: \[图1\]（已附带该图）/);

    // 3. Cross-hour (3h old) images from other group members ARE carried on back-reference cue ("他在玩什么梗"),
    //    while casual greeting ("猫猫早安") does NOT pull old images!
    const threeHoursAgo = Date.now() - 3 * 60 * 60 * 1000;
    engine._recordAmbientGroupMessage({
      messageType: 'group',
      groupId: '888888',
      userId: '200002',
      senderName: 'TesterB',
      text: '',
      images: [{ url: 'https://cdn.qq.com/old_meme_1.png', isSticker: false, isCardPreview: false }],
      links: [],
      forwards: [],
      timestamp: threeHoursAgo
    });
    engine._recordAmbientGroupMessage({
      messageType: 'group',
      groupId: '888888',
      userId: '300003',
      senderName: 'TesterC',
      text: '',
      images: [{ url: 'https://cdn.qq.com/old_meme_2.jpg', isSticker: false, isCardPreview: false }],
      links: [],
      forwards: [],
      timestamp: threeHoursAgo + 8000
    });

    const casualItem = { ...item, messageId: '3003', text: '猫猫早安' };
    await engine._handleMergedBatch({
      sessionKey: 'group:888888',
      items: [casualItem],
      count: 1,
      text: '猫猫早安',
      images: [],
      lastItem: casualItem
    });
    assert.equal(askPayloads.length, 2);
    assert.equal(askPayloads[1].images.length, 0); // casual greeting must NOT pull 3h-old images!

    // Re-seed same 3h-old ambient images, now user asks "猫猫，他在玩什么梗" -> carries BOTH images!
    engine._recordAmbientGroupMessage({
      messageType: 'group',
      groupId: '888888',
      userId: '200002',
      senderName: 'TesterB',
      text: '',
      images: [{ url: 'https://cdn.qq.com/old_meme_1.png', isSticker: false, isCardPreview: false }],
      links: [],
      forwards: [],
      timestamp: threeHoursAgo
    });
    engine._recordAmbientGroupMessage({
      messageType: 'group',
      groupId: '888888',
      userId: '300003',
      senderName: 'TesterC',
      text: '',
      images: [{ url: 'https://cdn.qq.com/old_meme_2.jpg', isSticker: false, isCardPreview: false }],
      links: [],
      forwards: [],
      timestamp: threeHoursAgo + 8000
    });

    const backRefItem = { ...item, messageId: '3004', text: '猫猫，他在玩什么梗' };
    await engine._handleMergedBatch({
      sessionKey: 'group:888888',
      items: [backRefItem],
      count: 1,
      text: '猫猫，他在玩什么梗',
      images: [],
      lastItem: backRefItem
    });
    assert.equal(askPayloads.length, 3);
    assert.equal(askPayloads[2].images.length, 2);
    assert.equal(askPayloads[2].images[0].sourceUrl, 'https://cdn.qq.com/old_meme_1.png');
    assert.equal(askPayloads[2].images[1].sourceUrl, 'https://cdn.qq.com/old_meme_2.jpg');
    assert.match(askPayloads[2].lorebookBlock, /- \[\d{2}:\d{2}\] TesterB: \[图1\]（已附带该图）/);
    assert.match(askPayloads[2].lorebookBlock, /- \[\d{2}:\d{2}\] TesterC: \[图2\]（已附带该图）/);
  } finally {
    engine.stickerStore.close();
    engine.lorebookStore.close();
    engine.memeWikiStore.close();
    engine.tokenStore.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
