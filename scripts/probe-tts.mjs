import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigStore } from '../src/config/schema.js';
import { SoVitsClient } from '../src/tts/sovits-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

async function main() {
  const store = new ConfigStore(rootDir);
  store.load();
  const tts = new SoVitsClient(store, rootDir);

  const health = await tts.probeHealth();
  console.log('[TTS Probe] 健康检查:', health);
  const assets = tts.discoverLocalAssets();
  console.log('[TTS Probe] 本机发现模型:', {
    gptWeights: assets.gptWeights.length,
    sovitsWeights: assets.sovitsWeights.length,
    sampleAudios: assets.sampleAudios.length
  });

  if (!health.online) {
    console.log('[TTS Probe] 当前 GPT-SoVITS v5 未在运行，跳过实时合成测试。可在 Antigravity Hub 或运行 start-agyqq.ps1 -WithSovits 一键启动。');
    return;
  }

  const r1 = await tts.synthesize({ text: '测试语音合成，主人你好呀', emotion: '温柔' });
  console.log('[TTS Probe] 首次合成:', { cached: r1.cached, latencyMs: r1.latencyMs, bytes: r1.buffer.length, sha256: r1.sha256.slice(0, 12) });

  const r2 = await tts.synthesize({ text: '测试语音合成，主人你好呀', emotion: '温柔' });
  console.log('[TTS Probe] 二次秒回缓存:', { cached: r2.cached, latencyMs: r2.latencyMs, bytes: r2.buffer.length });
}

main().catch((err) => {
  console.error('[TTS Probe] 失败:', err);
  process.exit(1);
});
