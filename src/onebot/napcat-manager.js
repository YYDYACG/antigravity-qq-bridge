import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { execFileSync, spawn } from 'node:child_process';

function probeTcp(host, port, timeoutMs = 600) {
  return new Promise((resolve) => {
    const s = net.createConnection({ host, port });
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(timeoutMs, () => finish(false));
    s.once('connect', () => finish(true));
    s.once('error', () => finish(false));
  });
}

export function locateQqntExecutable() {
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

export function detectQuickLoginQQ(napcatDir) {
  try {
    const cfgDir = path.join(napcatDir, 'config');
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

export function findListeningPidsOnPorts(ports = []) {
  const wanted = new Set(ports.map((p) => Number(p)).filter((p) => Number.isInteger(p) && p > 0));
  if (!wanted.size || process.platform !== 'win32') return [];
  const pids = new Set();
  try {
    const out = execFileSync('netstat.exe', ['-ano', '-p', 'tcp'], {
      encoding: 'utf8',
      timeout: 4000,
      windowsHide: true
    });
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
      if (!m) continue;
      const port = Number(m[1]);
      const pid = Number(m[2]);
      if (wanted.has(port) && Number.isInteger(pid) && pid > 0) {
        pids.add(pid);
      }
    }
  } catch {
    // ignore netstat lookup failure
  }
  return [...pids];
}

export class NapCatManager {
  constructor(rootDir) {
    this.rootDir = rootDir;
    this.napcatDir = path.join(rootDir, 'napcat');
    this.webuiCfgPath = path.join(this.napcatDir, 'config', 'webui.json');
    this.startScriptPath = path.join(this.napcatDir, 'start-napcat.ps1');
    this.launcherPath = path.join(this.napcatDir, 'NapCatWinBootMain.exe');
    this.qrPath = path.join(this.napcatDir, 'cache', 'qrcode.png');
    this.webuiOnline = false;
    this.wsPortOnline = false;
    this.lastCheckAt = null;
    this.lastLauncherPid = null;
  }

  isInstalled() {
    return (
      fs.existsSync(path.join(this.napcatDir, 'napcat.mjs')) &&
      fs.existsSync(this.launcherPath)
    );
  }

  readWebuiConfig() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.webuiCfgPath, 'utf8'));
      const host = raw.host && raw.host !== '::' && raw.host !== '0.0.0.0' ? raw.host : '127.0.0.1';
      const port = Number(raw.port || 6099);
      const token = String(raw.token || '');
      return {
        host,
        port,
        token,
        url: token ? `http://${host}:${port}/webui?token=${encodeURIComponent(token)}` : `http://${host}:${port}/webui`
      };
    } catch {
      return {
        host: '127.0.0.1',
        port: 6099,
        token: '',
        url: 'http://127.0.0.1:6099/webui'
      };
    }
  }

  async probeStatus() {
    const webui = this.readWebuiConfig();
    const [uiOk, wsOk] = await Promise.all([
      probeTcp(webui.host, webui.port),
      probeTcp('127.0.0.1', 13001)
    ]);
    this.webuiOnline = uiOk;
    this.wsPortOnline = wsOk;
    this.lastCheckAt = Date.now();
    return this.getStatus();
  }

  async stopLocalNapCat() {
    const webui = this.readWebuiConfig();
    const pids = new Set(findListeningPidsOnPorts([webui.port, 13001, 13000]));
    if (this.lastLauncherPid) pids.add(this.lastLauncherPid);

    const killed = [];
    for (const pid of pids) {
      try {
        if (process.platform === 'win32') {
          execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
            timeout: 4000,
            windowsHide: true,
            stdio: 'ignore'
          });
        } else {
          process.kill(pid, 'SIGTERM');
        }
        killed.push(pid);
      } catch {
        // process may already have exited
      }
    }
    this.lastLauncherPid = null;

    // Wait up to 3.5s for WebUI port to close cleanly
    const deadline = Date.now() + 3500;
    while (Date.now() < deadline) {
      const up = await probeTcp(webui.host, webui.port, 300);
      if (!up) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    await this.probeStatus();
    return { stopped: !this.webuiOnline, killed };
  }

  async startLocalNapCat(quickLoginQQ = '', { skipQuickLogin = false } = {}) {
    if (!this.isInstalled()) {
      throw new Error(`项目目录内未找到 NapCatQQ: ${this.napcatDir}`);
    }
    const st = await this.probeStatus();
    if (st.webuiOnline) {
      return { alreadyRunning: true, webuiUrl: st.webuiUrl };
    }

    const qqPath = locateQqntExecutable();
    if (!qqPath) {
      throw new Error('未在本机找到官方 QQNT (QQ.exe)，请先确认 QQNT 安装路径');
    }

    const effectiveQQ = skipQuickLogin
      ? ''
      : String(quickLoginQQ || detectQuickLoginQQ(this.napcatDir) || '').trim();
    const injectPath = path.join(this.napcatDir, 'NapCatWinBootHook.dll');
    const bootArgs = [qqPath, injectPath];
    if (effectiveQQ) {
      bootArgs.push('-q', effectiveQQ);
    }

    const env = {
      ...process.env,
      NAPCAT_PATCH_PACKAGE: path.join(this.napcatDir, 'qqnt.json'),
      NAPCAT_LOAD_PATH: path.join(this.napcatDir, 'loadNapCat.js'),
      NAPCAT_INJECT_PATH: injectPath,
      NAPCAT_LAUNCHER_PATH: this.launcherPath,
      NAPCAT_MAIN_PATH: path.join(this.napcatDir, 'napcat.mjs')
    };

    const logsDir = path.join(this.rootDir, 'data', 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    const outFd = fs.openSync(path.join(logsDir, 'napcat.out.log'), 'a');
    const errFd = fs.openSync(path.join(logsDir, 'napcat.err.log'), 'a');

    // Launch NapCatWinBootMain.exe directly instead of powershell.exe:
    // Windows PowerShell 5.1 exits silently with 0 output under detached + windowsHide + stdin:'ignore'.
    const child = spawn(this.launcherPath, bootArgs, {
      cwd: this.napcatDir,
      env,
      detached: true,
      stdio: ['ignore', outFd, errFd],
      windowsHide: true
    });
    child.unref();
    fs.closeSync(outFd);
    fs.closeSync(errFd);
    this.lastLauncherPid = child.pid || null;

    return {
      alreadyRunning: false,
      pid: child.pid,
      quickLoginQQ: effectiveQQ,
      webuiUrl: st.webuiUrl
    };
  }

  async restartLocalNapCat({ skipQuickLogin = true, quickLoginQQ = '' } = {}) {
    await this.stopLocalNapCat();
    const started = await this.startLocalNapCat(quickLoginQQ, { skipQuickLogin });
    const webui = this.readWebuiConfig();
    const deadline = Date.now() + 7000;
    let ready = false;
    while (Date.now() < deadline) {
      if (await probeTcp(webui.host, webui.port, 400)) {
        ready = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 350));
    }
    const status = await this.probeStatus();
    return {
      restarted: true,
      skipQuickLogin,
      pid: started.pid || null,
      webuiOnline: ready || status.webuiOnline,
      webuiUrl: status.webuiUrl
    };
  }

  getStatus() {
    const webui = this.readWebuiConfig();
    return {
      installed: this.isInstalled(),
      dir: this.napcatDir,
      webuiOnline: this.webuiOnline,
      wsPortOnline: this.wsPortOnline,
      webuiUrl: webui.url,
      webuiPort: webui.port,
      hasQrImage: fs.existsSync(this.qrPath),
      lastCheckAt: this.lastCheckAt
    };
  }
}
