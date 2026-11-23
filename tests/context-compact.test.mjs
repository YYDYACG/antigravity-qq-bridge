import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigStore } from '../src/config/schema.js';
import { OwnerGuard } from '../src/guard/owner-guard.js';
import { LorebookStore } from '../src/lorebook/lorebook-store.js';
import { SessionManager } from '../src/acp/session-manager.js';

function createMockWorker({ failSummary = false } = {}) {
  let sidCounter = 1;
  const closed = [];
  const prompts = [];
  let simulatedContextUsed = 260000;

  return {
    name: 'mock-worker',
    child: { pid: 12345 },
    closed,
    prompts,
    async ensureStarted() {},
    async createSession() {
      const id = `mock-sid-${sidCounter++}`;
      simulatedContextUsed = 18000;
      return { sessionId: id, configOptions: [], models: { availableModels: [] } };
    },
    async loadSession() {},
    async setConfigOption() {},
    async closeSession(sid) {
      closed.push(sid);
    },
    async prompt(sid, blocks) {
      const text = blocks.map((b) => b.text || '').join('\n');
      prompts.push({ sid, text });
      if (text.includes('系统内部记忆整理指令')) {
        if (failSummary) throw new Error('simulated summary timeout');
        return {
          text: '1. 正在和主人测试 256K 无感压缩接力。\n2. 约定周末一起看新番。\n3. 气氛轻松愉快。',
          usage: { inputTokens: 2000, outputTokens: 120, totalTokens: 2120 },
          latencyMs: 120
        };
      }
      // First normal turn simulates hitting 260K budget; after compaction starts fresh at 19K
      const used = sid === 'mock-sid-1' ? 260000 : 19500;
      return {
        text: `收到喵！(sid=${sid})`,
        contextUsed: used,
        contextSize: 1048576,
        usage: { inputTokens: 1000, outputTokens: 50, totalTokens: 1050 },
        latencyMs: 80
      };
    },
    getStatus() {
      return { ready: true, pid: 12345 };
    },
    async stop() {}
  };
}

test('SessionManager Scheme A compacts at 256K budget, archives summary, clears lore cooldown, and carries handoff cleanly across restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyqq-compact-'));
  const store = new ConfigStore(dir);
  store.load();
  const lore = new LorebookStore(dir, store);
  const guard = new OwnerGuard(store);
  const mgr = new SessionManager({ rootDir: dir, configStore: store, ownerGuard: guard, lorebookStore: lore });
  const mockWorker = createMockWorker();
  mgr.groupWorker = mockWorker;
  mgr.ownerWorker = mockWorker;

  try {
    lore.addEntry({
      title: '测试梗',
      category: '网络热梗',
      scope: 'global',
      keys: ['测试梗'],
      content: '用于验证压缩后冷却清零。'
    });
    lore.matchForTurn({ text: '聊聊测试梗', scope: 'group:100', sessionKey: 'group:100', currentTurn: 1 });
    assert.equal(lore.sessionCooldowns.has('group:100'), true);

    // Turn 1 hits 260,000 >= 256,000 budget
    const r1 = await mgr.ask({ sessionKey: 'group:100', lane: 'group', text: '我们约定周末一起看新番吧' });
    assert.equal(r1.contextStatus.budget, 256000);
    assert.equal(r1.contextStatus.overflowed, true);
    assert.equal(r1.contextStatus.action, 'compact');

    // Run Scheme A compaction
    const comp = await mgr.compactSession('group:100', { mode: 'compact', reason: 'budget-reached' });
    assert.equal(comp.compacted, true);
    assert.equal(comp.prevContextUsed, 260000);
    assert.equal(comp.usedFallback, false);
    assert.ok(comp.summaryChars > 20);
    assert.ok(fs.existsSync(comp.archivePath));
    assert.deepEqual(mockWorker.closed, ['mock-sid-1']);
    assert.equal(lore.sessionCooldowns.has('group:100'), false);

    // Simulate daemon restart BEFORE next message -> new SessionManager must load pending carryover from disk!
    const mgr2 = new SessionManager({ rootDir: dir, configStore: store, ownerGuard: guard, lorebookStore: lore });
    mgr2.groupWorker = mockWorker;
    mgr2.ownerWorker = mockWorker;

    const r2 = await mgr2.ask({ sessionKey: 'group:100', lane: 'group', text: '对了我们刚才约的啥来着？' });
    assert.equal(r2.sessionId, 'mock-sid-2');
    assert.equal(r2.contextStatus.overflowed, false);

    const lastPrompt = mockWorker.prompts[mockWorker.prompts.length - 1];
    assert.match(lastPrompt.text, /前情记忆交接单/);
    assert.match(lastPrompt.text, /约定周末一起看新番/);
    assert.match(lastPrompt.text, /交接前最后几轮对话原话/);
    assert.equal(mgr2.getSessionInfo('group:100').compactions, 1);
  } finally {
    lore.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SessionManager Scheme A falls back gracefully to verbatim recent turns if summary generation fails', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyqq-compact-fb-'));
  const store = new ConfigStore(dir);
  store.load();
  const guard = new OwnerGuard(store);
  const mgr = new SessionManager({ rootDir: dir, configStore: store, ownerGuard: guard });
  const mockWorker = createMockWorker({ failSummary: true });
  mgr.groupWorker = mockWorker;
  mgr.ownerWorker = mockWorker;

  try {
    await mgr.ask({ sessionKey: 'private:42', lane: 'owner', text: '明天早上记得叫我起床' });
    const comp = await mgr.compactSession('private:42', { mode: 'compact', reason: 'budget-reached' });
    assert.equal(comp.compacted, true);
    assert.equal(comp.usedFallback, true);
    assert.equal(comp.carriedTurns, 1);

    const r2 = await mgr.ask({ sessionKey: 'private:42', lane: 'owner', text: '嗯嗯谢谢' });
    assert.equal(r2.sessionId, 'mock-sid-2');
    const lastPrompt = mockWorker.prompts[mockWorker.prompts.length - 1];
    assert.match(lastPrompt.text, /明天早上记得叫我起床/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
