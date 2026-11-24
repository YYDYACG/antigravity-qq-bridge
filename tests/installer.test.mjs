import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseCliArgs, isNodeVersionSupported, runInstaller } from '../scripts/install.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

function createTempProjectCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyqq-install-test-'));
  fs.copyFileSync(path.join(REPO_ROOT, 'config.example.json'), path.join(dir, 'config.example.json'));
  fs.copyFileSync(path.join(REPO_ROOT, 'tts_infer_v5dev.example.yaml'), path.join(dir, 'tts_infer_v5dev.example.yaml'));

  const pluginSrc = path.join(dir, 'plugins', 'agyqq-hub');
  fs.mkdirSync(path.join(pluginSrc, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(pluginSrc, 'node_modules', 'fake'), { recursive: true });
  fs.writeFileSync(path.join(pluginSrc, 'plugin.json'), JSON.stringify({ name: 'agyqq-hub', version: '1.2.2' }));
  fs.writeFileSync(
    path.join(pluginSrc, 'mcp_config.json'),
    JSON.stringify({ mcpServers: { hub: { command: 'node', args: ['${PLUGIN_ROOT}/bin/server.mjs'] } } })
  );
  fs.writeFileSync(path.join(pluginSrc, 'bin', 'server.mjs'), '// stub');
  fs.writeFileSync(path.join(pluginSrc, 'node_modules', 'fake', 'skip.txt'), 'should not be copied');
  return dir;
}

test('parseCliArgs and isNodeVersionSupported validate options and clamp contextBudget cleanly', () => {
  assert.equal(isNodeVersionSupported('22.13.0'), true);
  assert.equal(isNodeVersionSupported('24.16.0'), true);
  assert.equal(isNodeVersionSupported('22.12.9'), false);
  assert.equal(isNodeVersionSupported('20.18.0'), false);

  const opts = parseCliArgs([
    '--yes',
    '--with-ffmpeg',
    '--owner-qq',
    '10001,10002',
    '--group-id',
    '90001',
    '--context-budget',
    '8000',
    '--sovits-root',
    '/opt/sovits'
  ]);
  assert.equal(opts.yes, true);
  assert.equal(opts.withFfmpeg, true);
  assert.deepEqual(opts.ownerQq, ['10001', '10002']);
  assert.deepEqual(opts.groupIds, ['90001']);
  assert.equal(opts.contextBudget, 16000);
  assert.equal(opts.withSovits, true);

  const skipFf = parseCliArgs(['--skip-ffmpeg']);
  assert.equal(skipFf.withFfmpeg, false);

  const unlimited = parseCliArgs(['--context-budget', '0']);
  assert.equal(unlimited.contextBudget, 0);

  assert.throws(() => parseCliArgs(['--unknown-flag']), /未知参数/);
});

test('runInstaller creates config, token, SoVITS template, and AGY 2 plugin with AGYQQ_BRIDGE_DIR without overwriting existing config', async () => {
  const dir = createTempProjectCopy();
  const pluginDst = path.join(dir, 'installed-plugin', 'agyqq-hub');
  const logs = [];
  const io = {
    log: (m) => logs.push(m),
    nonInteractive: true,
    probeCommand: () => ({ ok: true, version: 'stub 1.0' })
  };

  try {
    // 1. Dry-run makes zero mutations
    const dry = await runInstaller(
      {
        rootDir: dir,
        pluginDir: pluginDst,
        yes: true,
        dryRun: true,
        skipNpm: true,
        withPlugin: true,
        withSovits: true
      },
      io
    );
    assert.equal(dry.dryRun, true);
    assert.equal(fs.existsSync(path.join(dir, 'config.json')), false);
    assert.equal(fs.existsSync(pluginDst), false);

    // 2. Real install on fresh temp project
    const res = await runInstaller(
      {
        rootDir: dir,
        pluginDir: pluginDst,
        yes: true,
        skipNpm: true,
        withPlugin: true,
        withSovits: true,
        ownerQq: ['100001'],
        groupIds: ['200001'],
        personaName: '测试小猫',
        contextBudget: 512000
      },
      io
    );
    assert.equal(res.configCreated, true);
    assert.equal(res.pluginInstalled, true);
    assert.equal(res.sovitsInitialized, true);
    assert.match(res.hubToken, /^[0-9a-f]{32}$/);

    const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    assert.equal(cfg.hub.token, res.hubToken);
    assert.deepEqual(cfg.guard.ownerUsers, ['100001']);
    assert.deepEqual(cfg.guard.allowGroups, ['200001']);
    assert.equal(cfg.acp.persona.name, '测试小猫');
    assert.equal(cfg.acp.contextBudgetTokens, 512000);
    assert.equal(fs.readFileSync(path.join(dir, 'data', 'hub-token.txt'), 'utf8').trim(), res.hubToken);
    assert.equal(fs.existsSync(path.join(dir, 'tts_infer_v5dev.yaml')), true);
    assert.equal(fs.existsSync(path.join(dir, 'audio_clip')), true);

    const mcpCfg = JSON.parse(fs.readFileSync(path.join(pluginDst, 'mcp_config.json'), 'utf8'));
    assert.equal(mcpCfg.mcpServers.hub.env.AGYQQ_BRIDGE_DIR, path.resolve(dir));
    assert.equal(fs.existsSync(path.join(pluginDst, 'node_modules')), false);

    // 3. Re-run preserves existing config & token and merges additional group cleanly
    const res2 = await runInstaller(
      {
        rootDir: dir,
        pluginDir: pluginDst,
        yes: true,
        skipNpm: true,
        withPlugin: false,
        groupIds: ['200002']
      },
      io
    );
    assert.equal(res2.configCreated, false);
    assert.equal(res2.hubToken, res.hubToken);
    const cfg2 = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    assert.equal(cfg2.hub.token, res.hubToken);
    assert.equal(cfg2.acp.persona.name, '测试小猫');
    assert.deepEqual(cfg2.guard.allowGroups, ['200001', '200002']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runInstaller installs missing FFmpeg when --with-ffmpeg is passed and binds vision.ffmpegPath into config.json', async () => {
  const dir = createTempProjectCopy();
  const logs = [];
  let installCalls = 0;

  try {
    const res = await runInstaller(
      {
        rootDir: dir,
        yes: true,
        skipNpm: true,
        withPlugin: false,
        withFfmpeg: true
      },
      {
        log: (m) => logs.push(m),
        nonInteractive: true,
        probeCommand: (cmd) => (cmd === 'agy' ? { ok: true, version: '1.5.13' } : { ok: false, version: '' }),
        installFfmpeg: async () => {
          installCalls += 1;
          return { installed: true, manager: 'winget', ffmpegPath: 'C:\\Tools\\ffmpeg\\bin\\ffmpeg.exe' };
        }
      }
    );
    assert.equal(installCalls, 1);
    assert.equal(res.ffmpegInstalled, true);
    assert.equal(res.ffmpegPath, 'C:\\Tools\\ffmpeg\\bin\\ffmpeg.exe');
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    assert.equal(cfg.vision.ffmpegPath, 'C:\\Tools\\ffmpeg\\bin\\ffmpeg.exe');

    // Re-run when FFmpeg already exists -> must NOT reinstall
    await runInstaller(
      {
        rootDir: dir,
        yes: true,
        skipNpm: true,
        withPlugin: false,
        withFfmpeg: true
      },
      {
        log: (m) => logs.push(m),
        nonInteractive: true,
        probeCommand: () => ({ ok: true, version: 'ok' }),
        installFfmpeg: async () => {
          installCalls += 1;
          return { installed: true, manager: 'winget', ffmpegPath: 'should-not-run' };
        }
      }
    );
    assert.equal(installCalls, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('install.mjs CLI prints help and exits 0 cleanly', () => {
  const r = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'install.mjs'), '--help'], {
    encoding: 'utf8'
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Antigravity QQ Bridge 一键安装/);
  assert.match(r.stdout, /--with-plugin/);
  assert.match(r.stdout, /--with-ffmpeg/);
});
