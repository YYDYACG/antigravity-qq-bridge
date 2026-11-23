import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import { parseOneBotMessageEvent } from './message-parser.js';

export class OneBotClient extends EventEmitter {
  constructor(configStore) {
    super();
    this.configStore = configStore;

    this.ws = null;
    this.wss = null;
    this.connected = false;
    this.stopped = true;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.silenceTimer = null;
    this.lastEventAt = null;
    this.selfInfo = null;
    this.lastError = null;
    this.pendingActions = new Map();
  }

  async start() {
    const cfg = this.configStore.get().onebot;
    if (!cfg.enabled) {
      this.emit('log', { level: 'info', message: 'OneBot 协议接入当前已禁用，仅运行 Antigravity Hub 模式' });
      return;
    }
    this.stopped = false;
    this.lastError = null;
    this.reconnectAttempts = 0;

    if (cfg.mode === 'reverse-ws') {
      this._startReverseWs(cfg);
    } else {
      this._connectForwardWs();
    }
    this._startSilenceWatchdog();
  }

  _startSilenceWatchdog() {
    if (this.silenceTimer) clearInterval(this.silenceTimer);
    this.silenceTimer = setInterval(() => {
      if (!this.connected || !this.lastEventAt) return;
      const threshold = this.configStore.get().onebot.silenceWarnMs || 600000;
      if (Date.now() - this.lastEventAt > threshold) {
        this.emit('log', {
          level: 'warn',
          message: `OneBot 通道已超过 ${Math.round(threshold / 60000)} 分钟未收到事件/心跳，请检查 QQ 协议端在线状态`
        });
      }
    }, 60000);
  }

  _startReverseWs(cfg) {
    this._closeWss();
    const wss = new WebSocketServer({
      host: cfg.reverseWsHost || '127.0.0.1',
      port: cfg.reverseWsPort || 8085,
      path: cfg.reverseWsPath || '/onebot/v11/ws'
    });
    this.wss = wss;

    wss.on('listening', () => {
      this.emit('log', {
        level: 'info',
        message: `OneBot v11 反向 WS 服务端已监听 ws://${cfg.reverseWsHost}:${cfg.reverseWsPort}${cfg.reverseWsPath}`
      });
    });

    wss.on('connection', (socket, req) => {
      const token = this.configStore.get().onebot.accessToken;
      if (token) {
        const authHeader = String(req.headers.authorization || '');
        const url = new URL(req.url || '/', 'http://127.0.0.1');
        const queryToken = url.searchParams.get('access_token') || '';
        const expectedBearer = `Bearer ${token}`;
        if (authHeader !== expectedBearer && authHeader !== `Token ${token}` && queryToken !== token) {
          socket.close(1008, 'Unauthorized');
          this.emit('log', { level: 'warn', message: '拒绝了未携带正确 accessToken 的反向 WS 连接' });
          return;
        }
      }
      if (this.ws && this.ws !== socket) {
        try {
          this.ws.terminate();
        } catch {}
      }
      this._attachSocket(socket);
    });

    wss.on('error', (err) => {
      this.lastError = err.message;
      this.emit('log', { level: 'error', message: `OneBot 反向 WS 监听出错: ${err.message}` });
    });
  }

  _connectForwardWs() {
    if (this.stopped) return;
    const cfg = this.configStore.get().onebot;
    let url = String(cfg.wsUrl || '').trim();
    if (!url) {
      this.lastError = '未配置 onebot.wsUrl';
      return;
    }

    const headers = {};
    if (cfg.accessToken) {
      headers.Authorization = `Bearer ${cfg.accessToken}`;
      if (!url.includes('access_token=')) {
        url += (url.includes('?') ? '&' : '?') + `access_token=${encodeURIComponent(cfg.accessToken)}`;
      }
    }

    let socket;
    try {
      socket = new WebSocket(url, { headers, handshakeTimeout: 10000 });
    } catch (err) {
      this.lastError = err.message;
      this._scheduleReconnect();
      return;
    }

    this._attachSocket(socket);
  }

  _attachSocket(socket) {
    this.ws = socket;

    const onOpen = () => {
      this.connected = true;
      this.reconnectAttempts = 0;
      this.lastEventAt = Date.now();
      this.lastError = null;
      this.emit('connected');
      this.emit('log', { level: 'info', message: 'OneBot v11 WebSocket 通道已连接' });
      this.callAction('get_login_info', {})
        .then((info) => {
          this.selfInfo = info || null;
          if (info?.user_id) {
            this.emit('log', {
              level: 'info',
              message: `QQ 协议端身份确认: ${info.nickname || 'Bot'} (${info.user_id})`
            });
          }
        })
        .catch(() => {});
    };

    if (socket.readyState === WebSocket.OPEN) {
      onOpen();
    } else {
      socket.once('open', onOpen);
    }

    socket.on('message', (data) => {
      this.lastEventAt = Date.now();
      this._handleFrame(data.toString('utf8'));
    });

    socket.on('error', (err) => {
      this.lastError = err.message;
      this.emit('log', { level: 'warn', message: `OneBot WS 连接错误: ${err.message}` });
    });

    socket.on('close', (code, reason) => {
      const wasConnected = this.connected;
      this.connected = false;
      if (this.ws === socket) this.ws = null;
      this._rejectPendingActions(new Error(`OneBot WS closed (${code})`));
      if (wasConnected) {
        this.emit('disconnected', { code, reason: reason?.toString() || '' });
        this.emit('log', { level: 'warn', message: `OneBot WS 连接断开 (code=${code})` });
      }
      if (!this.stopped && this.configStore.get().onebot.mode === 'forward-ws') {
        this._scheduleReconnect();
      }
    });
  }

  _scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    const cfg = this.configStore.get().onebot;
    const delay = Math.min(
      cfg.reconnectMaxMs || 30000,
      (cfg.reconnectBaseMs || 2000) * Math.pow(1.6, Math.min(this.reconnectAttempts, 8))
    );
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._connectForwardWs();
    }, Math.round(delay));
  }

  _handleFrame(raw) {
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return;
    }

    // Action response (echo correlation)
    if (payload.echo && this.pendingActions.has(payload.echo)) {
      const entry = this.pendingActions.get(payload.echo);
      this.pendingActions.delete(payload.echo);
      clearTimeout(entry.timer);
      if (payload.status === 'failed' || (payload.retcode !== undefined && payload.retcode !== 0)) {
        const msg = payload.wording || payload.message || `OneBot action failed (retcode=${payload.retcode})`;
        const err = new Error(msg);
        err.retcode = payload.retcode;
        entry.reject(err);
      } else {
        entry.resolve(payload.data);
      }
      return;
    }

    // Events
    if (payload.post_type === 'meta_event') {
      if (payload.self_id && !this.selfInfo) {
        this.selfInfo = { user_id: payload.self_id, nickname: '' };
      }
      return;
    }

    if (payload.post_type === 'message') {
      const parsed = parseOneBotMessageEvent(payload);
      // Ignore self echo messages
      if (parsed.selfId && parsed.userId === parsed.selfId) return;
      this.emit('message', parsed);
    }
  }

  _rejectPendingActions(err) {
    for (const [echo, entry] of this.pendingActions.entries()) {
      clearTimeout(entry.timer);
      entry.reject(err);
      this.pendingActions.delete(echo);
    }
  }

  async callAction(action, params = {}, timeoutMs = 15000) {
    // Prefer active WS socket
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const echo = `agy_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pendingActions.delete(echo);
          reject(new Error(`OneBot WS action timeout: ${action}`));
        }, timeoutMs);
        this.pendingActions.set(echo, { resolve, reject, timer });
        this.ws.send(JSON.stringify({ action, params, echo }));
      });
    }

    // Fallback to OneBot HTTP API
    const cfg = this.configStore.get().onebot;
    const base = String(cfg.httpUrl || '').replace(/\/+$/, '');
    if (!base) {
      throw new Error(`OneBot 未连接且未配置 httpUrl，无法执行 ${action}`);
    }
    const headers = { 'Content-Type': 'application/json' };
    if (cfg.accessToken) headers.Authorization = `Bearer ${cfg.accessToken}`;
    const res = await fetch(`${base}/${action}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) {
      throw new Error(`OneBot HTTP ${res.status} on ${action}`);
    }
    const json = await res.json();
    if (json.status === 'failed' || (json.retcode !== undefined && json.retcode !== 0)) {
      const err = new Error(json.wording || json.message || `OneBot HTTP retcode=${json.retcode}`);
      err.retcode = json.retcode;
      throw err;
    }
    return json.data;
  }

  async sendMessage({ messageType, userId, groupId, segments }) {
    if (messageType === 'group') {
      return this.callAction('send_group_msg', {
        group_id: Number(groupId) || groupId,
        message: segments
      });
    }
    return this.callAction('send_private_msg', {
      user_id: Number(userId) || userId,
      message: segments
    });
  }

  async sendText({ messageType, userId, groupId, text, replyToId = null }) {
    const segments = [];
    if (replyToId) {
      segments.push({ type: 'reply', data: { id: String(replyToId) } });
    }
    segments.push({ type: 'text', data: { text: String(text) } });
    return this.sendMessage({ messageType, userId, groupId, segments });
  }

  async sendImageBuffer({ messageType, userId, groupId, buffer }) {
    const b64 = buffer.toString('base64');
    return this.sendMessage({
      messageType,
      userId,
      groupId,
      segments: [{ type: 'image', data: { file: `base64://${b64}` } }]
    });
  }

  async sendVoiceBuffer({ messageType, userId, groupId, buffer }) {
    const b64 = buffer.toString('base64');
    return this.sendMessage({
      messageType,
      userId,
      groupId,
      segments: [{ type: 'record', data: { file: `base64://${b64}` } }]
    });
  }

  async getMessage(messageId) {
    return this.callAction('get_msg', { message_id: Number(messageId) || messageId }, 8000);
  }

  async getForwardMsg(forwardId) {
    const id = String(forwardId || '').trim();
    if (!id) return null;
    return this.callAction('get_forward_msg', { id, message_id: id }, 15000);
  }

  async getImage(file) {
    return this.callAction('get_image', { file }, 8000);
  }

  async fetchCustomFaceDetail(count = 200) {
    try {
      const res = await this.callAction('fetch_custom_face_detail', { count }, 15000);
      if (Array.isArray(res)) return res;
    } catch {
      // Fallback to basic fetch_custom_face if detail API unavailable
    }
    const urls = await this.callAction('fetch_custom_face', { count }, 15000);
    if (!Array.isArray(urls)) return [];
    return urls.map((u, idx) => (typeof u === 'string' ? { emoId: idx, url: u, desc: '' } : u));
  }

  async addCustomFace(filePath) {
    return this.callAction('add_custom_face', { file: filePath, is_origin: true }, 15000);
  }

  async setCustomFaceDesc({ emojiId, resId, md5, desc }) {
    return this.callAction(
      'set_custom_face_desc',
      { emoji_id: Number(emojiId), res_id: String(resId || ''), md5: String(md5 || ''), desc: String(desc || '') },
      10000
    );
  }

  getStatus() {
    const cfg = this.configStore.get().onebot;
    return {
      enabled: cfg.enabled,
      mode: cfg.mode,
      connected: this.connected,
      wsUrl: cfg.mode === 'reverse-ws' ? `ws://${cfg.reverseWsHost}:${cfg.reverseWsPort}${cfg.reverseWsPath}` : cfg.wsUrl,
      selfInfo: this.selfInfo,
      lastEventAt: this.lastEventAt,
      reconnectAttempts: this.reconnectAttempts,
      lastError: this.lastError
    };
  }

  _closeWss() {
    if (this.wss) {
      try {
        this.wss.close();
      } catch {}
      this.wss = null;
    }
  }

  async stop() {
    this.stopped = true;
    this.connected = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.silenceTimer) {
      clearInterval(this.silenceTimer);
      this.silenceTimer = null;
    }
    this._rejectPendingActions(new Error('OneBotClient stopped'));
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
    this._closeWss();
  }
}
