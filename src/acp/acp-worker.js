import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import fs from 'node:fs';
import { buildChildEnvWithProxy } from '../config/proxy-detect.js';

export class AcpWorker extends EventEmitter {
  constructor(options = {}) {
    super();
    this.name = options.name || 'acp-worker';
    this.binary = options.binary || 'agy';
    this.cwd = options.cwd || process.cwd();
    this.sandbox = Boolean(options.sandbox);
    this.additionalDirs = Array.isArray(options.additionalDirs) ? options.additionalDirs : [];
    this.proxyUrl = options.proxyUrl || '';
    this.requestTimeoutMs = options.requestTimeoutMs || 120000;
    this.onPermissionRequest = options.onPermissionRequest || (async () => ({ allow: false, reason: 'default-deny' }));
    this.blockAllTools = Boolean(options.blockAllTools);

    this.child = null;
    this.decoder = new StringDecoder('utf8');
    this.buffer = '';
    this.seq = 1;
    this.pending = new Map();
    this.turnCollectors = new Map();

    this.ready = false;
    this.startingPromise = null;
    this.stopped = false;
    this.restarts = 0;
    this.startedAt = null;
    this.lastLatencyMs = null;
    this.latencySamples = [];
    this.agentInfo = null;
    this.capabilities = null;
    this.availableModels = [];
    this.configOptions = [];
    this.tierInfo = null;
    this.lastError = null;
  }

  async ensureStarted() {
    if (this.ready && this.child && !this.child.killed) {
      return;
    }
    if (this.startingPromise) {
      return this.startingPromise;
    }
    this.stopped = false;
    this.startingPromise = this._startInternal().finally(() => {
      this.startingPromise = null;
    });
    return this.startingPromise;
  }

  async _startInternal() {
    fs.mkdirSync(this.cwd, { recursive: true });
    const args = ['acp', '--stdio'];
    if (this.sandbox) {
      args.push('--sandbox');
    }
    for (const dir of this.additionalDirs) {
      if (dir && fs.existsSync(dir)) {
        args.push('--add-dir', dir);
      }
    }

    const env = buildChildEnvWithProxy(this.proxyUrl);
    this.buffer = '';
    this.decoder = new StringDecoder('utf8');
    this.ready = false;
    this.lastError = null;

    const child = spawn(this.binary, args, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      windowsHide: true
    });
    this.child = child;
    this.startedAt = Date.now();

    child.stdout.on('data', (chunk) => this._onStdout(chunk));
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8').trim();
      if (text) {
        this.emit('log', { level: 'debug', worker: this.name, message: `[stderr] ${text}` });
      }
    });

    child.once('error', (err) => {
      this.lastError = err.message;
      this.emit('log', { level: 'error', worker: this.name, message: `ACP 子进程启动失败: ${err.message}` });
      this._rejectAllPending(err);
    });

    child.once('exit', (code, signal) => {
      const wasReady = this.ready;
      this.ready = false;
      this.child = null;
      const err = new Error(`ACP worker(${this.name}) exited (code=${code}, signal=${signal})`);
      this._rejectAllPending(err);
      this.emit('exit', { worker: this.name, code, signal, wasReady });
      if (!this.stopped) {
        this.restarts += 1;
        this.emit('log', {
          level: 'warn',
          worker: this.name,
          message: `ACP 持久通道意外退出(code=${code})，等待按需自动拉起 (第 ${this.restarts} 次)`
        });
      }
    });

    const t0 = Date.now();
    const initRes = await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false
      },
      clientInfo: {
        name: 'antigravity-qq-bridge',
        version: '1.0.0'
      }
    }, 30000);

    this._recordLatency(Date.now() - t0);
    this.agentInfo = initRes?.agentInfo || null;
    this.capabilities = initRes?.agentCapabilities || null;
    this.ready = true;
    this.emit('ready', { worker: this.name, agentInfo: this.agentInfo, latencyMs: this.lastLatencyMs });
    this.emit('log', {
      level: 'info',
      worker: this.name,
      message: `ACP 通道就绪 (${this.agentInfo?.name || 'agy'} v${this.agentInfo?.version || '?'}, ${this.sandbox ? '沙盒隔离' : '主人工作区'}, ${this.lastLatencyMs}ms)`
    });
  }

  _recordLatency(ms) {
    this.lastLatencyMs = Math.max(0, Math.round(ms));
    this.latencySamples.push(this.lastLatencyMs);
    if (this.latencySamples.length > 30) this.latencySamples.shift();
  }

  _rejectAllPending(err) {
    for (const [id, entry] of this.pending.entries()) {
      clearTimeout(entry.timer);
      entry.reject(err);
      this.pending.delete(id);
    }
  }

  _onStdout(chunk) {
    this.buffer += this.decoder.write(chunk);
    let idx;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      this._handleLine(line);
    }
  }

  _handleLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      this.emit('log', { level: 'debug', worker: this.name, message: `忽略非 JSON 输出: ${line.slice(0, 160)}` });
      return;
    }

    // 1. Server -> Client RPC request (e.g., session/request_permission)
    if (msg.id !== undefined && typeof msg.method === 'string') {
      this._handleServerRequest(msg).catch((err) => {
        this.emit('log', { level: 'error', worker: this.name, message: `处理服务端请求 ${msg.method} 出错: ${err.message}` });
      });
      return;
    }

    // 2. Response to our request
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const entry = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) {
        const err = new Error(msg.error.message || JSON.stringify(msg.error));
        err.rpcError = msg.error;
        entry.reject(err);
      } else {
        entry.resolve(msg.result);
      }
      return;
    }

    // 3. Server notification (session/update)
    if (msg.method === 'session/update') {
      this._handleSessionUpdate(msg.params);
    }
  }

  async _handleServerRequest(msg) {
    if (msg.method === 'session/request_permission') {
      const params = msg.params || {};
      const options = Array.isArray(params.options) ? params.options : [];
      const allowOpt = options.find((o) => String(o.kind || '').includes('allow')) || options[0];
      const denyOpt = options.find((o) => String(o.kind || '').includes('reject')) || options[options.length - 1];

      let decision = { allow: false, reason: 'group-hard-block' };
      try {
        decision = await this.onPermissionRequest({
          worker: this.name,
          sessionId: params.sessionId,
          toolCall: params.toolCall,
          toolArgs: params.toolCall?.args || params.toolCall?.rawInput || {},
          options
        });
      } catch (err) {
        decision = { allow: false, reason: `callback-error: ${err.message}` };
      }

      const chosen = decision?.allow ? allowOpt : denyOpt;
      const optionId = chosen?.optionId || (decision?.allow ? 'allow' : 'deny');

      this.emit('permission', {
        worker: this.name,
        sessionId: params.sessionId,
        toolName: params.toolCall?.name || 'unknown',
        toolKind: params.toolCall?.kind || 'unknown',
        toolTitle: params.toolCall?.title || '',
        allowed: Boolean(decision?.allow),
        reason: decision?.reason || ''
      });

      this._writeJson({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          outcome: {
            outcome: 'selected',
            optionId
          }
        }
      });
      return;
    }

    // Unknown server request -> return JSON-RPC Method Not Found
    this._writeJson({
      jsonrpc: '2.0',
      id: msg.id,
      error: { code: -32601, message: `Method not implemented by bridge: ${msg.method}` }
    });
  }

  _handleSessionUpdate(params) {
    const sid = params?.sessionId;
    const u = params?.update;
    if (!sid || !u) return;

    const collector = this.turnCollectors.get(sid);
    if (!collector) return;

    switch (u.sessionUpdate) {
      case 'agent_message_chunk': {
        const text = u.content?.text;
        if (typeof text === 'string') {
          collector.chunks.push(text);
          if (typeof collector.onChunk === 'function') collector.onChunk(text);
        }
        break;
      }
      case 'agent_thought_chunk': {
        const text = u.content?.text;
        if (typeof text === 'string') collector.thoughts.push(text);
        break;
      }
      case 'usage_update': {
        collector.contextUsed = Number(u.used ?? collector.contextUsed ?? 0);
        collector.contextSize = Number(u.size ?? collector.contextSize ?? 0);
        break;
      }
      case 'tool_call':
      case 'tool_call_update': {
        collector.toolCalls.push({
          id: u.toolCallId,
          name: u.name,
          kind: u.kind,
          status: u.status,
          title: u.title
        });
        if (this.blockAllTools && u.sessionUpdate === 'tool_call') {
          const toolName = String(u.name || '').toLowerCase();
          const toolKind = String(u.kind || '').toLowerCase();
          if (toolName === 'search_web' || toolKind === 'search') {
            this.emit('log', {
              level: 'info',
              worker: this.name,
              message: `群聊联网搜索: ${u.title || u.name}`
            });
          } else if (toolName === 'read_file' || toolName === 'view_file') {
            this.emit('log', {
              level: 'debug',
              worker: this.name,
              message: `群聊只读工具请求: ${u.name} (${u.title || '交由权限守卫校验'})`
            });
          } else {
            this.emit('log', {
              level: 'warn',
              worker: this.name,
              message: `安全守卫捕获群聊模型尝试调用工具: ${u.name || u.title || 'unknown'} (交由权限守卫拦截)`
            });
          }
        }
        break;
      }
      case 'config_option_update': {
        if (Array.isArray(u.configOptions)) {
          this.configOptions = u.configOptions;
        }
        break;
      }
      default:
        break;
    }
  }

  _writeJson(obj) {
    if (!this.child || !this.child.stdin || this.child.stdin.destroyed) {
      throw new Error(`ACP worker(${this.name}) stdin is not writable`);
    }
    this.child.stdin.write(JSON.stringify(obj) + '\n');
  }

  request(method, params, timeoutMs = this.requestTimeoutMs) {
    if (!this.child || this.child.killed) {
      return Promise.reject(new Error(`ACP worker(${this.name}) is not running`));
    }
    const id = this.seq++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ACP RPC timeout (${method}, ${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this._writeJson({ jsonrpc: '2.0', id, method, params });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  async createSession({ cwd, systemPromptAppend = '', mcpServers = [] } = {}) {
    await this.ensureStarted();
    const params = {
      cwd: cwd || this.cwd,
      mcpServers
    };
    if (systemPromptAppend) {
      params._meta = {
        antigravity: {
          systemPrompt: { append: systemPromptAppend }
        }
      };
    }
    const t0 = Date.now();
    const res = await this.request('session/new', params, 30000);
    this._recordLatency(Date.now() - t0);
    if (Array.isArray(res?.models?.availableModels)) {
      this.availableModels = res.models.availableModels;
    }
    if (Array.isArray(res?.configOptions)) {
      this.configOptions = res.configOptions;
    }
    if (res?._meta?.antigravity?.tier) {
      this.tierInfo = res._meta.antigravity.tier;
    }
    return res;
  }

  async loadSession(sessionId, { cwd } = {}) {
    await this.ensureStarted();
    return this.request('session/load', { sessionId, cwd: cwd || this.cwd, mcpServers: [] }, 30000);
  }

  async closeSession(sessionId) {
    if (!this.ready || !this.child) return;
    try {
      await this.request('session/close', { sessionId }, 10000);
    } catch {
      // ignore close errors
    }
  }

  async setConfigOption(sessionId, configId, value) {
    await this.ensureStarted();
    const res = await this.request('session/set_config_option', {
      sessionId,
      configId,
      value
    }, 15000);
    if (Array.isArray(res?.configOptions)) {
      this.configOptions = res.configOptions;
    }
    return res;
  }

  async prompt(sessionId, promptBlocks, { onChunk } = {}) {
    await this.ensureStarted();
    const collector = {
      chunks: [],
      thoughts: [],
      toolCalls: [],
      contextUsed: 0,
      contextSize: 0,
      onChunk
    };
    this.turnCollectors.set(sessionId, collector);
    const t0 = Date.now();
    try {
      const res = await this.request(
        'session/prompt',
        {
          sessionId,
          prompt: promptBlocks
        },
        this.requestTimeoutMs
      );
      const latencyMs = Date.now() - t0;
      this._recordLatency(latencyMs);
      return {
        text: collector.chunks.join('').trim(),
        thought: collector.thoughts.join('').trim(),
        toolCalls: collector.toolCalls,
        usage: res?.usage || {},
        stopReason: res?.stopReason || 'end_turn',
        contextUsed: collector.contextUsed,
        contextSize: collector.contextSize,
        latencyMs
      };
    } finally {
      this.turnCollectors.delete(sessionId);
    }
  }

  getStatus() {
    const avgLatencyMs = this.latencySamples.length
      ? Math.round(this.latencySamples.reduce((a, b) => a + b, 0) / this.latencySamples.length)
      : null;
    return {
      name: this.name,
      ready: this.ready,
      pid: this.child?.pid || null,
      sandbox: this.sandbox,
      cwd: this.cwd,
      startedAt: this.startedAt,
      restarts: this.restarts,
      lastLatencyMs: this.lastLatencyMs,
      avgLatencyMs,
      agentInfo: this.agentInfo,
      tierInfo: this.tierInfo,
      availableModels: this.availableModels,
      configOptions: this.configOptions,
      lastError: this.lastError
    };
  }

  async stop() {
    this.stopped = true;
    this.ready = false;
    const child = this.child;
    this.child = null;
    this._rejectAllPending(new Error(`ACP worker(${this.name}) stopped`));
    if (child && !child.killed) {
      try {
        child.kill();
      } catch {
        // ignore
      }
    }
  }
}
