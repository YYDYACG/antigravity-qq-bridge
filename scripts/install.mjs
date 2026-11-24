#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(__dirname, '..');
const MIN_NODE = [22, 13, 0];

function parseVersionTuple(verStr) {
  const m = String(verStr || '').replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return [0, 0, 0];
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function isNodeVersionSupported(verStr = process.versions.node) {
  const cur = parseVersionTuple(verStr);
  for (let i = 0; i < 3; i++) {
    if (cur[i] > MIN_NODE[i]) return true;
    if (cur[i] < MIN_NODE[i]) return false;
  }
  return true;
}

function splitCsv(val) {
  return String(val || '')
    .split(/[\s,，;；]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function uniqueMerge(baseArr, addArr) {
  return [...new Set([...(Array.isArray(baseArr) ? baseArr : []).map(String), ...addArr.map(String)].filter(Boolean))];
}

export function parseCliArgs(argv = []) {
  const opts = {
    yes: false,
    dryRun: false,
    help: false,
    skipNpm: false,
    forceConfig: false,
    rootDir: DEFAULT_ROOT,
    pluginDir: '',
    withPlugin: null, // null = auto/prompt, true = force on, false = skip
    withFfmpeg: null, // null = auto/prompt, true = install if missing, false = skip
    withSovits: null, // null = auto/prompt, true = force on, false = skip
    withMemewiki: null, // null = prompt/default false, true = sync
    ownerQq: [],
    groupIds: [],
    personaName: '',
    hubToken: '',
    wsUrl: '',
    httpUrl: '',
    ffmpegPath: '',
    sovitsRoot: '',
    contextBudget: null
  };

  const nextVal = (i, flag) => {
    if (i + 1 >= argv.length) throw new Error(`参数 ${flag} 缺少取值`);
    return argv[i + 1];
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      opts.help = true;
    } else if (arg === '-y' || arg === '--yes') {
      opts.yes = true;
    } else if (arg === '--dry-run') {
      opts.dryRun = true;
    } else if (arg === '--skip-npm') {
      opts.skipNpm = true;
    } else if (arg === '--force-config') {
      opts.forceConfig = true;
    } else if (arg === '--with-plugin') {
      opts.withPlugin = true;
    } else if (arg === '--skip-plugin' || arg === '--no-plugin') {
      opts.withPlugin = false;
    } else if (arg === '--with-ffmpeg') {
      opts.withFfmpeg = true;
    } else if (arg === '--skip-ffmpeg' || arg === '--no-ffmpeg') {
      opts.withFfmpeg = false;
    } else if (arg === '--with-sovits') {
      opts.withSovits = true;
    } else if (arg === '--skip-sovits' || arg === '--no-sovits') {
      opts.withSovits = false;
    } else if (arg === '--with-memewiki') {
      opts.withMemewiki = true;
    } else if (arg === '--skip-memewiki' || arg === '--no-memewiki') {
      opts.withMemewiki = false;
    } else if (arg === '--root') {
      opts.rootDir = path.resolve(nextVal(i++, arg));
    } else if (arg === '--plugin-dir') {
      opts.pluginDir = path.resolve(nextVal(i++, arg));
    } else if (arg === '--owner-qq') {
      opts.ownerQq.push(...splitCsv(nextVal(i++, arg)));
    } else if (arg === '--group-id') {
      opts.groupIds.push(...splitCsv(nextVal(i++, arg)));
    } else if (arg === '--persona-name') {
      opts.personaName = nextVal(i++, arg).trim();
    } else if (arg === '--hub-token') {
      opts.hubToken = nextVal(i++, arg).trim();
    } else if (arg === '--ws-url') {
      opts.wsUrl = nextVal(i++, arg).trim();
    } else if (arg === '--http-url') {
      opts.httpUrl = nextVal(i++, arg).trim();
    } else if (arg === '--ffmpeg') {
      opts.ffmpegPath = nextVal(i++, arg).trim();
    } else if (arg === '--sovits-root') {
      opts.sovitsRoot = nextVal(i++, arg).trim();
      opts.withSovits = true;
    } else if (arg === '--context-budget') {
      const raw = Number(nextVal(i++, arg));
      if (!Number.isFinite(raw) || raw < 0) throw new Error('--context-budget 必须为非负整数（0 表示不限）');
      opts.contextBudget = raw === 0 ? 0 : Math.min(2097152, Math.max(16000, Math.round(raw)));
    } else {
      throw new Error(`未知参数: ${arg}（运行 --help 查看所有可用选项）`);
    }
  }
  return opts;
}

export function getHelpText() {
  return `Antigravity QQ Bridge 一键安装与初始化程序

用法:
  node scripts/install.mjs [选项]
  npm run setup -- [选项]

常用选项:
  -y, --yes                   非交互模式（使用默认值与传入参数直接完成安装）
  --dry-run                   演练模式：仅打印将执行的操作，不修改任何文件
  --owner-qq <QQ号[,QQ号]>     设置主人 QQ 白名单（guard.ownerUsers）
  --group-id <群号[,群号]>     设置允许响应的群号白名单（guard.allowGroups）
  --persona-name <名称>       设置 AI 伴侣名称（acp.persona.name）
  --hub-token <令牌>          自定义 Antigravity Hub 本地访问令牌（默认随机生成）
  --context-budget <Tokens>   单会话上下文预算（16000~2097152，0 表示不限，默认 256000）
  --ws-url <URL>              OneBot Forward WS 地址（默认 ws://127.0.0.1:13001）
  --http-url <URL>            OneBot HTTP 地址（默认 http://127.0.0.1:13000）
  --ffmpeg <路径>             指定 FFmpeg 可执行文件路径（用于 GIF 分镜）
  --with-ffmpeg               若未检测到 FFmpeg，自动调用系统包管理器安装并绑定路径
  --skip-ffmpeg               跳过 FFmpeg 自动安装
  --with-plugin               安装并打包 Antigravity 2.0 (AGY 2) 侧边栏插件
  --skip-plugin               跳过侧边栏插件安装
  --plugin-dir <目录>         自定义插件安装目录（默认 ~/.gemini/config/plugins/agyqq-hub）
  --with-sovits               初始化 GPT-SoVITS v5 配置模板与 audio_clip/ 目录
  --sovits-root <目录>        指定本机 GPT-SoVITS v5 目录（自动启用 --with-sovits）
  --skip-sovits               跳过 GPT-SoVITS v5 初始化
  --with-memewiki             同步 L2 离线公共梗百科（cnmeme.wiki -> data/memes.db）
  --skip-npm                  跳过 npm install / 插件 build
  --force-config              覆盖已有 config.json（默认保留已有配置不覆盖）
  --root <目录>               指定项目根目录（测试或自定义路径用）
  -h, --help                  显示帮助信息
`;
}

function probeCommand(cmd, args = ['--version']) {
  const opts = {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
    shell: false
  };
  let res = spawnSync(cmd, args, opts);
  // Windows .cmd/.bat shims (e.g. agy.cmd) cannot be spawned directly with shell:false
  if (process.platform === 'win32' && res.error?.code === 'ENOENT' && !/[\\/]/.test(cmd)) {
    res = spawnSync('cmd.exe', ['/d', '/s', '/c', cmd, ...args], opts);
  }
  if (res.error || res.status !== 0) {
    return { ok: false, version: '' };
  }
  const firstLine = `${res.stdout || ''}\n${res.stderr || ''}`
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean);
  return { ok: true, version: firstLine || 'ok' };
}

function runNpmCommand(args, cwd, { dryRun = false, log = console.log } = {}) {
  const label = `npm ${args.join(' ')}`;
  if (dryRun) {
    log(`  [演练] 将在 ${cwd} 执行: ${label}`);
    return { ok: true, dryRun: true };
  }
  log(`  执行: ${label} (${cwd})`);
  const res =
    process.platform === 'win32'
      ? spawnSync('cmd.exe', ['/d', '/s', '/c', 'npm', ...args], { cwd, stdio: 'inherit', shell: false })
      : spawnSync('npm', args, { cwd, stdio: 'inherit', shell: false });
  if (res.error || res.status !== 0) {
    throw new Error(`命令执行失败 (${label}): ${res.error?.message || `exit ${res.status}`}`);
  }
  return { ok: true };
}

function runPackageCommand(cmd, args, { dryRun = false, log = console.log } = {}) {
  const display = `${cmd} ${args.join(' ')}`;
  if (dryRun) {
    log(`  [演练] 将执行: ${display}`);
    return { ok: true, dryRun: true };
  }
  log(`  执行: ${display}`);
  const opts = { stdio: 'inherit', shell: false };
  let res = spawnSync(cmd, args, opts);
  if (process.platform === 'win32' && res.error?.code === 'ENOENT' && !/[\\/]/.test(cmd)) {
    res = spawnSync('cmd.exe', ['/d', '/s', '/c', cmd, ...args], opts);
  }
  if (res.error || res.status !== 0) {
    return { ok: false, error: res.error?.message || `exit ${res.status}` };
  }
  return { ok: true };
}

function findFfmpegInDir(baseDir, maxDepth = 3) {
  if (!baseDir || !fs.existsSync(baseDir)) return '';
  const queue = [{ dir: baseDir, depth: 0 }];
  while (queue.length) {
    const { dir, depth } = queue.shift();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isFile() && ent.name.toLowerCase() === 'ffmpeg.exe') {
        return full;
      }
      if (ent.isDirectory() && depth < maxDepth) {
        queue.push({ dir: full, depth: depth + 1 });
      }
    }
  }
  return '';
}

export function discoverWindowsFfmpegPath(env = process.env) {
  if (process.platform !== 'win32') return '';
  const localAppData = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const directCandidates = [
    path.join(localAppData, 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'),
    path.join(os.homedir(), 'scoop', 'shims', 'ffmpeg.exe'),
    'C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe'
  ];
  for (const cand of directCandidates) {
    if (fs.existsSync(cand)) return cand;
  }
  const wingetPkgs = path.join(localAppData, 'Microsoft', 'WinGet', 'Packages');
  if (fs.existsSync(wingetPkgs)) {
    try {
      for (const ent of fs.readdirSync(wingetPkgs, { withFileTypes: true })) {
        if (ent.isDirectory() && /ffmpeg/i.test(ent.name)) {
          const found = findFfmpegInDir(path.join(wingetPkgs, ent.name), 3);
          if (found) return found;
        }
      }
    } catch {
      // ignore scan error
    }
  }
  return '';
}

function installFfmpegForPlatform({ dryRun = false, log = console.log, probe = probeCommand } = {}) {
  if (process.platform === 'win32') {
    if (probe('winget', ['--version']).ok) {
      const r = runPackageCommand(
        'winget',
        ['install', '--id', 'Gyan.FFmpeg', '-e', '--accept-source-agreements', '--accept-package-agreements'],
        { dryRun, log }
      );
      if (r.ok) {
        return {
          installed: true,
          manager: 'winget',
          ffmpegPath: dryRun ? '' : discoverWindowsFfmpegPath() || 'ffmpeg'
        };
      }
      return { installed: false, manager: 'winget', error: r.error };
    }
    if (probe('scoop', ['--version']).ok) {
      const r = runPackageCommand('scoop', ['install', 'ffmpeg'], { dryRun, log });
      return r.ok
        ? { installed: true, manager: 'scoop', ffmpegPath: dryRun ? '' : discoverWindowsFfmpegPath() || 'ffmpeg' }
        : { installed: false, manager: 'scoop', error: r.error };
    }
    if (probe('choco', ['--version']).ok) {
      const r = runPackageCommand('choco', ['install', 'ffmpeg', '-y'], { dryRun, log });
      return r.ok
        ? { installed: true, manager: 'choco', ffmpegPath: dryRun ? '' : discoverWindowsFfmpegPath() || 'ffmpeg' }
        : { installed: false, manager: 'choco', error: r.error };
    }
    return {
      installed: false,
      error: '未检测到 winget / scoop / choco，请前往 https://ffmpeg.org/download.html 手动安装并填写 vision.ffmpegPath'
    };
  }

  if (process.platform === 'darwin') {
    if (probe('brew', ['--version']).ok) {
      const r = runPackageCommand('brew', ['install', 'ffmpeg'], { dryRun, log });
      return r.ok
        ? { installed: true, manager: 'brew', ffmpegPath: 'ffmpeg' }
        : { installed: false, manager: 'brew', error: r.error };
    }
    return { installed: false, error: '未检测到 Homebrew，请先安装 brew 后执行 brew install ffmpeg' };
  }

  // Linux: only auto-run package manager when already root; otherwise print exact sudo command cleanly
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  const linuxMgrs = [
    { bin: 'apt-get', args: ['install', '-y', 'ffmpeg'], hint: 'sudo apt-get update && sudo apt-get install -y ffmpeg' },
    { bin: 'dnf', args: ['install', '-y', 'ffmpeg'], hint: 'sudo dnf install -y ffmpeg' },
    { bin: 'pacman', args: ['-S', '--noconfirm', 'ffmpeg'], hint: 'sudo pacman -S --noconfirm ffmpeg' }
  ];
  for (const m of linuxMgrs) {
    if (probe(m.bin, ['--version']).ok) {
      if (isRoot) {
        const r = runPackageCommand(m.bin, m.args, { dryRun, log });
        return r.ok
          ? { installed: true, manager: m.bin, ffmpegPath: 'ffmpeg' }
          : { installed: false, manager: m.bin, error: r.error };
      }
      return { installed: false, manager: m.bin, error: `请手动运行: ${m.hint}` };
    }
  }
  return { installed: false, error: '未识别的系统包管理器，请手动安装 ffmpeg 后重试' };
}

function copyDirClean(srcDir, dstDir) {
  fs.mkdirSync(dstDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const srcPath = path.join(srcDir, entry.name);
    const dstPath = path.join(dstDir, entry.name);
    if (entry.isDirectory()) {
      copyDirClean(srcPath, dstPath);
    } else {
      fs.copyFileSync(srcPath, dstPath);
    }
  }
}

function resolveDefaultPluginDir() {
  return path.join(os.homedir(), '.gemini', 'config', 'plugins', 'agyqq-hub');
}

function readJsonFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  return JSON.parse(raw);
}

function writeJsonFile(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
}

export async function runInstaller(rawOpts = {}, io = {}) {
  const opts = { ...parseCliArgs([]), ...rawOpts };
  const log = io.log || console.log;
  const rootDir = path.resolve(opts.rootDir || DEFAULT_ROOT);
  const exampleCfgPath = path.join(rootDir, 'config.example.json');
  const cfgPath = path.join(rootDir, 'config.json');
  const dataDir = path.join(rootDir, 'data');
  const logsDir = path.join(dataDir, 'logs');
  const tokenFilePath = path.join(dataDir, 'hub-token.txt');
  const pluginSrcDir = path.join(rootDir, 'plugins', 'agyqq-hub');
  const pluginDstDir = opts.pluginDir ? path.resolve(opts.pluginDir) : resolveDefaultPluginDir();

  const summary = {
    rootDir,
    dryRun: opts.dryRun,
    nodeVersion: process.versions.node,
    checks: {},
    configCreated: false,
    configUpdated: false,
    hubToken: '',
    ffmpegInstalled: false,
    ffmpegPath: '',
    pluginInstalled: false,
    pluginDir: pluginDstDir,
    sovitsInitialized: false,
    memewikiSynced: false
  };

  log('============================================================');
  log('  Antigravity QQ Bridge · 一键安装与初始化向导');
  log(`  项目目录: ${rootDir}${opts.dryRun ? '  [演练模式]' : ''}`);
  log('============================================================\n');

  // Step 1: Environment preflight
  log('[1/7] 检查运行环境...');
  if (!isNodeVersionSupported(process.versions.node)) {
    throw new Error(`当前 Node.js 版本为 v${process.versions.node}，需要 >= v${MIN_NODE.join('.')}（用于内置 node:sqlite）。请升级后重试。`);
  }
  const probe = io.probeCommand || probeCommand;
  let existingFfmpegCfg = '';
  if (fs.existsSync(cfgPath)) {
    try {
      existingFfmpegCfg = String(readJsonFile(cfgPath)?.vision?.ffmpegPath || '').trim();
    } catch {
      existingFfmpegCfg = '';
    }
  }
  const agyProbe = probe('agy', ['--version']);
  const primaryFfmpegBin = opts.ffmpegPath || existingFfmpegCfg || 'ffmpeg';
  let ffmpegProbe = probe(primaryFfmpegBin, ['-version']);
  let detectedFfmpegPath = ffmpegProbe.ok ? primaryFfmpegBin : '';
  if (!ffmpegProbe.ok && !io.probeCommand) {
    const winFound = discoverWindowsFfmpegPath();
    if (winFound) {
      const p2 = probe(winFound, ['-version']);
      if (p2.ok) {
        ffmpegProbe = p2;
        detectedFfmpegPath = winFound;
      }
    }
  }
  const napcatDirExists = fs.existsSync(path.join(rootDir, 'napcat'));
  const geminiDirExists = fs.existsSync(path.join(os.homedir(), '.gemini'));

  summary.checks = {
    nodeOk: true,
    agyOk: agyProbe.ok,
    agyVersion: agyProbe.version,
    ffmpegOk: ffmpegProbe.ok,
    ffmpegPath: detectedFfmpegPath,
    napcatDirExists,
    geminiDirExists
  };
  summary.ffmpegPath = detectedFfmpegPath;

  log(`  ✓ Node.js v${process.versions.node} (>= v${MIN_NODE.join('.')})`);
  log(agyProbe.ok ? `  ✓ Antigravity CLI (agy): ${agyProbe.version}` : '  ! 未检测到 agy CLI（请安装并登录 Google Antigravity CLI 后再启动桥接服务）');
  log(ffmpegProbe.ok ? `  ✓ FFmpeg 已就绪 (${detectedFfmpegPath}，支持动态 GIF 时序分镜)` : '  · 未检测到 FFmpeg（可选；如需 GIF 动态分镜，可加 --with-ffmpeg 自动安装或手动配置 vision.ffmpegPath）');
  log(napcatDirExists ? '  ✓ 检测到项目内 napcat/ 目录' : '  · 未检测到项目内 napcat/ 目录（可选；你也可以连接外部独立运行的 OneBot v11 协议端）');

  let rl = null;
  const interactive = !opts.yes && Boolean(process.stdin.isTTY) && !io.nonInteractive;
  if (interactive) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  }
  const ask = async (question, fallback = '') => {
    if (!rl) return fallback;
    const suffix = fallback ? ` [默认: ${fallback}]` : '';
    const ans = (await rl.question(`${question}${suffix}: `)).trim();
    return ans || fallback;
  };
  const askYesNo = async (question, defaultYes = true) => {
    if (!rl) return defaultYes;
    const hint = defaultYes ? 'Y/n' : 'y/N';
    const ans = (await rl.question(`${question} (${hint}): `)).trim().toLowerCase();
    if (!ans) return defaultYes;
    return ans === 'y' || ans === 'yes';
  };

  try {
    // Step 2: Install root npm dependencies
    log('\n[2/7] 安装核心运行依赖（仅 ws）...');
    const hasWs = fs.existsSync(path.join(rootDir, 'node_modules', 'ws', 'package.json'));
    if (opts.skipNpm) {
      log('  · 已按 --skip-npm 跳过依赖安装');
    } else if (hasWs) {
      log('  ✓ node_modules/ws 已存在，跳过重复安装');
    } else {
      runNpmCommand(['install'], rootDir, { dryRun: opts.dryRun, log });
    }

    // Step 3: Initialize or gently merge config.json
    log('\n[3/7] 初始化主配置 config.json...');
    if (!fs.existsSync(exampleCfgPath)) {
      throw new Error(`未找到配置模板: ${exampleCfgPath}`);
    }
    const configExists = fs.existsSync(cfgPath);
    let cfg = configExists && !opts.forceConfig ? readJsonFile(cfgPath) : readJsonFile(exampleCfgPath);
    let dirty = !configExists || opts.forceConfig;

    if (!configExists || opts.forceConfig) {
      summary.configCreated = true;
      log(opts.forceConfig && configExists ? '  ! 将按 --force-config 从模板重新生成 config.json' : '  · 未发现 config.json，将基于 config.example.json 生成');
      if (interactive) {
        if (!opts.ownerQq.length) {
          const qqAns = await ask('  主人 QQ 号（多个用逗号分隔，留空稍后在 Hub 填写）');
          opts.ownerQq.push(...splitCsv(qqAns));
        }
        if (!opts.groupIds.length) {
          const grpAns = await ask('  允许响应的 QQ 群号白名单（多个用逗号分隔，留空稍后在 Hub 填写）');
          opts.groupIds.push(...splitCsv(grpAns));
        }
        if (!opts.personaName) {
          const nameAns = await ask('  AI 伴侣名称', cfg.acp?.persona?.name || 'Gemini猫娘·幽兰');
          if (nameAns && nameAns !== cfg.acp?.persona?.name) opts.personaName = nameAns;
        }
        if (opts.contextBudget === null) {
          const ctxAns = await ask('  单会话上下文预算 tokens（16000~2097152，0 表示不限）', String(cfg.acp?.contextBudgetTokens ?? 256000));
          const parsedCtx = Number(ctxAns);
          if (Number.isFinite(parsedCtx) && parsedCtx >= 0) {
            opts.contextBudget = parsedCtx === 0 ? 0 : Math.min(2097152, Math.max(16000, Math.round(parsedCtx)));
          }
        }
      }
    } else {
      log('  ✓ 已检测到现有 config.json，保留原有配置不被覆盖');
    }

    // Ensure nested sections exist
    cfg.hub = cfg.hub || { host: '127.0.0.1', port: 3200, token: '' };
    cfg.guard = cfg.guard || {};
    cfg.onebot = cfg.onebot || {};
    cfg.acp = cfg.acp || {};
    cfg.acp.persona = cfg.acp.persona || {};
    cfg.vision = cfg.vision || {};
    cfg.tts = cfg.tts || {};

    if (opts.hubToken) {
      cfg.hub.token = opts.hubToken;
      dirty = true;
    } else if (!cfg.hub.token) {
      cfg.hub.token = crypto.randomBytes(16).toString('hex');
      dirty = true;
    }
    summary.hubToken = cfg.hub.token;

    if (opts.ownerQq.length) {
      cfg.guard.ownerUsers = uniqueMerge(cfg.guard.ownerUsers, opts.ownerQq);
      dirty = true;
    }
    if (opts.groupIds.length) {
      cfg.guard.allowGroups = uniqueMerge(cfg.guard.allowGroups, opts.groupIds);
      dirty = true;
    }
    if (opts.personaName) {
      cfg.acp.persona.name = opts.personaName;
      dirty = true;
    }
    if (opts.contextBudget !== null) {
      cfg.acp.contextBudgetTokens = opts.contextBudget;
      dirty = true;
    }
    if (opts.wsUrl) {
      cfg.onebot.wsUrl = opts.wsUrl;
      dirty = true;
    }
    if (opts.httpUrl) {
      cfg.onebot.httpUrl = opts.httpUrl;
      dirty = true;
    }
    if (opts.ffmpegPath) {
      cfg.vision.ffmpegPath = opts.ffmpegPath;
      dirty = true;
    } else if (detectedFfmpegPath && detectedFfmpegPath !== 'ffmpeg' && (!cfg.vision.ffmpegPath || cfg.vision.ffmpegPath === 'ffmpeg')) {
      cfg.vision.ffmpegPath = detectedFfmpegPath;
      dirty = true;
    }
    if (opts.sovitsRoot) {
      cfg.tts.sovitsRoot = opts.sovitsRoot;
      cfg.tts.enabled = true;
      dirty = true;
    }

    const persistConfigIfDirty = () => {
      if (dirty) {
        summary.configUpdated = true;
        if (opts.dryRun) {
          log(`  [演练] 将写入 ${cfgPath} 与 ${tokenFilePath}`);
        } else {
          fs.mkdirSync(logsDir, { recursive: true });
          writeJsonFile(cfgPath, cfg);
          fs.writeFileSync(tokenFilePath, `${cfg.hub.token}\n`, 'utf8');
          log(`  ✓ 已写入 ${cfgPath}`);
        }
        dirty = false;
      } else if (!opts.dryRun) {
        fs.mkdirSync(logsDir, { recursive: true });
        if (!fs.existsSync(tokenFilePath) && cfg.hub.token) {
          fs.writeFileSync(tokenFilePath, `${cfg.hub.token}\n`, 'utf8');
        }
      }
    };
    persistConfigIfDirty();

    // Step 4: Optional FFmpeg installation (for GIF temporal storyboard)
    log('\n[4/7] 可选组件：FFmpeg（用于动态 GIF 时序分镜）...');
    if (ffmpegProbe.ok) {
      log(`  ✓ 已检测到 FFmpeg (${detectedFfmpegPath})，跳过安装`);
    } else {
      let doFfmpeg = opts.withFfmpeg;
      if (doFfmpeg === null) {
        doFfmpeg = interactive
          ? await askYesNo('  未检测到 FFmpeg，是否通过系统包管理器自动安装（推荐，用于 GIF 动图分镜）？', true)
          : false;
      }
      if (doFfmpeg) {
        const installerFn = io.installFfmpeg || installFfmpegForPlatform;
        const ffRes = await installerFn({ dryRun: opts.dryRun, log, probe });
        if (ffRes?.installed) {
          summary.ffmpegInstalled = true;
          summary.checks.ffmpegOk = true;
          const resolvedBin = String(ffRes.ffmpegPath || '').trim();
          if (resolvedBin) {
            summary.ffmpegPath = resolvedBin;
            if (!opts.dryRun && resolvedBin !== cfg.vision.ffmpegPath) {
              cfg.vision.ffmpegPath = resolvedBin;
              dirty = true;
              persistConfigIfDirty();
            }
          }
          log(
            opts.dryRun
              ? `  [演练] 将通过 ${ffRes.manager || '系统包管理器'} 安装 FFmpeg 并自动绑定 vision.ffmpegPath`
              : `  ✓ FFmpeg 安装完成${resolvedBin ? `（已自动绑定 vision.ffmpegPath = ${resolvedBin}）` : ''}`
          );
        } else {
          log(`  ! 未能自动安装 FFmpeg：${ffRes?.error || '请手动安装后在 Hub 填写 vision.ffmpegPath'}`);
        }
      } else {
        log('  · 跳过 FFmpeg 自动安装（静图识图不受影响；之后可随时加 --with-ffmpeg 补装）');
      }
    }

    // Step 5: Optional GPT-SoVITS v5 scaffolding
    log('\n[5/7] 可选组件：GPT-SoVITS v5 语音配置...');
    let doSovits = opts.withSovits;
    if (doSovits === null) {
      doSovits = interactive
        ? await askYesNo('  是否初始化 GPT-SoVITS v5 推理配置模板与 audio_clip/ 参考音频目录？', false)
        : false;
    }
    if (doSovits) {
      const yamlExample = path.join(rootDir, 'tts_infer_v5dev.example.yaml');
      const yamlTarget = path.join(rootDir, 'tts_infer_v5dev.yaml');
      const clipDir = path.join(rootDir, 'audio_clip');
      if (opts.dryRun) {
        log(`  [演练] 将创建 ${clipDir} 并在缺失时复制 ${yamlTarget}`);
      } else {
        fs.mkdirSync(clipDir, { recursive: true });
        if (!fs.existsSync(yamlTarget) && fs.existsSync(yamlExample)) {
          fs.copyFileSync(yamlExample, yamlTarget);
          log(`  ✓ 已创建 ${yamlTarget}（请按需填入你本机底模路径）`);
        } else {
          log(`  ✓ 保留已有 ${yamlTarget}`);
        }
        log(`  ✓ 已就绪参考音频目录 ${clipDir}（放入 6 情感 .wav 文件即可）`);
      }
      summary.sovitsInitialized = true;
    } else {
      log('  · 跳过 GPT-SoVITS v5 初始化（纯文字模式可直接运行，随时可补配）');
    }

    // Step 6: Optional Antigravity 2.0 (AGY 2) MCP App plugin
    log('\n[6/7] 可选组件：Antigravity 2.0 (AGY 2) 侧边栏插件 (agyqq-hub)...');
    let doPlugin = opts.withPlugin;
    if (doPlugin === null) {
      if (interactive) {
        doPlugin = await askYesNo(`  是否安装并打包 Antigravity 2.0 侧边栏插件到 ${pluginDstDir}？`, geminiDirExists);
      } else {
        doPlugin = Boolean(geminiDirExists || opts.pluginDir);
      }
    }
    if (doPlugin) {
      if (!fs.existsSync(pluginSrcDir)) {
        log(`  ! 未找到插件源码目录: ${pluginSrcDir}，已跳过`);
      } else if (opts.dryRun) {
        log(`  [演练] 将复制插件源码至 ${pluginDstDir}，自动写入 AGYQQ_BRIDGE_DIR=${rootDir} 并执行 npm install && npm run build`);
        summary.pluginInstalled = true;
      } else {
        copyDirClean(pluginSrcDir, pluginDstDir);
        const mcpCfgPath = path.join(pluginDstDir, 'mcp_config.json');
        const mcpCfg = fs.existsSync(mcpCfgPath)
          ? readJsonFile(mcpCfgPath)
          : { mcpServers: { hub: { command: 'node', args: ['${PLUGIN_ROOT}/bin/server.mjs'] } } };
        mcpCfg.mcpServers = mcpCfg.mcpServers || {};
        mcpCfg.mcpServers.hub = mcpCfg.mcpServers.hub || {
          command: 'node',
          args: ['${PLUGIN_ROOT}/bin/server.mjs']
        };
        mcpCfg.mcpServers.hub.env = {
          ...(mcpCfg.mcpServers.hub.env || {}),
          AGYQQ_BRIDGE_DIR: rootDir
        };
        writeJsonFile(mcpCfgPath, mcpCfg);
        log(`  ✓ 已安装插件源码并自动绑定 AGYQQ_BRIDGE_DIR=${rootDir}`);

        if (!opts.skipNpm) {
          const hasExtApps = fs.existsSync(path.join(pluginDstDir, 'node_modules', '@modelcontextprotocol', 'ext-apps'));
          if (!hasExtApps) {
            runNpmCommand(['install'], pluginDstDir, { dryRun: false, log });
          }
          runNpmCommand(['run', 'build'], pluginDstDir, { dryRun: false, log });
        } else {
          log('  · 已按 --skip-npm 跳过插件依赖安装与构建');
        }
        summary.pluginInstalled = true;
      }
    } else {
      log('  · 跳过 Antigravity 2.0 侧边栏插件安装（之后可随时加 --with-plugin 补装）');
    }

    // Step 7: Optional L2 MemeWiki sync
    log('\n[7/7] 可选组件：L2 离线公共梗百科 (cnmeme.wiki -> data/memes.db)...');
    let doMeme = opts.withMemewiki;
    const memesDbPath = path.join(dataDir, 'memes.db');
    if (doMeme === null) {
      if (fs.existsSync(memesDbPath)) {
        log('  ✓ 检测到已有 data/memes.db，跳过首次全量拉取');
        doMeme = false;
      } else if (interactive) {
        doMeme = await askYesNo('  是否现在从 cnmeme.wiki 同步 L2 离线公共梗百科（需联网，约数十秒）？', false);
      } else {
        doMeme = false;
      }
    }
    if (doMeme) {
      const syncScript = path.join(rootDir, 'scripts', 'sync-cnmeme.mjs');
      if (opts.dryRun) {
        log(`  [演练] 将执行: node ${syncScript} --no-existing`);
        summary.memewikiSynced = true;
      } else if (fs.existsSync(syncScript)) {
        const res = spawnSync(process.execPath, [syncScript, '--no-existing'], {
          cwd: rootDir,
          stdio: 'inherit'
        });
        if (res.status !== 0) {
          log(`  ! L2 梗百科同步未能完成（exit ${res.status}），不影响核心使用，稍后可在 Hub 内一键重试`);
        } else {
          summary.memewikiSynced = true;
          log('  ✓ L2 离线梗百科已同步就绪');
        }
      }
    } else if (!fs.existsSync(memesDbPath)) {
      log('  · 跳过 L2 梗百科同步（随时可运行 node scripts/sync-cnmeme.mjs --no-existing 或在 Hub 内同步）');
    }

    const host = cfg.hub?.host || '127.0.0.1';
    const port = cfg.hub?.port || 3200;
    const hubUrl = cfg.hub?.token ? `http://${host}:${port}/?token=${cfg.hub.token}` : `http://${host}:${port}/`;

    log('\n============================================================');
    log(opts.dryRun ? '  演练完成（未改动任何文件）' : '  ✅ 安装与初始化完成！');
    log('============================================================');
    log(`  Hub 控制台地址: ${hubUrl}`);
    if (summary.pluginInstalled) {
      log(`  AGY 2 侧边栏插件: ${pluginDstDir}（重启或重载插件即可在 Antigravity 2.0 侧边栏打开）`);
    }
    log('\n下一步启动方式:');
    log('  1. 仅启动桥接核心:        npm start  （或 Windows 双击 start.bat）');
    log('  2. Windows 一键联合启动:  .\\start-agyqq.ps1 -WithNapCat -OpenHub  （或双击 start-all.bat）');
    log('  3. 运行单元测试核验:      npm test');
    if (!cfg.guard?.ownerUsers?.length) {
      log('  提示: 启动后请打开 Hub →「群聊与权限防护」填入主人 QQ 号与测试群白名单。');
    }

    return summary;
  } finally {
    if (rl) rl.close();
  }
}

const isDirectEntry =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectEntry) {
  try {
    const opts = parseCliArgs(process.argv.slice(2));
    if (opts.help) {
      console.log(getHelpText());
      process.exit(0);
    }
    await runInstaller(opts);
  } catch (err) {
    console.error(`\n[安装失败] ${err.message}`);
    process.exit(1);
  }
}
