import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigStore } from './config/schema.js';
import { BridgeEngine } from './engine/bridge-engine.js';
import { HubServer } from './web/hub-server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');

async function main() {
  const configStore = new ConfigStore(ROOT_DIR);
  const cfg = configStore.load();

  const engine = new BridgeEngine({ rootDir: ROOT_DIR, configStore });
  const hub = new HubServer({ configStore, engine });

  const hubInfo = await hub.start();
  console.log('============================================================');
  console.log('  Antigravity QQ Bridge · 跨端智能伴侣引擎');
  console.log(`  Antigravity Hub 控制台: ${hubInfo.url}`);
  console.log(`  Hub 令牌文件:           ${configStore.tokenFile}`);
  console.log(`  OneBot v11 模式:        ${cfg.onebot.mode} (${cfg.onebot.mode === 'reverse-ws' ? `ws://${cfg.onebot.reverseWsHost}:${cfg.onebot.reverseWsPort}${cfg.onebot.reverseWsPath}` : cfg.onebot.wsUrl})`);
  console.log(`  GPT-SoVITS v5 端点:     ${cfg.tts.baseUrl}`);
  console.log('============================================================');

  await engine.start();

  let shuttingDown = false;
  const shutdown = async (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n收到退出信号 ${sig}，正在优雅关闭...`);
    await engine.stop().catch(() => {});
    await hub.stop().catch(() => {});
    engine.stickerStore.close();
    engine.lorebookStore.close();
    engine.tokenStore.close();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[FATAL] 启动失败:', err);
  process.exit(1);
});
