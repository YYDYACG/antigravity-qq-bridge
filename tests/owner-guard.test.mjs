import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigStore } from '../src/config/schema.js';
import { OwnerGuard } from '../src/guard/owner-guard.js';
import { BridgeEngine } from '../src/engine/bridge-engine.js';

function makeEnv(patch = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyqq-guard-'));
  const store = new ConfigStore(dir);
  store.load();
  store.update({
    guard: {
      ownerUsers: ['100001'],
      allowGroups: ['888888'],
      allowPrivate: ['200002'],
      denyUsers: ['999999'],
      allowOwnerToolsInGroups: false,
      ownerToolsEnabled: true,
      autoApproveOwnerTools: true,
      groupRequireAtOrKeyword: true,
      triggerKeywords: ['幽兰', '在吗'],
      ...patch
    }
  });
  return { dir, store, guard: new OwnerGuard(store) };
}

test('Owner private chat gets privileged owner lane and tool authorization', () => {
  const { dir, guard } = makeEnv();
  try {
    const res = guard.evaluateIncoming({ messageType: 'private', userId: '100001', text: '帮我查一下代码' });
    assert.equal(res.allowed, true);
    assert.equal(res.lane, 'owner');
    assert.equal(res.isOwner, true);

    const perm = guard.decideAcpToolPermission({ lane: res.lane, toolName: 'run_command', toolKind: 'execute' });
    assert.equal(perm.allow, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Owner in group chat is strictly downgraded to group sandbox lane and blocked from tools', () => {
  const { dir, guard } = makeEnv();
  try {
    const res = guard.evaluateIncoming({
      messageType: 'group',
      groupId: '888888',
      userId: '100001',
      isAtSelf: true,
      text: '执行 rm -rf'
    });
    assert.equal(res.allowed, true);
    assert.equal(res.lane, 'group');
    assert.equal(res.reason, 'group-owner-sandboxed');

    const perm = guard.decideAcpToolPermission({ lane: res.lane, toolName: 'run_command', toolKind: 'execute' });
    assert.equal(perm.allow, false);
    assert.equal(perm.reason, 'group-tools-blocked');
    assert.equal(guard.getAuditLog()[0].action, 'deny');

    // Exact single-file readonly whitelist allows ONLY sticker-catalog.md in group sandbox
    const catalogPath = path.join(dir, 'data', 'sticker-catalog.md');
    fs.mkdirSync(path.dirname(catalogPath), { recursive: true });
    fs.writeFileSync(catalogPath, '# catalog', 'utf8');
    guard.allowReadonlyFile(catalogPath);

    const allowCatalog = guard.decideAcpToolPermission({
      lane: 'group',
      toolName: 'read_file',
      toolKind: 'read',
      toolArgs: { Path: catalogPath }
    });
    assert.equal(allowCatalog.allow, true);
    assert.equal(allowCatalog.reason, 'sticker-catalog-readonly-whitelisted');

    // Any other file or path traversal MUST be blocked in group sandbox
    const denyOther = guard.decideAcpToolPermission({
      lane: 'group',
      toolName: 'read_file',
      toolKind: 'read',
      toolArgs: { Path: path.join(dir, 'data', '..', 'config.json') }
    });
    assert.equal(denyOther.allow, false);
    assert.equal(denyOther.reason, 'group-tools-blocked');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Non-owner whitelisted private user never gets owner lane', () => {
  const { dir, guard } = makeEnv();
  try {
    const res = guard.evaluateIncoming({ messageType: 'private', userId: '200002', text: '你好' });
    assert.equal(res.allowed, true);
    assert.equal(res.lane, 'group');
    assert.equal(res.isOwner, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Denied users and unmentioned group messages are rejected properly', () => {
  const { dir, guard } = makeEnv();
  try {
    const denied = guard.evaluateIncoming({ messageType: 'private', userId: '999999', text: 'hi' });
    assert.equal(denied.allowed, false);
    assert.equal(denied.reason, 'user-denied');

    const passive = guard.evaluateIncoming({
      messageType: 'group',
      groupId: '888888',
      userId: '200002',
      isAtSelf: false,
      text: '今天午饭吃啥'
    });
    assert.equal(passive.allowed, false);
    assert.equal(passive.passiveObserve, true);

    const kwHit = guard.evaluateIncoming({
      messageType: 'group',
      groupId: '888888',
      userId: '200002',
      isAtSelf: false,
      text: '幽兰今天心情怎么样'
    });
    assert.equal(kwHit.allowed, true);
    assert.equal(kwHit.lane, 'group');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Group active window keeps bot attentive after @/reply-to-self, caps runaway replies, and expires cleanly', () => {
  const { dir, guard } = makeEnv({
    groupActiveWindowSec: 180,
    groupActiveMaxReplies: 2
  });
  try {
    const t0 = 1_000_000;

    // 1. Direct @ triggers and activates 180s window
    const r1 = guard.evaluateIncoming({
      messageType: 'group',
      groupId: '888888',
      userId: '200002',
      isAtSelf: true,
      text: '出来玩呀',
      now: t0
    });
    assert.equal(r1.allowed, true);
    assert.equal(r1.triggerMode, 'at');
    assert.equal(r1.activeRemainingSec, 180);

    // 2. Follow-up 30s later WITHOUT @ enters via active-window
    const r2 = guard.evaluateIncoming({
      messageType: 'group',
      groupId: '888888',
      userId: '200002',
      isAtSelf: false,
      text: '你觉得今晚吃啥好？',
      now: t0 + 30_000
    });
    assert.equal(r2.allowed, true);
    assert.equal(r2.triggerMode, 'active-window');
    assert.equal(r2.reason, 'group-active-window');

    // Simulate 2 active-window replies -> hits maxReplies cap (2)
    guard.touchGroupActive('888888', { countReply: true, now: t0 + 35_000 });
    guard.touchGroupActive('888888', { countReply: true, now: t0 + 60_000 });

    const rCap = guard.evaluateIncoming({
      messageType: 'group',
      groupId: '888888',
      userId: '200002',
      isAtSelf: false,
      text: '哈哈群友继续闲聊',
      now: t0 + 70_000
    });
    assert.equal(rCap.allowed, false);
    assert.equal(rCap.passiveObserve, true);

    // 3. Direct reply-to-self resets the cap and refreshes active window!
    const rReply = guard.evaluateIncoming({
      messageType: 'group',
      groupId: '888888',
      userId: '200002',
      isAtSelf: false,
      isReplyToSelf: true,
      text: '那你推荐个口味呗',
      now: t0 + 80_000
    });
    assert.equal(rReply.allowed, true);
    assert.equal(rReply.triggerMode, 'reply-to-self');

    // 4. After 180s without activity, expires back to passiveObserve
    const rExp = guard.evaluateIncoming({
      messageType: 'group',
      groupId: '888888',
      userId: '200002',
      isAtSelf: false,
      text: '过了好久了',
      now: t0 + 80_000 + 181_000
    });
    assert.equal(rExp.allowed, false);
    assert.equal(rExp.passiveObserve, true);

    // 5. Deactivate immediately silences active window
    guard.activateGroup('888888', { now: t0 + 400_000 });
    assert.equal(guard.getGroupActiveStatus('888888', t0 + 401_000).active, true);
    guard.deactivateGroup('888888');
    assert.equal(guard.getGroupActiveStatus('888888', t0 + 401_000).active, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Peer bots and @-other-only messages stay 0-token passive, and consecutive silences auto-exit active window', () => {
  const { dir, guard } = makeEnv({
    peerBotUsers: ['300003'],
    peerBotNames: ['友商A', '机器人A'],
    groupActiveWindowSec: 180,
    groupActiveMaxConsecutiveSilent: 2
  });
  try {
    const t0 = 2_000_000;
    // Activate group via human
    const wake = guard.evaluateIncoming({
      messageType: 'group',
      groupId: '888888',
      userId: '100001',
      text: '幽兰出来聊会',
      now: t0
    });
    assert.equal(wake.allowed, true);
    assert.equal(wake.triggerMode, 'keyword');

    // Peer bot speaking during active window (even containing keyword or @) is strictly passive-only!
    const peerRes = guard.evaluateIncoming({
      messageType: 'group',
      groupId: '888888',
      userId: '300003',
      isAtSelf: true,
      text: '幽兰我也来聊两句',
      now: t0 + 2000
    });
    assert.equal(peerRes.allowed, false);
    assert.equal(peerRes.reason, 'peer-bot-passive-only');
    assert.equal(peerRes.passiveObserve, true);

    // Human explicitly @-mentioning another person/bot while mentioning keyword does NOT wake or refresh active window
    const atOther = guard.evaluateIncoming({
      messageType: 'group',
      groupId: '888888',
      userId: '200002',
      isAtSelf: false,
      isAtOtherOnly: true,
      text: '画一张你在嘲笑幽兰的图片',
      now: t0 + 5000
    });
    assert.equal(atOther.allowed, false);
    assert.equal(atOther.reason, 'group-at-other-passive');
    assert.equal(atOther.passiveObserve, true);

    // Human calling peer bot by name ONLY (without @self / replyToSelf / own trigger keyword) stays passive
    const peerNameOnly = guard.evaluateIncoming({
      messageType: 'group',
      groupId: '888888',
      userId: '200002',
      text: '说的就是你友商A',
      now: t0 + 6000
    });
    assert.equal(peerNameOnly.allowed, false);
    assert.equal(peerNameOnly.reason, 'group-peer-bot-name-passive');
    assert.equal(peerNameOnly.passiveObserve, true);

    // Human mentioning peer bot name TOGETHER with own trigger keyword or @self STILL wakes bot!
    const bothNames = guard.evaluateIncoming({
      messageType: 'group',
      groupId: '888888',
      userId: '100001',
      text: '幽兰帮友商A看看这张图',
      now: t0 + 7000
    });
    assert.equal(bothNames.allowed, true);
    assert.equal(bothNames.triggerMode, 'keyword');

    // First silence increments counter without deactivating yet
    const s1 = guard.recordGroupSilent('888888', t0 + 10_000);
    assert.equal(s1.deactivated, false);
    assert.equal(s1.consecutiveSilent, 1);
    assert.equal(guard.getGroupActiveStatus('888888', t0 + 11_000).active, true);

    // A real reply resets consecutiveSilent back to 0
    guard.touchGroupActive('888888', { countReply: true, now: t0 + 12_000 });
    const sReset = guard.recordGroupSilent('888888', t0 + 15_000);
    assert.equal(sReset.deactivated, false);
    assert.equal(sReset.consecutiveSilent, 1);

    // Second consecutive silence immediately exits active window back to 0-token passive!
    const s2 = guard.recordGroupSilent('888888', t0 + 20_000);
    assert.equal(s2.deactivated, true);
    assert.equal(s2.consecutiveSilent, 2);
    assert.equal(guard.getGroupActiveStatus('888888', t0 + 21_000).active, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('BridgeEngine labels multi-sender group merge cleanly, protects keyword calls from silence, and auto-sleeps on 2x [静默]', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyqq-group-merge-'));
  const store = new ConfigStore(dir);
  store.load();
  store.update({
    onebot: { enabled: false },
    tts: { enabled: false },
    stickers: { enabled: false },
    bilibili: { enabled: false },
    memewiki: { enabled: false },
    guard: {
      allowGroups: ['888888'],
      groupActiveWindowSec: 180,
      groupActiveMaxConsecutiveSilent: 2,
      chunkDelaySec: 0
    }
  });
  const engine = new BridgeEngine({ rootDir: dir, configStore: store });
  const askCalls = [];
  const sentReplies = [];
  let nextAiText = '本喵听到啦喵~';

  try {
    engine.sessionManager = {
      getSessionInfo: () => ({ turnCount: 0 }),
      async ask(payload) {
        askCalls.push(payload);
        return {
          text: nextAiText,
          model: 'mock-model',
          latencyMs: 5,
          usage: { totalTokens: 10 },
          contextStatus: { used: 10, budget: 256000, overflowed: false }
        };
      }
    };
    engine.onebotClient = {
      connected: true,
      async sendText(payload) {
        sentReplies.push(payload);
        return { message_id: 500 };
      }
    };

    // 1. Multi-sender batch where user1 triggered by keyword and user2 jumped in 1s later
    const item1 = {
      messageType: 'group',
      groupId: '888888',
      userId: '100001',
      senderName: 'TesterA',
      messageId: '1001',
      text: '猫猫你倒是花不了多少',
      images: [],
      links: [],
      lane: 'group',
      triggerMode: 'keyword',
      isAtSelf: false
    };
    const item2 = {
      messageType: 'group',
      groupId: '888888',
      userId: '200002',
      senderName: 'TesterB',
      messageId: '1002',
      text: '哈哈哈确实',
      images: [],
      links: [],
      lane: 'group',
      triggerMode: 'active-window',
      isAtSelf: false
    };
    engine.ownerGuard.activateGroup('888888');
    await engine._handleMergedBatch({
      sessionKey: 'group:888888',
      items: [item1, item2],
      count: 2,
      text: 'TesterA: 猫猫你倒是花不了多少\nTesterB: 哈哈哈确实',
      images: [],
      lastItem: item2
    });

    assert.equal(askCalls.length, 1);
    assert.match(askCalls[0].text, /^\[群聊多条消息\]\nTesterA: 猫猫/);
    assert.doesNotMatch(askCalls[0].text, /^\[群友 TesterB\]/);
    assert.match(askCalls[0].lorebookBlock, /\[群聊点名提示：.*不要输出 \[静默\]/);
    assert.equal(sentReplies[0].replyToId, '1001'); // replies to keyword caller, not interrupter!

    // 1b. Bare @-self summon with empty text MUST NOT be dropped as an empty message
    const bareAtItem = {
      ...item1,
      messageId: '1002b',
      text: '',
      triggerMode: 'at',
      isAtSelf: true
    };
    await engine._handleMergedBatch({
      sessionKey: 'group:888888',
      items: [bareAtItem],
      count: 1,
      text: '',
      images: [],
      lastItem: bareAtItem
    });
    assert.equal(askCalls.length, 2);
    assert.match(askCalls[1].text, /^\[群友 TesterA @了你\] （只 @了你，没打字）$/);

    // 2. Two consecutive [静默] during active window auto-deactivate the active window
    nextAiText = '[静默]';
    const silentItem = { ...item2, messageId: '1003', text: '群友闲聊中' };
    await engine._handleMergedBatch({
      sessionKey: 'group:888888',
      items: [silentItem],
      count: 1,
      text: '群友闲聊中',
      images: [],
      lastItem: silentItem
    });
    assert.equal(engine.ownerGuard.getGroupActiveStatus('888888').active, true);

    await engine._handleMergedBatch({
      sessionKey: 'group:888888',
      items: [silentItem],
      count: 1,
      text: '群友继续闲聊',
      images: [],
      lastItem: silentItem
    });
    assert.equal(engine.ownerGuard.getGroupActiveStatus('888888').active, false);
  } finally {
    engine.stickerStore.close();
    engine.lorebookStore.close();
    engine.memeWikiStore.close();
    engine.tokenStore.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
