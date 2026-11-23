import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WebSocketServer } from 'ws';
import { ConfigStore } from '../src/config/schema.js';
import { BridgeEngine } from '../src/engine/bridge-engine.js';
import { HubServer } from '../src/web/hub-server.js';

const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('HubServer enforces token auth and supports config, stickers CRUD, and status API', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyqq-hub-'));
  // Seed a minimal synthetic L2 memes.db to test /api/memewiki, L1+L2 test-match, and promote
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  const seedDb = new DatabaseSync(path.join(dir, 'data', 'memes.db'));
  seedDb.exec(`
    CREATE TABLE memes (title TEXT PRIMARY KEY, slug TEXT, tags TEXT, usage TEXT, origin TEXT, other TEXT, summary TEXT, aliases TEXT);
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO memes VALUES ('去码头整点薯条', 'matou', '二次元', '用海鸥哲学摆烂式接梗。', '海鸥漫画', '', '海鸥哲学', '码头薯条');
    INSERT INTO meta VALUES ('built_at', '2026-04-16 00:00:00');
  `);
  seedDb.close();

  const store = new ConfigStore(dir);
  store.load();
  store.update({
    hub: { host: '127.0.0.1', port: 13245 },
    onebot: { enabled: false },
    tts: { enabled: false }
  });
  const token = store.get().hub.token;
  const engine = new BridgeEngine({ rootDir: dir, configStore: store });
  const hub = new HubServer({ configStore: store, engine });

  try {
    const info = await hub.start();
    const base = `http://${info.host}:${info.port}`;

    // Unauthorized blocked
    const rUnauth = await fetch(`${base}/api/status`);
    assert.equal(rUnauth.status, 401);

    // Authorized status ok
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const rStatus = await fetch(`${base}/api/status`, { headers });
    assert.equal(rStatus.status, 200);
    const stJson = await rStatus.json();
    assert.equal(stJson.ok, true);

    // PATCH config hot update
    const rPatch = await fetch(`${base}/api/config`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ guard: { mergeWindowSec: 3.0, ownerUsers: ['777888'] } })
    });
    assert.equal(rPatch.status, 200);
    assert.equal(store.get().guard.mergeWindowSec, 3.0);
    assert.deepEqual(store.get().guard.ownerUsers, ['777888']);

    // Sticker upload + 2-gram search + file fetch + delete
    const rUp = await fetch(`${base}/api/stickers`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ imageBase64: `data:image/png;base64,${PNG_B64}`, tags: '摸鱼 喝奶茶' })
    });
    const upJson = await rUp.json();
    assert.equal(upJson.ok, true);
    const id = upJson.data.sticker.id;

    const rSearch = await fetch(`${base}/api/stickers?q=${encodeURIComponent('奶茶')}`, { headers });
    const searchJson = await rSearch.json();
    assert.equal(searchJson.data.items.length, 1);
    assert.equal(searchJson.data.items[0].id, id);

    const rFile = await fetch(`${base}/api/stickers/${id}/file`, { headers });
    assert.equal(rFile.status, 200);
    assert.equal(rFile.headers.get('content-type'), 'image/png');

    const rDel = await fetch(`${base}/api/stickers/${id}`, { method: 'DELETE', headers });
    const delJson = await rDel.json();
    assert.equal(delJson.removed, true);

    // Living Lorebook CRUD + test-match + SillyTavern export/import
    const rLoreAdd = await fetch(`${base}/api/lorebook`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        title: '曼波',
        category: '网络热梗',
        scope: 'global',
        keys: '曼波, mambo',
        content: '赛马娘诗歌剧魔性口头禅改编热梗。'
      })
    });
    const loreAdd = await rLoreAdd.json();
    assert.equal(loreAdd.ok, true);
    const loreId = loreAdd.data.id;

    const rLoreMatch = await fetch(`${base}/api/lorebook/test-match`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ text: '今天也要曼波一下，再去码头整点薯条', scope: 'global' })
    });
    const loreMatch = await rLoreMatch.json();
    assert.equal(loreMatch.data.entries.length, 1);
    assert.equal(loreMatch.data.entries[0].id, loreId);
    assert.equal(loreMatch.data.memewikiEntries.length, 1);
    assert.equal(loreMatch.data.memewikiEntries[0].title, '去码头整点薯条');

    // L2 MemeWiki search & promote-to-L1 (after promote, L1 wins and L2 dedups!)
    const rWikiSearch = await fetch(`${base}/api/memewiki?q=${encodeURIComponent('码头')}`, { headers });
    const wikiSearch = await rWikiSearch.json();
    assert.equal(wikiSearch.ok, true);
    assert.equal(wikiSearch.data.total, 1);
    assert.equal(wikiSearch.data.items[0].title, '去码头整点薯条');

    const rPromote = await fetch(`${base}/api/memewiki/promote`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: '去码头整点薯条', scope: 'global' })
    });
    const promoteJson = await rPromote.json();
    assert.equal(promoteJson.ok, true);
    const promotedId = promoteJson.data.id;

    const rAfterPromote = await fetch(`${base}/api/lorebook/test-match`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ text: '走去码头整点薯条', scope: 'global' })
    });
    const afterPromote = await rAfterPromote.json();
    assert.equal(afterPromote.data.entries.some((e) => e.title === '去码头整点薯条'), true);
    assert.equal(afterPromote.data.memewikiEntries.length, 0);

    await fetch(`${base}/api/lorebook/${promotedId}`, { method: 'DELETE', headers });

    const rLoreExport = await fetch(`${base}/api/lorebook/export/st`, { headers });
    assert.equal(rLoreExport.status, 200);
    const stExported = await rLoreExport.json();
    assert.ok(stExported.entries['0']);

    const rLoreImport = await fetch(`${base}/api/lorebook/import/st`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ json: stExported, defaultScope: 'global' })
    });
    const importJson = await rLoreImport.json();
    assert.equal(importJson.data.merged, 1);

    const rLoreDel = await fetch(`${base}/api/lorebook/${loreId}`, { method: 'DELETE', headers });
    assert.equal((await rLoreDel.json()).removed, true);
  } finally {
    await hub.stop();
    engine.stickerStore.close();
    engine.lorebookStore.close();
    engine.memeWikiStore.close();
    engine.tokenStore.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('OneBotClient Forward-WS connects, receives group command /status, and replies via WS action', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyqq-ob-'));
  const receivedActions = [];

  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((r) => wss.once('listening', r));
  const { port } = wss.address();

  let serverSocket = null;
  wss.on('connection', (sock) => {
    serverSocket = sock;
    sock.on('message', (raw) => {
      const msg = JSON.parse(raw.toString('utf8'));
      receivedActions.push(msg);
      if (msg.action === 'get_login_info') {
        sock.send(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: 999000, nickname: 'YoulanBot' }, echo: msg.echo }));
      } else {
        sock.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 101 }, echo: msg.echo }));
      }
    });
  });

  const store = new ConfigStore(dir);
  store.load();
  store.update({
    onebot: { enabled: true, mode: 'forward-ws', wsUrl: `ws://127.0.0.1:${port}`, accessToken: 'sec123' },
    guard: { allowGroups: ['555666'], ownerUsers: ['100001'] },
    tts: { enabled: false }
  });

  const engine = new BridgeEngine({ rootDir: dir, configStore: store });
  try {
    await engine.onebotClient.start();
    await new Promise((r) => engine.onebotClient.once('connected', r));
    await new Promise((r) => setTimeout(r, 80));

    // Simulate incoming /status command from QQ group
    serverSocket.send(
      JSON.stringify({
        post_type: 'message',
        message_type: 'group',
        self_id: 999000,
        user_id: 100001,
        group_id: 555666,
        message_id: 12,
        sender: { nickname: 'Master' },
        message: [{ type: 'text', data: { text: '/status' } }]
      })
    );

    await new Promise((r) => setTimeout(r, 150));
    const sendAct = receivedActions.find((a) => a.action === 'send_group_msg');
    assert.ok(sendAct, 'expected send_group_msg reply for /status');
    assert.equal(sendAct.params.group_id, 555666);
    assert.match(sendAct.params.message[0].data.text, /Antigravity QQ Bridge 状态/);
  } finally {
    await engine.onebotClient.stop();
    wss.close();
    engine.stickerStore.close();
    engine.lorebookStore.close();
    engine.memeWikiStore.close();
    engine.tokenStore.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
