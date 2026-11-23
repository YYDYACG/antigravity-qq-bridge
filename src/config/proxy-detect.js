import net from 'node:net';
import { execFileSync } from 'node:child_process';

function probeTcp(host, port, timeoutMs = 400) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

function readWindowsSystemProxy() {
  if (process.platform !== 'win32') return null;
  try {
    const out = execFileSync(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
      { encoding: 'utf8', timeout: 1500, windowsHide: true }
    );
    const enabled = /ProxyEnable\s+REG_DWORD\s+0x1/i.test(out);
    if (!enabled) return null;
    const match = out.match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/i);
    if (!match) return null;
    const raw = match[1].trim();
    if (!raw) return null;
    if (/^https?:\/\//i.test(raw)) return raw;
    // Handle format like "http=127.0.0.1:7897;https=127.0.0.1:7897" or "127.0.0.1:7897"
    const httpsPart = raw.split(';').find((s) => s.toLowerCase().startsWith('https='));
    if (httpsPart) return `http://${httpsPart.slice(6).trim()}`;
    const first = raw.split(';')[0].replace(/^http=/i, '').trim();
    return first ? `http://${first}` : null;
  } catch {
    return null;
  }
}

export async function resolveProxyUrl(configured = 'auto') {
  const val = String(configured ?? '').trim();
  if (!val || val.toLowerCase() === 'none' || val.toLowerCase() === 'direct') {
    return { proxyUrl: '', source: 'direct' };
  }
  if (val.toLowerCase() !== 'auto') {
    return { proxyUrl: val, source: 'manual' };
  }

  // 1. Respect explicit process environment variables first
  const envProxy =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    '';
  if (envProxy.trim()) {
    return { proxyUrl: envProxy.trim(), source: 'env' };
  }

  // 2. Check Windows system proxy settings
  const winProxy = readWindowsSystemProxy();
  if (winProxy) {
    return { proxyUrl: winProxy, source: 'windows-registry' };
  }

  // 3. Probe common local proxy ports (Clash Verge 7897, Clash 7890, v2rayN 10809)
  for (const port of [7897, 7890, 10809, 10808, 7891]) {
    if (await probeTcp('127.0.0.1', port)) {
      return { proxyUrl: `http://127.0.0.1:${port}`, source: `local-port-${port}` };
    }
  }

  return { proxyUrl: '', source: 'none-detected' };
}

export function buildChildEnvWithProxy(proxyUrl) {
  const env = { ...process.env };
  if (proxyUrl) {
    env.HTTP_PROXY = proxyUrl;
    env.HTTPS_PROXY = proxyUrl;
    env.http_proxy = proxyUrl;
    env.https_proxy = proxyUrl;
    const noProxy = new Set(
      String(env.NO_PROXY || env.no_proxy || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    );
    noProxy.add('127.0.0.1');
    noProxy.add('localhost');
    noProxy.add('::1');
    env.NO_PROXY = [...noProxy].join(',');
    env.no_proxy = env.NO_PROXY;
  }
  return env;
}
