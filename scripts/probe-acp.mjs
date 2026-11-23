import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveProxyUrl } from '../src/config/proxy-detect.js';
import { AcpWorker } from '../src/acp/acp-worker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

async function main() {
  const proxy = await resolveProxyUrl('auto');
  console.log('[Probe] 代理探测结果:', proxy);

  const worker = new AcpWorker({
    name: 'probe-acp',
    cwd: rootDir,
    sandbox: true,
    blockAllTools: true,
    proxyUrl: proxy.proxyUrl
  });

  try {
    await worker.ensureStarted();
    const st = worker.getStatus();
    console.log('[Probe] ACP 就绪:', {
      pid: st.pid,
      agentInfo: st.agentInfo,
      handshakeMs: st.lastLatencyMs
    });

    const sess = await worker.createSession({
      cwd: rootDir,
      systemPromptAppend: '简短回复，一句即可。'
    });
    console.log('[Probe] 可用模型数:', sess.models?.availableModels?.length || 0);
    console.log('[Probe] 账号档位:', sess._meta?.antigravity?.tier?.name || 'unknown');

    await worker.setConfigOption(sess.sessionId, 'model', 'gemini-3.8-flash');
    await worker.setConfigOption(sess.sessionId, 'thought_level', 'low');

    const redPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const res = await worker.prompt(sess.sessionId, [
      { type: 'text', text: '这张测试图是什么颜色？请用一句话回复。' },
      { type: 'image', data: redPng, mimeType: 'image/png' }
    ]);
    console.log('[Probe] 多模态测试回复:', res.text);
    console.log('[Probe] 延迟与 Token:', { latencyMs: res.latencyMs, usage: res.usage });
    await worker.closeSession(sess.sessionId);
    console.log('[Probe] 全部通过！');
  } finally {
    await worker.stop();
  }
}

main().catch((err) => {
  console.error('[Probe] 失败:', err);
  process.exit(1);
});
