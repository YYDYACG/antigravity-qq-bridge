import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema
} from '@modelcontextprotocol/sdk/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, '..');
const APP_HTML_PATH = process.env.AGYQQ_HUB_APP_HTML || path.join(PLUGIN_ROOT, 'dist', 'app.html');
const BRIDGE_DIR = process.env.AGYQQ_BRIDGE_DIR || path.resolve(PLUGIN_ROOT, '..', '..');
const APP_URI = 'ui://agyqq-hub/app.html';
const VERSION = '1.2.1';

let startingPromise = null;
const lastSpawnAt = {
  bridge: 0,
  napcat: 0,
  sovits: 0
};

function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another privilege context
    return err?.code === 'EPERM';
  }
}

function getLogsDir() {
  const dir = path.join(BRIDGE_DIR, 'data', 'logs');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readAlivePid(pidFileName) {
  try {
    const fp = path.join(BRIDGE_DIR, 'data', 'logs', pidFileName);
    if (!fs.existsSync(fp)) return null;
    const raw = fs.readFileSync(fp, 'utf8').trim();
    const pid = parseInt(raw, 10);
    if (isPidAlive(pid)) return pid;
    try { fs.unlinkSync(fp); } catch {}
    return null;
  } catch {
    return null;
  }
}

function writePidFile(pidFileName, pid) {
  if (!pid) return;
  try {
    const fp = path.join(getLogsDir(), pidFileName);
    fs.writeFileSync(fp, `${pid}\n`, 'utf8');
  } catch {
    // ignore
  }
}

function isTcpPortListening(port, host = '127.0.0.1', timeoutMs = 450) {
  return new Promise((resolve) => {
    const p = Number(port);
    if (!Number.isInteger(p) || p <= 0 || p > 65535) {
      resolve(false);
      return;
    }
    let settled = false;
    const done = (val) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch {}
      resolve(val);
    };
    const sock = net.createConnection({ host, port: p });
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

function detectQuickLoginQQ() {
  try {
    const cfgDir = path.join(BRIDGE_DIR, 'napcat', 'config');
    if (!fs.existsSync(cfgDir)) return '';
    const files = fs.readdirSync(cfgDir);
    for (const name of files) {
      const m = name.match(/^napcat_(\d{5,13})\.json$/);
      if (m) return m[1];
    }
    for (const name of files) {
      const m = name.match(/^onebot11_(\d{5,13})\.json$/);
      if (m) return m[1];
    }
  } catch {
    // ignore
  }
  return '';
}

function parsePortFromUrl(urlStr, fallback) {
  try {
    const u = new URL(String(urlStr || ''));
    if (u.port) return Number(u.port);
    return u.protocol === 'https:' ? 443 : 80;
  } catch {
    return fallback;
  }
}

function locateQqntExecutable() {
  const candidates = [
    'C:\\Program Files\\Tencent\\QQNT\\QQ.exe',
    'C:\\Program Files (x86)\\Tencent\\QQNT\\QQ.exe',
    'D:\\Program Files\\Tencent\\QQNT\\QQ.exe'
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  if (process.platform === 'win32') {
    try {
      const out = execFileSync(
        'reg.exe',
        ['query', 'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ', '/v', 'UninstallString'],
        { encoding: 'utf8', timeout: 3000, windowsHide: true }
      );
      const m = out.match(/REG_\w+\s+(.+)/i);
      if (m) {
        const uninst = m[1].trim().replace(/^"|"$/g, '');
        const cand = path.join(path.dirname(uninst), 'QQ.exe');
        if (fs.existsSync(cand)) return cand;
      }
    } catch {
      // ignore registry lookup failure
    }
  }
  return '';
}

function readBridgeConfig() {
  const cfgPath = path.join(BRIDGE_DIR, 'config.json');
  const tokPath = path.join(BRIDGE_DIR, 'data', 'hub-token.txt');
  let host = '127.0.0.1';
  let port = 3200;
  let token = '';
  let personaName = 'Antigravity Companion';
  let onebotEnabled = true;
  let napcatOrigin = 'http://127.0.0.1:6099';
  let onebotWsPort = 13001;
  let onebotHttpPort = 13000;
  let ttsEnabled = true;
  let ttsBaseUrl = 'http://127.0.0.1:19880';
  let ttsPort = 19880;
  let ttsAutoProbePorts = [19880, 9880, 18880, 28880, 12880];
  let sovitsRoot = process.env.GPT_SOVITS_ROOT || '';
  let sovitsConfigYaml = path.join(BRIDGE_DIR, 'tts_infer_v5dev.yaml');

  try {
    if (fs.existsSync(cfgPath)) {
      const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8').replace(/^\uFEFF/, ''));
      if (raw?.hub?.host) host = String(raw.hub.host).trim() || host;
      if (raw?.hub?.port) port = Number(raw.hub.port) || port;
      if (raw?.hub?.token) token = String(raw.hub.token).trim();
      if (raw?.acp?.persona?.name) personaName = String(raw.acp.persona.name).trim();
      if (raw?.onebot?.enabled === false) onebotEnabled = false;
      if (raw?.onebot?.wsUrl) onebotWsPort = parsePortFromUrl(raw.onebot.wsUrl, onebotWsPort);
      if (raw?.onebot?.httpUrl) onebotHttpPort = parsePortFromUrl(raw.onebot.httpUrl, onebotHttpPort);
      if (raw?.tts?.enabled === false) ttsEnabled = false;
      if (raw?.tts?.baseUrl) {
        ttsBaseUrl = String(raw.tts.baseUrl).trim();
        ttsPort = parsePortFromUrl(ttsBaseUrl, ttsPort);
      }
      if (Array.isArray(raw?.tts?.autoProbePorts) && raw.tts.autoProbePorts.length) {
        ttsAutoProbePorts = raw.tts.autoProbePorts.map((p) => Number(p)).filter((p) => p > 0);
      }
      if (raw?.tts?.sovitsRoot) sovitsRoot = String(raw.tts.sovitsRoot).trim();
      if (raw?.tts?.sovitsConfigYaml) sovitsConfigYaml = String(raw.tts.sovitsConfigYaml).trim();
    }
  } catch {
    // ignore malformed config
  }

  if (!token) {
    try {
      if (fs.existsSync(tokPath)) {
        token = fs.readFileSync(tokPath, 'utf8').trim();
      }
    } catch {
      // ignore
    }
  }

  const baseUrl = `http://${host}:${port}`;
  const hubUrl = token ? `${baseUrl}/?token=${encodeURIComponent(token)}` : `${baseUrl}/`;
  const napcatDir = path.join(BRIDGE_DIR, 'napcat');
  const napcatLauncher = path.join(napcatDir, 'NapCatWinBootMain.exe');
  const napcatInject = path.join(napcatDir, 'NapCatWinBootHook.dll');
  const napcatScript = path.join(napcatDir, 'start-napcat.ps1');
  const sovitsPython = path.join(sovitsRoot, 'runtime', 'python.exe');
  const sovitsApiScript = path.join(sovitsRoot, 'api_v2.py');
  const quickLoginQQ = detectQuickLoginQQ();

  return {
    host,
    port,
    token,
    baseUrl,
    hubUrl,
    personaName,
    onebotEnabled,
    napcatOrigin,
    onebotWsPort,
    onebotHttpPort,
    napcatDir,
    napcatLauncher,
    napcatInject,
    napcatScript,
    napcatInstalled: fs.existsSync(napcatLauncher) && fs.existsSync(napcatInject),
    quickLoginQQ,
    ttsEnabled,
    ttsBaseUrl,
    ttsPort,
    ttsProbePorts: [...new Set([ttsPort, ...ttsAutoProbePorts])],
    sovitsRoot,
    sovitsConfigYaml,
    sovitsPython,
    sovitsApiScript,
    sovitsInstalled: fs.existsSync(sovitsPython) && fs.existsSync(sovitsApiScript)
  };
}

async function probeNapcat(info) {
  const [p6099, pWs, pHttp] = await Promise.all([
    isTcpPortListening(6099),
    isTcpPortListening(info.onebotWsPort),
    isTcpPortListening(info.onebotHttpPort)
  ]);
  const online = p6099 || pWs || pHttp;
  const bootingPid = online ? null : readAlivePid('hub-plugin-napcat.pid');
  const booting = !online && (Boolean(bootingPid) || Date.now() - lastSpawnAt.napcat < 25000);
  return {
    enabled: info.onebotEnabled,
    installed: info.napcatInstalled,
    online,
    booting,
    webuiOnline: p6099,
    wsOnline: pWs,
    quickLoginQQ: info.quickLoginQQ,
    pid: bootingPid
  };
}

async function probeSovits(info) {
  let activePort = null;
  for (const p of info.ttsProbePorts) {
    if (await isTcpPortListening(p)) {
      activePort = p;
      break;
    }
  }
  const online = Boolean(activePort);
  const bootingPid = online ? null : readAlivePid('hub-plugin-sovits.pid');
  const booting = !online && (Boolean(bootingPid) || Date.now() - lastSpawnAt.sovits < 60000);
  return {
    enabled: info.ttsEnabled,
    installed: info.sovitsInstalled,
    online,
    booting,
    port: activePort || info.ttsPort,
    pid: bootingPid
  };
}

async function probeHubSession() {
  const info = readBridgeConfig();
  let online = false;
  let onebotConnected = false;
  let ttsOnline = false;
  let ttsPrewarmed = false;
  let napcatWebuiUrl = `${info.napcatOrigin}/webui`;
  let error = '';

  const [bridgeRes, napcat, sovits] = await Promise.all([
    (async () => {
      try {
        const headers = info.token ? { Authorization: `Bearer ${info.token}` } : {};
        const res = await fetch(`${info.baseUrl}/api/status`, {
          headers,
          signal: AbortSignal.timeout(2000)
        });
        if (res.ok) {
          const json = await res.json().catch(() => null);
          const data = json?.data || {};
          online = true;
          onebotConnected = Boolean(data.onebot?.connected);
          ttsOnline = Boolean(data.tts?.online);
          ttsPrewarmed = Boolean(data.tts?.prewarmed);
          if (data.napcat?.webuiUrl) napcatWebuiUrl = String(data.napcat.webuiUrl);
        } else {
          error = `HTTP ${res.status}`;
        }
      } catch (err) {
        error = err?.message || 'connection refused';
      }
    })(),
    probeNapcat(info),
    probeSovits(info)
  ]);
  void bridgeRes;

  const bridgeBootingPid = online ? null : readAlivePid('hub-plugin-bridge.pid');
  const bridge = {
    online,
    booting: !online && (Boolean(bridgeBootingPid) || Date.now() - lastSpawnAt.bridge < 12000),
    baseUrl: info.baseUrl,
    pid: bridgeBootingPid
  };

  const missingServices = [];
  if (!bridge.online && !bridge.booting) missingServices.push('bridge');
  if (napcat.enabled && napcat.installed && !napcat.online && !napcat.booting) missingServices.push('napcat');
  if (sovits.enabled && sovits.installed && !sovits.online && !sovits.booting) missingServices.push('sovits');

  return {
    online,
    baseUrl: info.baseUrl,
    hubUrl: info.hubUrl,
    napcatWebuiUrl,
    personaName: info.personaName,
    bridgeDir: BRIDGE_DIR,
    onebotConnected,
    ttsOnline: ttsOnline || sovits.online,
    ttsPrewarmed,
    services: { bridge, napcat, sovits },
    missingServices,
    needsAutoStart: missingServices.length > 0,
    autoStarting: Boolean(startingPromise),
    error
  };
}

function spawnDetachedLogged({ command, args, cwd, env, logFileName, pidFileName, banner }) {
  const logFile = path.join(getLogsDir(), logFileName);
  const outFd = fs.openSync(logFile, 'a');
  try {
    fs.writeSync(outFd, `\n[${new Date().toISOString()}] [agyqq-hub-plugin] ${banner}\n`);
    const child = spawn(command, args, {
      cwd,
      env: env || process.env,
      detached: true,
      stdio: ['ignore', outFd, outFd],
      windowsHide: true
    });
    child.unref();
    writePidFile(pidFileName, child.pid);
    return child.pid;
  } finally {
    try { fs.closeSync(outFd); } catch {}
  }
}

async function ensureStackStarted({ waitMs = 15000 } = {}) {
  const before = await probeHubSession();
  if (!before.needsAutoStart && before.online) {
    return { alreadyRunning: true, started: false, launched: [], ...before };
  }

  if (!startingPromise) {
    startingPromise = (async () => {
      const info = readBridgeConfig();
      const current = await probeHubSession();
      const launched = [];

      // 1. Launch NapCatQQ directly via NapCatWinBootMain.exe (never via powershell.exe, which silently exits under detached+windowsHide+stdin:ignore!)
      if (
        info.onebotEnabled &&
        info.napcatInstalled &&
        !current.services.napcat.online &&
        !current.services.napcat.booting &&
        Date.now() - lastSpawnAt.napcat > 25000
      ) {
        const qqPath = locateQqntExecutable();
        if (qqPath) {
          const bootArgs = [qqPath, info.napcatInject];
          if (info.quickLoginQQ) {
            bootArgs.push('-q', info.quickLoginQQ);
          }
          const ncEnv = {
            ...process.env,
            NAPCAT_PATCH_PACKAGE: path.join(info.napcatDir, 'qqnt.json'),
            NAPCAT_LOAD_PATH: path.join(info.napcatDir, 'loadNapCat.js'),
            NAPCAT_INJECT_PATH: info.napcatInject,
            NAPCAT_LAUNCHER_PATH: info.napcatLauncher,
            NAPCAT_MAIN_PATH: path.join(info.napcatDir, 'napcat.mjs')
          };
          spawnDetachedLogged({
            command: info.napcatLauncher,
            args: bootArgs,
            cwd: info.napcatDir,
            env: ncEnv,
            logFileName: 'hub-plugin-napcat.log',
            pidFileName: 'hub-plugin-napcat.pid',
            banner: `Auto-launching NapCatQQ directly (${info.napcatLauncher}${info.quickLoginQQ ? `, -q ${info.quickLoginQQ}` : ''})`
          });
          lastSpawnAt.napcat = Date.now();
          launched.push('napcat');
        }
      }

      // 2. Launch standalone GPT-SoVITS v5 in detached background if enabled, installed, and not running/booting
      if (
        info.ttsEnabled &&
        info.sovitsInstalled &&
        !current.services.sovits.online &&
        !current.services.sovits.booting &&
        Date.now() - lastSpawnAt.sovits > 60000
      ) {
        const targetPort = info.ttsPort || 19880;
        const pyArgs = ['-u', 'api_v2.py', '-a', '127.0.0.1', '-p', String(targetPort)];
        if (info.sovitsConfigYaml && fs.existsSync(info.sovitsConfigYaml)) {
          pyArgs.push('-c', info.sovitsConfigYaml);
        }
        spawnDetachedLogged({
          command: info.sovitsPython,
          args: pyArgs,
          cwd: info.sovitsRoot,
          logFileName: 'sovits.out.log',
          pidFileName: 'hub-plugin-sovits.pid',
          banner: `Auto-launching GPT-SoVITS v5 on 127.0.0.1:${targetPort}`
        });
        lastSpawnAt.sovits = Date.now();
        launched.push('sovits');
      }

      // 3. Launch Antigravity QQ Bridge if offline & not already booting
      const entryScript = path.join(BRIDGE_DIR, 'src', 'index.js');
      if (!current.online) {
        if (!fs.existsSync(entryScript)) {
          return {
            alreadyRunning: false,
            started: launched.length > 0,
            launched,
            ...(await probeHubSession()),
            error: `未找到桥接入口文件: ${entryScript}`
          };
        }

        if (!current.services.bridge.booting && Date.now() - lastSpawnAt.bridge > 10000) {
          spawnDetachedLogged({
            command: process.execPath,
            args: [entryScript],
            cwd: BRIDGE_DIR,
            logFileName: 'hub-plugin-launcher.log',
            pidFileName: 'hub-plugin-bridge.pid',
            banner: `Auto-launching Bridge (${entryScript})`
          });
          lastSpawnAt.bridge = Date.now();
          launched.push('bridge');
        }

        const deadline = Date.now() + Math.max(2000, waitMs);
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 400));
          const st = await probeHubSession();
          if (st.online) {
            return { alreadyRunning: false, started: true, launched, ...st };
          }
        }
      }

      const finalSt = await probeHubSession();
      return {
        alreadyRunning: launched.length === 0 && finalSt.online,
        started: launched.length > 0,
        launched,
        ...finalSt,
        error: finalSt.online ? '' : '正在启动 D:\\AGYQQ 守护服务，请稍候自动重连...'
      };
    })().finally(() => {
      startingPromise = null;
    });
  }

  return startingPromise;
}

function buildResourceMeta() {
  const info = readBridgeConfig();
  return {
    ui: {
      prefersBorder: false,
      csp: {
        frameDomains: [info.baseUrl, info.napcatOrigin],
        connectDomains: [info.baseUrl],
        resourceDomains: [info.baseUrl]
      }
    }
  };
}

function formatServiceNames(keys = []) {
  const map = {
    bridge: 'Antigravity Bridge',
    napcat: 'NapCatQQ',
    sovits: 'GPT-SoVITS v5'
  };
  return keys.map((k) => map[k] || k).join('、');
}

const server = new Server(
  {
    name: 'agyqq-hub',
    version: VERSION
  },
  {
    capabilities: {
      tools: {},
      resources: {}
    }
  }
);

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return {
    resources: [
      {
        uri: APP_URI,
        name: 'Antigravity Hub',
        description: 'Antigravity QQ Bridge (星喵) 一键检测与全套守护启动控制台',
        mimeType: 'text/html;profile=mcp-app',
        _meta: buildResourceMeta()
      }
    ]
  };
});

server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  if (req.params.uri !== APP_URI) {
    throw new Error(`Unknown resource URI: ${req.params.uri}`);
  }
  const html = fs.readFileSync(APP_HTML_PATH, 'utf8');
  return {
    contents: [
      {
        uri: APP_URI,
        mimeType: 'text/html;profile=mcp-app',
        text: html,
        _meta: buildResourceMeta()
      }
    ]
  };
});

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'open_antigravity_hub',
        title: 'Antigravity Hub',
        description:
          '打开本地 Antigravity QQ Bridge (星喵) 管控台；点击时自动检测 NapCatQQ、GPT-SoVITS v5 与 Bridge 三大守护服务，未运行的将自动后台拉起。',
        inputSchema: {
          type: 'object',
          properties: {},
          additionalProperties: false
        },
        _meta: {
          ui: {
            resourceUri: APP_URI
          },
          'com.google.antigravity/ui': {
            entrypoints: [
              { type: 'global', title: 'Antigravity Hub' },
              { type: 'aux_pane', title: 'Antigravity Hub' }
            ]
          }
        }
      },
      {
        name: 'app_get_hub_session',
        title: 'Get Hub Session (App Only)',
        description: 'Internal app-only tool returning local Antigravity Hub & companion services status.',
        inputSchema: {
          type: 'object',
          properties: {},
          additionalProperties: false
        },
        _meta: {
          ui: {
            visibility: ['app']
          }
        }
      },
      {
        name: 'app_start_hub',
        title: 'Start Antigravity Hub Stack (App Only)',
        description: 'Internal app-only tool to auto-detect and launch any offline services (Bridge, NapCatQQ, GPT-SoVITS v5).',
        inputSchema: {
          type: 'object',
          properties: {},
          additionalProperties: false
        },
        _meta: {
          ui: {
            visibility: ['app']
          }
        }
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name } = req.params;

  if (name === 'open_antigravity_hub') {
    let st = await probeHubSession();
    let launched = [];
    if (st.needsAutoStart || !st.online) {
      st = await ensureStackStarted({ waitMs: 10000 });
      launched = Array.isArray(st.launched) ? st.launched : [];
    }

    // Never expose hub token in model-visible output; UI reads it via app_get_hub_session
    const safeSummary = {
      online: st.online,
      launched,
      baseUrl: st.baseUrl,
      personaName: st.personaName,
      onebotConnected: st.onebotConnected,
      ttsOnline: st.ttsOnline,
      ttsPrewarmed: st.ttsPrewarmed,
      services: st.services
    };
    const launchNote = launched.length ? `（已自动后台拉起：${formatServiceNames(launched)}）` : '';
    return {
      content: [
        {
          type: 'text',
          text: st.online
            ? `Antigravity Hub 已在线 (${st.baseUrl})${launchNote}，伴侣「${st.personaName}」，NapCat=${st.services.napcat.online ? '在线' : st.services.napcat.booting ? '启动中' : '离线'}，SoVITS=${st.services.sovits.online ? '在线' : st.services.sovits.booting ? '加载中' : '离线'}。`
            : `已触发自动启动全套服务${launchNote}，正在等待 ${st.baseUrl} 就绪...`
        }
      ],
      structuredContent: safeSummary
    };
  }

  if (name === 'app_get_hub_session') {
    const st = await probeHubSession();
    return {
      content: [{ type: 'text', text: st.online ? 'online' : 'offline' }],
      structuredContent: st
    };
  }

  if (name === 'app_start_hub') {
    const st = await ensureStackStarted({ waitMs: 15000 });
    return {
      content: [{ type: 'text', text: st.online ? 'started' : st.error || 'failed' }],
      structuredContent: st
    };
  }

  throw new Error(`Unknown tool: ${name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
