const EMOTIONS = ['平静', '温柔', '开心', '调皮', '委屈', '疑问'];

const state = {
  config: null,
  status: null,
  modelCatalogSig: '',
  ttsAssets: { gptWeights: [], sovitsWeights: [], sampleAudios: [] },
  sse: null,
  token: new URLSearchParams(window.location.search).get('token') || ''
};

const $ = (id) => document.getElementById(id);

function withTokenUrl(url) {
  if (!state.token) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}token=${encodeURIComponent(state.token)}`;
}

function showToast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.add('hidden'), 3200);
}

async function api(url, opts = {}) {
  const authHeaders = state.token ? { Authorization: `Bearer ${state.token}` } : {};
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...authHeaders, ...(opts.headers || {}) },
    ...opts
  });
  if (res.status === 401) {
    $('authOverlay').classList.remove('hidden');
    throw new Error('需要授权令牌');
  }
  const json = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!res.ok || json.ok === false) {
    throw new Error(json.error || `请求失败 (${res.status})`);
  }
  return json.data !== undefined ? json.data : json;
}

function splitList(str) {
  return String(str || '')
    .split(/[\n,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function formatNum(n) {
  const v = Number(n || 0);
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return String(v);
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function setPill(id, text, kind) {
  const el = $(id);
  if (!el) return;
  el.className = `status-pill ${kind || ''}`;
  el.innerHTML = `<i class="dot"></i>${escapeHtml(text)}`;
}

// Navigation
document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    const target = $(`tab-${btn.dataset.tab}`);
    if (target) target.classList.add('active');
    if (btn.dataset.tab === 'stickers') loadStickers();
    if (btn.dataset.tab === 'lorebook') {
      loadLorebook();
      loadMemeWiki();
    }
    if (btn.dataset.tab === 'tokens') refreshStatus();
    if (btn.dataset.tab === 'voice') loadTtsAssets();
  });
});

// Auth submit
$('authSubmitBtn').addEventListener('click', async () => {
  const token = $('authTokenInput').value.trim();
  if (!token) return;
  try {
    const res = await fetch('/api/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token })
    });
    const j = await res.json();
    if (!res.ok || !j.ok) {
      $('authError').textContent = j.error || '令牌无效';
      $('authError').classList.remove('hidden');
      return;
    }
    state.token = token;
    $('authOverlay').classList.add('hidden');
    $('authError').classList.add('hidden');
    await boot();
  } catch (e) {
    $('authError').textContent = e.message;
    $('authError').classList.remove('hidden');
  }
});

function populateModelSelects(cfg, catalog, { preserveCurrent = false, force = false } = {}) {
  const modelOpt = (catalog?.configOptions || []).find((c) => c.id === 'model');
  const options = modelOpt?.options?.length
    ? modelOpt.options
    : [
        { value: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
        { value: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
        { value: 'gemini-4-neon', name: 'Gemini 4 Neon' },
        { value: 'gemini-4-argon', name: 'Gemini 4 Argon' },
        { value: 'gemini-4-hydrogen', name: 'Gemini 4 Hydrogen' },
        { value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
        { value: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' }
      ];

  const sig = options.map((o) => o.value).join('|');
  if (!force && state.modelCatalogSig === sig) {
    return;
  }
  state.modelCatalogSig = sig;

  for (const [selId, configVal] of [
    ['cfgOwnerModel', cfg.acp.ownerModel],
    ['cfgGroupModel', cfg.acp.groupModel]
  ]) {
    const sel = $(selId);
    const chosenVal = preserveCurrent && sel.value ? sel.value : configVal;
    const list = [...options];
    if (chosenVal && !list.some((o) => o.value === chosenVal)) {
      list.unshift({ value: chosenVal, name: `${chosenVal} (当前配置)` });
    }
    sel.innerHTML = list
      .map((o) => `<option value="${escapeHtml(o.value)}">${escapeHtml(o.name)} (${escapeHtml(o.value)})</option>`)
      .join('');
    sel.value = chosenVal || list[0]?.value || '';
  }
}

function renderConfigForm(cfg) {
  populateModelSelects(cfg, state.status?.acp?.catalog, { preserveCurrent: false, force: true });
  $('cfgOwnerThought').value = cfg.acp.ownerThoughtLevel || 'high';
  $('cfgGroupThought').value = cfg.acp.groupThoughtLevel || 'low';
  $('cfgOwnerCwd').value = cfg.acp.ownerWorkspaceDir || '';
  $('cfgProxyUrl').value = cfg.network.proxyUrl || 'auto';

  $('cfgPersonaName').value = cfg.acp.persona?.name || '';
  $('cfgPersonaPrompt').value = cfg.acp.persona?.systemPrompt || '';
  $('cfgSelfTags').value = (cfg.acp.persona?.selfTags || []).join(', ');
  $('cfgSelfAppearance').value = cfg.acp.persona?.selfAppearance || '';
  $('cfgOwnerExtraPrompt').value = cfg.acp.persona?.ownerExtraPrompt || '';
  $('cfgGroupExtraPrompt').value = cfg.acp.persona?.groupExtraPrompt || '';

  $('cfgOnebotMode').value = cfg.onebot.mode || 'forward-ws';
  $('cfgOnebotWsUrl').value = cfg.onebot.wsUrl || '';
  $('cfgOnebotHttpUrl').value = cfg.onebot.httpUrl || '';
  $('cfgOnebotRevPort').value = cfg.onebot.reverseWsPort || 8085;
  $('cfgOnebotToken').value = cfg.onebot.accessToken || '';

  // Guard
  $('cfgOwnerToolsEnabled').checked = Boolean(cfg.guard.ownerToolsEnabled);
  $('cfgAutoApproveOwner').checked = Boolean(cfg.guard.autoApproveOwnerTools);
  $('cfgAllowGroupTools').checked = Boolean(cfg.guard.allowOwnerToolsInGroups);
  $('cfgGroupRequireAt').checked = Boolean(cfg.guard.groupRequireAtOrKeyword);
  $('cfgAllowAllPrivate').checked = Boolean(cfg.guard.allowAllPrivateWhenEmpty);
  $('cfgAllowAllGroups').checked = Boolean(cfg.guard.allowAllGroupsWhenEmpty);
  $('cfgMergeWindow').value = cfg.guard.mergeWindowSec ?? 2.5;
  $('cfgChunkDelay').value = cfg.guard.chunkDelaySec ?? 0.45;
  $('cfgMaxChunkChars').value = cfg.guard.maxChunkChars ?? 140;
  $('cfgRiskBackoff').value = cfg.guard.riskBackoffSec ?? 90;
  $('cfgGroupActiveWindow').value = cfg.guard.groupActiveWindowSec ?? 180;
  $('cfgGroupActiveMaxReplies').value = cfg.guard.groupActiveMaxReplies ?? 6;
  if ($('cfgGroupActiveMaxSilent')) $('cfgGroupActiveMaxSilent').value = cfg.guard.groupActiveMaxConsecutiveSilent ?? 2;
  $('cfgGroupAmbientSize').value = cfg.guard.groupAmbientBufferSize ?? 8;
  $('cfgOwnerUsers').value = (cfg.guard.ownerUsers || []).join(', ');
  $('cfgTriggerKeywords').value = (cfg.guard.triggerKeywords || []).join(', ');
  $('cfgAllowGroups').value = (cfg.guard.allowGroups || []).join(', ');
  $('cfgAllowPrivate').value = (cfg.guard.allowPrivate || []).join(', ');
  if ($('cfgPeerBotUsers')) $('cfgPeerBotUsers').value = (cfg.guard.peerBotUsers || []).join(', ');
  if ($('cfgPeerBotNames')) $('cfgPeerBotNames').value = (cfg.guard.peerBotNames || []).join(', ');

  // TTS
  $('cfgTtsBaseUrl').value = cfg.tts.baseUrl || '';
  $('cfgTtsEnabled').checked = Boolean(cfg.tts.enabled);
  $('cfgTtsPrewarmOnStart').checked = Boolean(cfg.tts.prewarmOnStart);
  $('cfgTtsDualTrack').checked = Boolean(cfg.tts.dualTrack);
  $('cfgTtsSmartVoice').checked = Boolean(cfg.tts.smartVoiceEnabled ?? true);
  $('cfgTtsSmartCooldown').value = cfg.tts.smartVoiceCooldownSec ?? 120;
  $('cfgTtsSmartPrivateChance').value = cfg.tts.smartVoicePrivateChance ?? 0.45;
  $('cfgTtsSmartGroupChance').value = cfg.tts.smartVoiceGroupChance ?? 0.25;
  $('cfgTtsAutoPrivate').checked = Boolean(cfg.tts.autoVoiceInPrivate);
  $('cfgTtsAutoGroup').checked = Boolean(cfg.tts.autoVoiceInGroup);
  $('cfgTtsCache').checked = Boolean(cfg.tts.cacheEnabled);

  const ip = cfg.tts.inferParams || {};
  $('cfgIpTopK').value = ip.top_k ?? 15;
  $('cfgIpTopP').value = ip.top_p ?? 1;
  $('cfgIpTemp').value = ip.temperature ?? 1;
  $('cfgIpSplit').value = ip.text_split_method || 'cut5';
  $('cfgIpBatch').value = ip.batch_size ?? 1;
  $('cfgIpSpeed').value = ip.speed_factor ?? 1;
  $('cfgIpFrag').value = ip.fragment_interval ?? 0.32;
  $('cfgIpSteps').value = ip.sample_steps ?? 32;
  $('cfgIpMediaType').value = ip.media_type || 'wav';
  $('cfgIpCudaGraph').checked = Boolean(ip.use_cuda_graph ?? true);
  $('cfgIpFlashAttn').checked = Boolean(ip.use_flash_attention ?? true);
  $('cfgIpParallel').checked = Boolean(ip.parallel_infer ?? true);
  $('cfgIpStreaming').checked = Boolean(ip.streaming_mode ?? false);

  // Stickers
  $('cfgStickersEnabled').checked = Boolean(cfg.stickers.enabled);
  $('cfgStickerAutoSteal').checked = Boolean(cfg.stickers.autoSteal);
  $('cfgStickerVisionReview').checked = Boolean(cfg.stickers.visionReviewEnabled);
  $('cfgStickerCompareSelf').checked = Boolean(cfg.stickers.compareWithSelfAvatar);
  $('cfgStickerAutoBattle').checked = Boolean(cfg.stickers.autoBattle);
  $('cfgStickerCooldown').value = cfg.stickers.cooldownSec ?? 60;
  $('cfgStickerReviewModel').value = cfg.stickers.reviewModel || 'gemini-3.8-flash';
  $('cfgStickerMinReviewScore').value = cfg.stickers.minReviewScore ?? 7;
  $('cfgStickerReviewCooldown').value = cfg.stickers.reviewCooldownSec ?? 15;
  $('cfgStickerStealRules').value = cfg.stickers.stealRules || '';

  // Lorebook
  const lb = cfg.lorebook || {};
  $('cfgLoreEnabled').checked = Boolean(lb.enabled ?? true);
  $('cfgLoreAutoRecord').checked = Boolean(lb.autoRecord ?? true);
  $('cfgLoreGroupApproval').checked = Boolean(lb.groupRequireApproval ?? false);
  $('cfgLoreMaxEntries').value = lb.maxInjectEntries ?? 4;
  $('cfgLoreMaxChars').value = lb.maxInjectChars ?? 1200;
  $('cfgLoreCooldown').value = lb.sessionCooldownTurns ?? 6;

  // L2 MemeWiki & Troll Level
  const mw = cfg.memewiki || {};
  if ($('cfgMemeWikiEnabled')) $('cfgMemeWikiEnabled').checked = Boolean(mw.enabled ?? true);
  if ($('cfgTrollModeEnabled')) $('cfgTrollModeEnabled').checked = Boolean(mw.trollModeEnabled ?? true);
  if ($('cfgTrollLevel')) {
    $('cfgTrollLevel').value = mw.trollLevel ?? 100;
    updateTrollLevelLabel(mw.trollLevel ?? 100);
  }

  // Context budget
  $('cfgCtxBudget').value = cfg.acp.contextBudgetTokens ?? 256000;
  $('cfgCtxAction').value = cfg.acp.contextOverflowAction || 'compact';
  $('cfgCtxCarryTurns').value = cfg.acp.compactCarryTurns ?? 6;

  renderEmotionCards(cfg);
}

function renderEmotionCards(cfg) {
  const sampleOpts = (state.ttsAssets.sampleAudios || [])
    .map((p) => `<option value="${escapeHtml(p)}">${escapeHtml(p.split(/[\\/]/).slice(-2).join('/'))}</option>`)
    .join('');

  $('emotionGrid').innerHTML = EMOTIONS.map((emo) => {
    const e = cfg.tts.emotions?.[emo] || {};
    return `
      <div class="emotion-card" data-emotion="${escapeHtml(emo)}">
        <div class="emotion-head">
          <span class="emotion-name">🎵 ${escapeHtml(emo)}</span>
          <button class="btn btn-xs btn-primary btn-preview-emo" data-emotion="${escapeHtml(emo)}">▶ 试听</button>
        </div>
        <div class="form-row">
          <label>参考音频路径 (.wav)</label>
          <input type="text" class="emo-ref" value="${escapeHtml(e.refAudioPath || '')}" />
          ${sampleOpts ? `<select class="emo-pick-sample"><option value="">快速选用本机扫描音频...</option>${sampleOpts}</select>` : ''}
        </div>
        <div class="form-row">
          <label>参考音频对应台词 (prompt_text，留空自动)</label>
          <input type="text" class="emo-prompt" value="${escapeHtml(e.promptText || '')}" placeholder="可留空或填参考音频台词" />
        </div>
        <div class="grid-2">
          <div class="form-row">
            <label>参考语种</label>
            <select class="emo-lang">
              <option value="zh" ${e.promptLang === 'zh' ? 'selected' : ''}>中文 (zh)</option>
              <option value="ja" ${e.promptLang === 'ja' ? 'selected' : ''}>日文 (ja)</option>
              <option value="en" ${e.promptLang === 'en' ? 'selected' : ''}>英文 (en)</option>
            </select>
          </div>
          <div class="form-row">
            <label>语速</label>
            <input type="number" class="emo-speed" step="0.02" min="0.5" max="2" value="${e.speedFactor ?? 1.0}" />
          </div>
        </div>
      </div>
    `;
  }).join('');

  document.querySelectorAll('.emo-pick-sample').forEach((sel) => {
    sel.addEventListener('change', () => {
      if (!sel.value) return;
      sel.closest('.emotion-card').querySelector('.emo-ref').value = sel.value;
    });
  });

  document.querySelectorAll('.btn-preview-emo').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const emotion = btn.dataset.emotion;
      btn.disabled = true;
      btn.textContent = '合成中...';
      try {
        // Save voice emotion changes first so preview uses latest inputs
        await saveVoiceConfig(true);
        const text = $('voicePreviewText').value.trim() || '哼，终于来接我走出对话框了呀，主人？';
        const data = await api('/api/tts/preview', {
          method: 'POST',
          body: JSON.stringify({ text, emotion })
        });
        const player = $('voicePlayer');
        player.src = `data:audio/${data.format || 'wav'};base64,${data.audioBase64}`;
        player.play().catch(() => {});
        showToast(
          data.cached
            ? `⚡ [${emotion}] 命中 SHA-256 语音缓存 (0ms 秒回)`
            : `🎙️ [${emotion}] 合成完成 (${data.latencyMs}ms)`
        );
        await refreshStatus();
      } catch (e) {
        showToast(`试听失败: ${e.message}`);
      } finally {
        btn.disabled = false;
        btn.textContent = '▶ 试听';
      }
    });
  });
}

function renderStatus(st) {
  state.status = st;
  // Top pills
  if (st.onebot?.connected) {
    const nick = st.onebot.selfInfo?.nickname || st.onebot.selfInfo?.user_id || '已连通';
    setPill('pillOnebot', `NapCat OneBot: ${nick} (${st.onebot.wsUrl || '13001'})`, 'ok');
  } else {
    setPill('pillOnebot', `NapCat OneBot: ${st.onebot?.enabled ? '等待扫码登录 (13001)' : '已禁用'}`, 'warn');
  }

  if (st.napcat) {
    setPill(
      'pillNapcat',
      st.napcat.webuiOnline ? `NapCat WebUI: 在线 (:${st.napcat.webuiPort})` : 'NapCat WebUI: 未启动',
      st.napcat.webuiOnline ? 'ok' : 'warn'
    );
    const openLink = $('btnOpenNapcatWebui');
    if (openLink && st.napcat.webuiUrl) {
      openLink.href = st.napcat.webuiUrl;
    }
  }

  const ow = st.acp?.ownerWorker;
  setPill(
    'pillOwnerAcp',
    ow?.ready ? `私聊 ACP: 在线 (${ow.lastLatencyMs ?? '-'}ms)` : '私聊 ACP: 未就绪',
    ow?.ready ? 'ok' : 'warn'
  );
  const gw = st.acp?.groupWorker;
  setPill(
    'pillGroupAcp',
    gw?.ready ? `群聊沙盒 ACP: 在线 (${gw.lastLatencyMs ?? '-'}ms)` : '群聊沙盒 ACP: 未就绪',
    gw?.ready ? 'ok' : 'warn'
  );
  const ttsLabel = !st.tts?.online
    ? 'GPT-SoVITS v5: 离线'
    : st.tts.prewarming
      ? 'GPT-SoVITS v5: 预热中...'
      : st.tts.prewarmed
        ? 'GPT-SoVITS v5: 已预热'
        : 'GPT-SoVITS v5: 在线(待预热)';
  setPill('pillSovits', ttsLabel, st.tts?.online ? 'ok' : 'warn');

  $('btnTogglePause').textContent = st.paused ? '恢复响应' : '暂停回复';
  $('sidebarProxy').textContent = `代理: ${st.proxy?.proxyUrl || '直连'}`;
  const tierName = st.acp?.catalog?.tier?.name || ow?.tierInfo?.name || 'Antigravity';
  $('sidebarTier').textContent = `账号: ${tierName}`;

  // Voice KPIs
  const warmState = !st.tts?.online ? '离线' : st.tts.prewarming ? '预热中' : st.tts.prewarmed ? '已预热' : '待预热';
  $('kpiVoiceUrl').textContent = `${st.tts?.baseUrl || '-'} (${warmState})`;
  const lastLat = st.tts?.lastLatencyMs != null ? `${st.tts.lastLatencyMs}ms` : '-';
  const warmLat = st.tts?.prewarmLatencyMs != null ? `预热 ${st.tts.prewarmLatencyMs}ms` : '未预热';
  $('kpiVoiceLat').textContent = `${lastLat} / ${warmLat}`;
  $('kpiVoiceCacheCount').textContent = `${st.tts?.cache?.files || 0} 条 (${st.tts?.cache?.totalMb || 0}MB)`;
  $('kpiVoiceHitRate').textContent = `${st.tts?.cache?.hitRate || 0}%`;

  // Audit table
  const auditBody = $('auditTableBody');
  if (st.auditLog?.length) {
    auditBody.innerHTML = st.auditLog
      .map((a) => `
        <tr>
          <td>${new Date(a.ts).toLocaleTimeString('zh-CN', { hour12: false })}</td>
          <td><span class="tag ${a.action === 'allow' ? 'tag-emerald' : 'tag-rose'}">${a.action === 'allow' ? '放行' : '拦截'}</span></td>
          <td>${escapeHtml(a.lane)}</td>
          <td><code>${escapeHtml(a.toolName)}</code></td>
          <td class="muted">${escapeHtml(a.reason)} ${escapeHtml(a.toolTitle || '')}</td>
        </tr>
      `)
      .join('');
  }

  // Tokens dashboard
  const t = st.tokens?.totals || {};
  $('tokTotal').textContent = formatNum(t.totalTokens);
  $('tokTurns').textContent = `${t.turns || 0} 轮对话`;
  $('tokInOut').textContent = `${formatNum(t.inputTokens)} / ${formatNum(t.outputTokens)}`;
  $('tokCached').textContent = `缓存命中: ${formatNum(t.cachedReadTokens)}`;
  $('tokLatency').textContent = `${t.avgLatencyMs || 0} ms`;
  $('tokThought').textContent = `思考 Tokens: ${formatNum(t.thoughtTokens)}`;
  $('tokSessions').textContent = String(st.sessions?.length || 0);

  // Hourly bars
  const hourly = st.tokens?.hourly || [];
  const chart = $('tokenChart');
  if (!hourly.length) {
    chart.innerHTML = '<div class="muted" style="margin:auto">暂无 Token 流水数据，发送一次测试对话即可点亮图表</div>';
  } else {
    const maxTok = Math.max(...hourly.map((h) => h.totalTokens), 1);
    chart.innerHTML = hourly
      .map((h) => {
        const pct = Math.max(6, Math.round((h.totalTokens / maxTok) * 115));
        const label = h.hour.slice(11, 16);
        return `
          <div class="bar-col" title="${h.hour}: ${h.totalTokens} tokens (${h.turns} 轮)">
            <div class="bar-val">${formatNum(h.totalTokens)}</div>
            <div class="bar-fill" style="height:${pct}px"></div>
            <div class="bar-lbl">${label}</div>
          </div>
        `;
      })
      .join('');
  }

  // Model stats
  $('modelStatsBody').innerHTML = (st.tokens?.byModel || []).length
    ? st.tokens.byModel
        .map(
          (m) => `<tr><td><code>${escapeHtml(m.model)}</code></td><td>${m.turns}</td><td>${formatNum(m.totalTokens)}</td><td>${Math.round(m.avgLatencyMs || 0)}ms</td></tr>`
        )
        .join('')
    : '<tr><td colspan="4" class="muted center">暂无调用记录</td></tr>';

  // Sessions
  const defaultBudget = Number(state.config?.acp?.contextBudgetTokens ?? 256000);
  $('sessionListBody').innerHTML = (st.sessions || []).length
    ? st.sessions
        .map((s) => {
          const used = Number(s.contextUsed || 0);
          const budget = Number(s.contextBudget ?? defaultBudget);
          const pct = budget > 0 ? Math.min(100, Math.round((used / budget) * 100)) : 0;
          const barCls = pct >= 100 ? 'is-full' : pct >= 80 ? 'is-warn' : '';
          const budgetTxt = budget > 0 ? `${formatNum(used)} / ${formatNum(budget)} (${pct}%)` : formatNum(used);
          return `
          <tr>
            <td><code>${escapeHtml(s.sessionKey)}</code><div class="muted" style="font-size:11px">${escapeHtml(s.model || '-')}</div></td>
            <td>${escapeHtml(s.lane)}</td>
            <td>
              <div class="ctx-meter" title="累计压缩 ${s.compactions || 0} 次">
                <div class="ctx-meter-label">${escapeHtml(budgetTxt)}</div>
                <div class="ctx-bar"><div class="ctx-bar-fill ${barCls}" style="width:${pct}%"></div></div>
              </div>
            </td>
            <td>${s.turnCount || 0}</td>
            <td>
              <div class="btn-group">
                <button class="btn btn-xs btn-soft btn-compact-sess" data-key="${escapeHtml(s.sessionKey)}">压缩</button>
                <button class="btn btn-xs btn-danger btn-reset-sess" data-key="${escapeHtml(s.sessionKey)}">重置</button>
              </div>
            </td>
          </tr>`;
        })
        .join('')
    : '<tr><td colspan="5" class="muted center">暂无活跃会话</td></tr>';

  document.querySelectorAll('.btn-compact-sess').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const key = btn.dataset.key;
      btn.disabled = true;
      btn.textContent = '压缩中...';
      try {
        const res = await api('/api/sessions/compact', {
          method: 'POST',
          body: JSON.stringify({ sessionKey: key })
        });
        if (res.compacted) {
          showToast(`✅ 已压缩会话 ${key}：释放 ${formatNum(res.prevContextUsed)} tokens，保留 ${res.summaryChars} 字摘要 + 近 ${res.carriedTurns} 轮`);
        } else {
          showToast(`未执行压缩: ${res.reason || '无活跃会话'}`);
        }
        await refreshStatus();
      } catch (e) {
        showToast(`压缩失败: ${e.message}`);
      } finally {
        btn.disabled = false;
        btn.textContent = '压缩';
      }
    });
  });

  document.querySelectorAll('.btn-reset-sess').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await api('/api/sessions/reset', {
        method: 'POST',
        body: JSON.stringify({ sessionKey: btn.dataset.key })
      });
      showToast(`已重置会话 ${btn.dataset.key}`);
      await refreshStatus();
    });
  });

  // Sticker stats chip
  if (st.stickers) {
    $('stickerStatsChip').textContent = `${st.stickers.count} 张 (已建维度 ${st.stickers.analyzedCount || 0}) · ${st.stickers.totalMb} MB · ${st.stickers.ngramCount} 索引词`;
  }
}

async function refreshStatus() {
  const st = await api('/api/status');
  renderStatus(st);
  if (state.config) {
    populateModelSelects(state.config, st.acp?.catalog, { preserveCurrent: true, force: false });
  }
}

async function loadConfig() {
  state.config = await api('/api/config');
  renderConfigForm(state.config);
}

async function loadTtsAssets() {
  const data = await api('/api/tts/assets');
  state.ttsAssets = data.assets || { gptWeights: [], sovitsWeights: [], sampleAudios: [] };
  const gptSel = $('selGptWeights');
  const sovSel = $('selSovitsWeights');

  gptSel.innerHTML =
    '<option value="">保持当前默认 GPT 权重</option>' +
    state.ttsAssets.gptWeights
      .map((p) => `<option value="${escapeHtml(p)}">${escapeHtml(p.split(/[\\/]/).slice(-2).join('/'))}</option>`)
      .join('');
  sovSel.innerHTML =
    '<option value="">保持当前默认 SoVITS 权重</option>' +
    state.ttsAssets.sovitsWeights
      .map((p) => `<option value="${escapeHtml(p)}">${escapeHtml(p.split(/[\\/]/).slice(-2).join('/'))}</option>`)
      .join('');

  if (state.config?.tts?.activeGptWeights) gptSel.value = state.config.tts.activeGptWeights;
  if (state.config?.tts?.activeSovitsWeights) sovSel.value = state.config.tts.activeSovitsWeights;
  if (state.config) renderEmotionCards(state.config);
}

async function saveVoiceConfig(silent = false) {
  const emotions = {};
  document.querySelectorAll('.emotion-card').forEach((card) => {
    const emo = card.dataset.emotion;
    emotions[emo] = {
      refAudioPath: card.querySelector('.emo-ref').value.trim(),
      promptText: card.querySelector('.emo-prompt').value.trim(),
      promptLang: card.querySelector('.emo-lang').value,
      speedFactor: Number(card.querySelector('.emo-speed').value || 1.0)
    };
  });
  state.config = await api('/api/config', {
    method: 'PATCH',
    body: JSON.stringify({
      tts: {
        baseUrl: $('cfgTtsBaseUrl').value.trim(),
        enabled: $('cfgTtsEnabled').checked,
        prewarmOnStart: $('cfgTtsPrewarmOnStart').checked,
        dualTrack: $('cfgTtsDualTrack').checked,
        smartVoiceEnabled: $('cfgTtsSmartVoice').checked,
        smartVoiceCooldownSec: Number($('cfgTtsSmartCooldown').value ?? 120),
        smartVoicePrivateChance: Number($('cfgTtsSmartPrivateChance').value ?? 0.45),
        smartVoiceGroupChance: Number($('cfgTtsSmartGroupChance').value ?? 0.25),
        autoVoiceInPrivate: $('cfgTtsAutoPrivate').checked,
        autoVoiceInGroup: $('cfgTtsAutoGroup').checked,
        cacheEnabled: $('cfgTtsCache').checked,
        inferParams: {
          top_k: Number($('cfgIpTopK').value || 15),
          top_p: Number($('cfgIpTopP').value || 1),
          temperature: Number($('cfgIpTemp').value || 1),
          text_split_method: $('cfgIpSplit').value.trim() || 'cut5',
          batch_size: Number($('cfgIpBatch').value || 1),
          speed_factor: Number($('cfgIpSpeed').value || 1),
          fragment_interval: Number($('cfgIpFrag').value || 0.32),
          sample_steps: Number($('cfgIpSteps').value || 32),
          media_type: $('cfgIpMediaType').value || 'wav',
          use_cuda_graph: $('cfgIpCudaGraph').checked,
          use_flash_attention: $('cfgIpFlashAttn').checked,
          parallel_infer: $('cfgIpParallel').checked,
          streaming_mode: $('cfgIpStreaming').checked
        },
        emotions
      }
    })
  });
  if (!silent) showToast('声线、v5 推理参数与 6 情感配置已保存');
}

// Auto-save model & thought level immediately when changed so SSE refresh never reverts selection
async function autoSaveModelRouting(label) {
  try {
    state.config = await api('/api/config', {
      method: 'PATCH',
      body: JSON.stringify({
        acp: {
          ownerModel: $('cfgOwnerModel').value,
          ownerThoughtLevel: $('cfgOwnerThought').value,
          groupModel: $('cfgGroupModel').value,
          groupThoughtLevel: $('cfgGroupThought').value
        }
      })
    });
    showToast(`已保存${label}（下一轮对话立即生效）`);
  } catch (e) {
    showToast(`切换失败: ${e.message}`);
  }
}

$('cfgOwnerModel').addEventListener('change', () => autoSaveModelRouting(`私聊模型: ${$('cfgOwnerModel').value}`));
$('cfgOwnerThought').addEventListener('change', () => autoSaveModelRouting(`私聊思考强度: ${$('cfgOwnerThought').value}`));
$('cfgGroupModel').addEventListener('change', () => autoSaveModelRouting(`群聊模型: ${$('cfgGroupModel').value}`));
$('cfgGroupThought').addEventListener('change', () => autoSaveModelRouting(`群聊思考强度: ${$('cfgGroupThought').value}`));

// Save handlers
$('btnSaveModelsPersona').addEventListener('click', async () => {
  try {
    state.config = await api('/api/config', {
      method: 'PATCH',
      body: JSON.stringify({
        network: { proxyUrl: $('cfgProxyUrl').value.trim() || 'auto' },
        onebot: {
          mode: $('cfgOnebotMode').value,
          wsUrl: $('cfgOnebotWsUrl').value.trim(),
          httpUrl: $('cfgOnebotHttpUrl').value.trim(),
          reverseWsPort: Number($('cfgOnebotRevPort').value || 8085),
          accessToken: $('cfgOnebotToken').value
        },
        acp: {
          ownerModel: $('cfgOwnerModel').value,
          ownerThoughtLevel: $('cfgOwnerThought').value,
          groupModel: $('cfgGroupModel').value,
          groupThoughtLevel: $('cfgGroupThought').value,
          ownerWorkspaceDir: $('cfgOwnerCwd').value.trim(),
          persona: {
            name: $('cfgPersonaName').value.trim(),
            systemPrompt: $('cfgPersonaPrompt').value,
            selfTags: splitList($('cfgSelfTags').value),
            selfAppearance: $('cfgSelfAppearance').value.trim(),
            ownerExtraPrompt: $('cfgOwnerExtraPrompt').value,
            groupExtraPrompt: $('cfgGroupExtraPrompt').value
          }
        }
      })
    });
    showToast('模型分流、人设与协议配置已热更新！');
    await refreshStatus();
  } catch (e) {
    showToast(`保存失败: ${e.message}`);
  }
});

$('btnSaveVoice').addEventListener('click', () => saveVoiceConfig(false).catch((e) => showToast(e.message)));

$('btnSwitchWeights').addEventListener('click', async () => {
  const gptWeightsPath = $('selGptWeights').value;
  const sovitsWeightsPath = $('selSovitsWeights').value;
  if (!gptWeightsPath && !sovitsWeightsPath) {
    showToast('请先选择要切换的 GPT 或 SoVITS 权重文件');
    return;
  }
  try {
    await api('/api/tts/switch-weights', {
      method: 'POST',
      body: JSON.stringify({ gptWeightsPath, sovitsWeightsPath })
    });
    showToast('已成功热切换 GPT-SoVITS 音色权重！');
  } catch (e) {
    showToast(`切换失败: ${e.message}`);
  }
});

$('btnStartSovits').addEventListener('click', async () => {
  try {
    const info = await api('/api/tts/start', { method: 'POST', body: '{}' });
    showToast(info.alreadyRunning ? `SoVITS 已在运行 (${info.baseUrl})` : `已拉起本机 SoVITS (PID ${info.pid})，上线后将自动预热`);
  } catch (e) {
    showToast(`启动失败: ${e.message}`);
  }
});

$('btnPrewarmSovits').addEventListener('click', async () => {
  const btn = $('btnPrewarmSovits');
  btn.disabled = true;
  btn.textContent = '预热中...';
  try {
    await saveVoiceConfig(true);
    const res = await api('/api/tts/prewarm', { method: 'POST', body: '{}' });
    if (res.ok) {
      showToast(`🔥 GPT-SoVITS v5 预热完成 (${res.latencyMs}ms)，CUDA Graph 已就绪！`);
    } else {
      showToast(`预热未完成: ${res.reason || '服务离线'}`);
    }
    await refreshStatus();
  } catch (e) {
    showToast(`预热失败: ${e.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = '立即预热 CUDA';
  }
});

$('btnClearVoiceCache').addEventListener('click', async () => {
  const res = await api('/api/tts/cache/clear', { method: 'POST', body: '{}' });
  showToast(`已清空 ${res.removed || 0} 条缓存音频`);
  await refreshStatus();
});

$('btnSaveGuard').addEventListener('click', async () => {
  try {
    state.config = await api('/api/config', {
      method: 'PATCH',
      body: JSON.stringify({
        guard: {
          ownerToolsEnabled: $('cfgOwnerToolsEnabled').checked,
          autoApproveOwnerTools: $('cfgAutoApproveOwner').checked,
          allowOwnerToolsInGroups: $('cfgAllowGroupTools').checked,
          groupRequireAtOrKeyword: $('cfgGroupRequireAt').checked,
          allowAllPrivateWhenEmpty: $('cfgAllowAllPrivate').checked,
          allowAllGroupsWhenEmpty: $('cfgAllowAllGroups').checked,
          mergeWindowSec: Number($('cfgMergeWindow').value),
          chunkDelaySec: Number($('cfgChunkDelay').value),
          maxChunkChars: Number($('cfgMaxChunkChars').value),
          riskBackoffSec: Number($('cfgRiskBackoff').value),
          groupActiveWindowSec: Number($('cfgGroupActiveWindow').value ?? 180),
          groupActiveMaxReplies: Number($('cfgGroupActiveMaxReplies').value ?? 6),
          groupActiveMaxConsecutiveSilent: Number($('cfgGroupActiveMaxSilent')?.value ?? 2),
          groupAmbientBufferSize: Number($('cfgGroupAmbientSize').value ?? 8),
          ownerUsers: splitList($('cfgOwnerUsers').value),
          triggerKeywords: splitList($('cfgTriggerKeywords').value),
          allowGroups: splitList($('cfgAllowGroups').value),
          allowPrivate: splitList($('cfgAllowPrivate').value),
          peerBotUsers: splitList($('cfgPeerBotUsers')?.value || ''),
          peerBotNames: splitList($('cfgPeerBotNames')?.value || '')
        }
      })
    });
    showToast('权限隔离与防风控参数已保存！');
    await refreshStatus();
  } catch (e) {
    showToast(`保存失败: ${e.message}`);
  }
});

// Engine control buttons
$('btnStartNapcat').addEventListener('click', async () => {
  try {
    const info = await api('/api/napcat/start', { method: 'POST', body: '{}' });
    showToast(info.alreadyRunning ? '项目内置 NapCatQQ 已在运行，请点击「打开扫码登录」' : `已启动 NapCatQQ (PID ${info.pid})，稍候几秒后可点「打开扫码登录」`);
    setTimeout(() => refreshStatus().catch(() => {}), 2500);
  } catch (e) {
    showToast(`启动 NapCatQQ 失败: ${e.message}`);
  }
});

$('btnSwitchNapcat')?.addEventListener('click', async () => {
  if (!confirm('确认重启 NapCatQQ 并切回二维码登录页以切换 QQ 账号吗？当前已登录的机器人 QQ 会先下线。')) {
    return;
  }
  const btn = $('btnSwitchNapcat');
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = '正在重启切号...';
  try {
    const info = await api('/api/napcat/restart', {
      method: 'POST',
      body: JSON.stringify({ skipQuickLogin: true })
    });
    showToast(
      info.webuiOnline
        ? 'NapCatQQ 已切回扫码界面，点击「打开扫码登录」重新扫码即可！'
        : 'NapCatQQ 正在重启，请等待 2~3 秒后点击「打开扫码登录」'
    );
    await refreshStatus().catch(() => {});
  } catch (e) {
    showToast(`切换 QQ 账号失败: ${e.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
});

$('btnTogglePause').addEventListener('click', async () => {
  const action = state.status?.paused ? 'resume' : 'pause';
  const st = await api('/api/engine/control', { method: 'POST', body: JSON.stringify({ action }) });
  renderStatus(st);
  showToast(action === 'pause' ? '已暂停自动回复' : '已恢复自动回复');
});

$('btnReconnectOnebot').addEventListener('click', async () => {
  const st = await api('/api/engine/control', { method: 'POST', body: JSON.stringify({ action: 'reconnect-onebot' }) });
  renderStatus(st);
  showToast('已触发 OneBot 协议端重连');
});

$('btnRefreshAll').addEventListener('click', () => refreshStatus().then(() => showToast('状态已刷新')));
$('btnRefreshTokens').addEventListener('click', () => refreshStatus());
$('btnSaveContextBudget').addEventListener('click', async () => {
  try {
    state.config = await api('/api/config', {
      method: 'PATCH',
      body: JSON.stringify({
        acp: {
          contextBudgetTokens: Number($('cfgCtxBudget').value || 0),
          contextOverflowAction: $('cfgCtxAction').value,
          compactCarryTurns: Number($('cfgCtxCarryTurns').value ?? 6)
        }
      })
    });
    showToast('上下文预算与压缩策略已保存并生效！');
    await refreshStatus();
  } catch (e) {
    showToast(`保存失败: ${e.message}`);
  }
});
$('btnRefreshModels').addEventListener('click', async () => {
  showToast('正在向 agy acp 拉取最新可用模型...');
  try {
    await api('/api/engine/control', { method: 'POST', body: JSON.stringify({ action: 'refresh-models' }) });
    await refreshStatus();
    showToast('已同步最新可用模型列表');
  } catch (e) {
    showToast(`同步失败: ${e.message}`);
  }
});

// Stickers
async function loadStickers(query = '') {
  const data = await api(`/api/stickers?q=${encodeURIComponent(query)}`);
  if (data.stats) {
    $('stickerStatsChip').textContent = `${data.stats.count} 张 (已建维度 ${data.stats.analyzedCount || 0}) · ${data.stats.totalMb} MB · ${data.stats.ngramCount} 索引词`;
  }

  const rejBody = $('rejectionTableBody');
  if (rejBody) {
    rejBody.innerHTML = data.rejections?.length
      ? data.rejections
          .map(
            (r) => `<tr>
              <td>${new Date(r.created_at).toLocaleTimeString('zh-CN', { hour12: false })}</td>
              <td><code>${escapeHtml(String(r.sha256 || '').slice(0, 10))}</code></td>
              <td><span class="tag tag-rose">${r.score}/10</span></td>
              <td class="muted">${escapeHtml(r.reason)}</td>
            </tr>`
          )
          .join('')
      : '<tr><td colspan="4" class="muted center">暂无跳过记录</td></tr>';
  }

  const grid = $('stickerGrid');
  if (!data.items?.length) {
    grid.innerHTML = '<div class="card glass muted center" style="grid-column:1/-1">仓库里还没有匹配的表情包，快在上方上传一张或在 QQ 里发送 /存表情 吧~</div>';
    return;
  }
  grid.innerHTML = data.items
    .map(
      (s) => `
      <div class="sticker-card">
        <img class="sticker-thumb" src="${escapeHtml(withTokenUrl(`/api/stickers/${s.id}/file`))}" alt="${escapeHtml(s.tags)}" loading="lazy" />
        <div class="sticker-meta">
          <span>#${s.id} · 用过 ${s.use_count} 次</span>
          <span>${s.review_score != null ? `★ ${s.review_score}/10` : s.score ? `匹配分 ${s.score}` : escapeHtml(s.source)}</span>
        </div>
        <div class="pill-row">
          ${s.is_self ? '<span class="tag tag-violet">✨ 本喵自设</span>' : ''}
          ${s.category ? `<span class="tag tag-emerald">${escapeHtml(s.category)}</span>` : ''}
        </div>
        ${s.caption_ocr ? `<div class="sticker-reason"><strong>图字：</strong>「${escapeHtml(s.caption_ocr)}」</div>` : ''}
        ${s.vibe ? `<div class="sticker-reason"><strong>笑点：</strong>${escapeHtml(s.vibe)}</div>` : ''}
        ${s.use_when ? `<div class="sticker-reason"><strong>适用：</strong>${escapeHtml(s.use_when)}</div>` : ''}
        ${!s.use_when && s.review_reason ? `<div class="sticker-reason">${escapeHtml(s.review_reason)}</div>` : ''}
        <input type="text" class="stk-tags-input" value="${escapeHtml(s.tags)}" data-id="${s.id}" />
        <div class="btn-group">
          <button class="btn btn-xs btn-soft btn-stk-save" data-id="${s.id}">改标签</button>
          <button class="btn btn-xs btn-danger btn-stk-del" data-id="${s.id}">删除</button>
        </div>
      </div>`
    )
    .join('');

  grid.querySelectorAll('.btn-stk-save').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const tags = btn.closest('.sticker-card').querySelector('.stk-tags-input').value;
      await api(`/api/stickers/${id}`, { method: 'PATCH', body: JSON.stringify({ tags }) });
      showToast(`已更新表情 #${id} 标签并重建 2-gram 索引`);
    });
  });

  grid.querySelectorAll('.btn-stk-del').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await api(`/api/stickers/${btn.dataset.id}`, { method: 'DELETE' });
      showToast(`已删除表情 #${btn.dataset.id}`);
      loadStickers($('stickerSearchInput').value.trim());
    });
  });
}

$('btnBatchAnalyzeStickers').addEventListener('click', async () => {
  const btn = $('btnBatchAnalyzeStickers');
  btn.disabled = true;
  btn.textContent = '启动建卡中...';
  try {
    const r = await api('/api/stickers/batch-analyze', { method: 'POST', body: JSON.stringify({ concurrency: 3 }) });
    showToast(r.alreadyRunning ? `正在批量识图建卡 (${r.done}/${r.total})...` : `已启动后台批量识图建卡，共 ${r.total || 0} 张待补全`);
    const timer = setInterval(async () => {
      try {
        const st = await api('/api/stickers/batch-status');
        if (st.running) {
          btn.textContent = `建卡中 ${st.done}/${st.total}`;
        } else {
          clearInterval(timer);
          btn.disabled = false;
          btn.textContent = 'AI 补全维度卡片';
          showToast(`✅ 维度建卡完成：成功 ${st.succeeded}/${st.total}`);
          loadStickers($('stickerSearchInput').value.trim());
          refreshStatus();
        }
      } catch {
        clearInterval(timer);
        btn.disabled = false;
        btn.textContent = 'AI 补全维度卡片';
      }
    }, 3000);
  } catch (e) {
    showToast(`启动建卡失败: ${e.message}`);
    btn.disabled = false;
    btn.textContent = 'AI 补全维度卡片';
  }
});

$('btnSyncQqStickers').addEventListener('click', async () => {
  const btn = $('btnSyncQqStickers');
  btn.disabled = true;
  btn.textContent = '同步中...';
  try {
    const r = await api('/api/stickers/sync-qq', { method: 'POST', body: '{}' });
    showToast(`✅ 已同步星喵 QQ 收藏表情：共 ${r.total} 张（新增 ${r.imported}，已有 ${r.updated}）`);
    await loadStickers();
    await refreshStatus();
  } catch (e) {
    showToast(`同步失败: ${e.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = '同步 QQ 收藏表情';
  }
});

$('btnSaveStickerCfg').addEventListener('click', async () => {
  state.config = await api('/api/config', {
    method: 'PATCH',
    body: JSON.stringify({
      stickers: {
        enabled: $('cfgStickersEnabled').checked,
        autoSteal: $('cfgStickerAutoSteal').checked,
        visionReviewEnabled: $('cfgStickerVisionReview').checked,
        compareWithSelfAvatar: $('cfgStickerCompareSelf').checked,
        autoBattle: $('cfgStickerAutoBattle').checked,
        cooldownSec: Number($('cfgStickerCooldown').value || 60),
        reviewModel: $('cfgStickerReviewModel').value.trim() || 'gemini-3.8-flash',
        minReviewScore: Number($('cfgStickerMinReviewScore').value || 7),
        reviewCooldownSec: Number($('cfgStickerReviewCooldown').value || 15),
        stealRules: $('cfgStickerStealRules').value
      }
    })
  });
  showToast('斗图与 Gemini 视觉鉴图规则已保存！');
});

$('btnClearRejections').addEventListener('click', async () => {
  await api('/api/stickers/rejections/clear', { method: 'POST', body: '{}' });
  showToast('已清空 Gemini 鉴图跳过缓存');
  loadStickers($('stickerSearchInput').value.trim());
});

$('btnStickerCurate').addEventListener('click', async () => {
  const file = $('stickerUploadFile').files[0];
  if (!file) return showToast('请先选择一张图片让 Gemini 鉴图试评');
  const btn = $('btnStickerCurate');
  const box = $('curateResultBox');
  btn.disabled = true;
  btn.textContent = '鉴图中...';
  box.classList.remove('hidden');
  box.innerHTML = '<div class="muted">Gemini 正在对照审美规则与本喵自设参考图打分...</div>';
  try {
    const imageBase64 = await readFileAsBase64(file);
    const contextText = $('stickerUploadTags').value.trim();
    const r = await api('/api/stickers/curate', {
      method: 'POST',
      body: JSON.stringify({ imageBase64, contextText, autoSave: true })
    });
    box.innerHTML = `
      <div class="pill-row">
        <span class="tag ${r.approved ? 'tag-emerald' : 'tag-rose'}">${r.approved ? '✅ 通过审核并已入库' : '❌ 未达标准已跳过'}</span>
        <span class="tag tag-amber">评分: ${r.score}/10 (门槛 ${r.minScore})</span>
        ${r.isSelf ? '<span class="tag tag-violet">✨ 认出是本喵自设</span>' : ''}
        <span class="muted">耗时 ${r.latencyMs || 0}ms</span>
      </div>
      <div><strong>Gemini 评语：</strong>${escapeHtml(r.reason || '-')}</div>
      <div><strong>自动生成标签：</strong>${(r.tags || []).map((t) => `<code>${escapeHtml(t)}</code>`).join(' ') || '-'}</div>
    `;
    await loadStickers();
    await refreshStatus();
  } catch (e) {
    box.innerHTML = `<div class="error-text">鉴图失败: ${escapeHtml(e.message)}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Gemini 鉴图试评';
  }
});

$('btnStickerSearch').addEventListener('click', () => loadStickers($('stickerSearchInput').value.trim()));
$('stickerSearchInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') loadStickers($('stickerSearchInput').value.trim());
});

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ''));
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
}

$('btnStickerUpload').addEventListener('click', async () => {
  const file = $('stickerUploadFile').files[0];
  if (!file) return showToast('请先选择一张表情图片');
  try {
    const imageBase64 = await readFileAsBase64(file);
    const tags = $('stickerUploadTags').value.trim() || file.name.replace(/\.[^.]+$/, '');
    const res = await api('/api/stickers', {
      method: 'POST',
      body: JSON.stringify({ imageBase64, tags })
    });
    showToast(res.deduplicated ? `SHA-256 命中已存图片 (#${res.sticker.id})，已合并标签` : `入库成功 (#${res.sticker.id})，已建立 2-gram 索引`);
    $('stickerUploadFile').value = '';
    loadStickers();
  } catch (e) {
    showToast(`上传失败: ${e.message}`);
  }
});

// ================= Living Lorebook (Worldbook) =================
let lorebookItemsCache = [];

function resetLoreForm() {
  $('loreEditId').value = '';
  $('loreFormTitle').textContent = '新增世界书词条';
  $('btnLoreSubmit').textContent = '添加到世界书';
  $('btnLoreResetForm').classList.add('hidden');
  $('loreInputTitle').value = '';
  $('loreInputCategory').value = '网络热梗';
  $('loreInputScope').value = 'global';
  $('loreInputConstant').value = '0';
  $('loreInputPriority').value = '100';
  $('loreInputKeys').value = '';
  $('loreInputSecKeys').value = '';
  $('loreInputLogic').value = 'AND_ANY';
  $('loreInputContent').value = '';
}

async function loadLorebook() {
  const q = $('loreSearchInput')?.value?.trim() || '';
  const category = $('loreFilterCategory')?.value || 'all';
  const scope = $('loreFilterScope')?.value || 'all';
  const status = $('loreFilterStatus')?.value || 'all';
  const qs = new URLSearchParams({ q, category, scope, status });
  const data = await api(`/api/lorebook?${qs.toString()}`);
  const stats = data.stats || {};
  lorebookItemsCache = data.items || [];

  $('loreStatsChip').textContent = `${stats.enabled || 0}/${stats.total || 0} 条生效 · 🔵${stats.constant || 0} 常驻 · 🟢${stats.keywordCount || 0} 关键词${stats.pending ? ` · ⏳${stats.pending} 待审` : ''} · 命中 ${stats.totalHits || 0} 次`;

  // Sync dynamic scope filter options while keeping current selection
  const scopeSel = $('loreFilterScope');
  if (scopeSel) {
    const curVal = scopeSel.value || 'all';
    const scopeOpts = new Map([
      ['all', '全部作用域'],
      ['global', 'global (全域公共)']
    ]);
    for (const s of stats.scopes || []) {
      if (s.scope && !scopeOpts.has(s.scope)) {
        scopeOpts.set(s.scope, `${s.scope} (${s.c})`);
      }
    }
    scopeSel.innerHTML = [...scopeOpts.entries()]
      .map(([v, label]) => `<option value="${escapeHtml(v)}">${escapeHtml(label)}</option>`)
      .join('');
    scopeSel.value = scopeOpts.has(curVal) ? curVal : 'all';
  }

  const box = $('loreListContainer');
  if (!lorebookItemsCache.length) {
    box.innerHTML = '<div class="muted center" style="padding:20px">暂无匹配的世界书词条。在左侧手动添加，或导入 SillyTavern JSON，或直接聊天让星喵查梗自动记录~</div>';
    return;
  }

  box.innerHTML = lorebookItemsCache
    .map((e) => {
      const lampBadge = !e.enabled
        ? '<span class="tag tag-rose">⏸ 停用</span>'
        : !e.approved
          ? '<span class="tag tag-amber">⏳ 待审</span>'
          : e.constant
            ? '<span class="tag tag-violet">🔵 蓝灯常驻</span>'
            : '<span class="tag tag-emerald">🟢 绿灯关键词</span>';

      const keysHtml = e.keys.length
        ? e.keys.map((k) => `<span class="lore-key-pill">${escapeHtml(k)}</span>`).join('')
        : '<span class="muted">(常驻无需关键词)</span>';

      const secHtml = e.secondaryKeys?.length
        ? `<span class="muted">次级过滤(${escapeHtml(e.selectiveLogic)}): ${e.secondaryKeys.map((k) => `<code>${escapeHtml(k)}</code>`).join(' ')}</span>`
        : '';

      return `
        <div class="lore-card ${!e.enabled ? 'is-disabled' : ''} ${!e.approved ? 'is-pending' : ''}" data-id="${e.id}">
          <div class="lore-head">
            <div class="lore-title-row">
              <strong>#${e.id} ${escapeHtml(e.title)}</strong>
              ${lampBadge}
              <span class="tag tag-amber">${escapeHtml(e.category)}</span>
              <span class="tag tag-violet">${escapeHtml(e.scope)}</span>
              <span class="muted">优先级 ${e.priority}</span>
            </div>
            <div class="btn-group">
              ${!e.approved ? `<button class="btn btn-xs btn-primary btn-lore-approve" data-id="${e.id}">通过审核</button>` : ''}
              <button class="btn btn-xs btn-soft btn-lore-lamp" data-id="${e.id}">${e.constant ? '切为绿灯' : '切为蓝灯'}</button>
              <button class="btn btn-xs btn-soft btn-lore-toggle" data-id="${e.id}">${e.enabled ? '停用' : '启用'}</button>
              <button class="btn btn-xs btn-soft btn-lore-edit" data-id="${e.id}">编辑</button>
              <button class="btn btn-xs btn-danger btn-lore-del" data-id="${e.id}">删除</button>
            </div>
          </div>
          <div class="lore-keys">${keysHtml} ${secHtml}</div>
          <div class="lore-content">${escapeHtml(e.content)}</div>
          <div class="lore-meta">
            <span>来源: ${escapeHtml(e.source)}${e.createdBy ? ` (${escapeHtml(e.createdBy)})` : ''}</span>
            <span>累计命中: ${e.hitCount || 0} 次</span>
            <span>更新: ${new Date(e.updatedAt).toLocaleString('zh-CN', { hour12: false })}</span>
          </div>
        </div>
      `;
    })
    .join('');

  box.querySelectorAll('.btn-lore-approve').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await api(`/api/lorebook/${btn.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ approved: true, enabled: true }) });
      showToast(`已审核通过词条 #${btn.dataset.id}`);
      loadLorebook();
    });
  });

  box.querySelectorAll('.btn-lore-lamp').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const item = lorebookItemsCache.find((x) => String(x.id) === btn.dataset.id);
      if (!item) return;
      if (item.constant && !item.keys.length) {
        return showToast('切回绿灯前请先点「编辑」补充至少一个触发关键词');
      }
      await api(`/api/lorebook/${item.id}`, { method: 'PATCH', body: JSON.stringify({ constant: !item.constant }) });
      showToast(`已将 #${item.id} 切换为 ${!item.constant ? '🔵蓝灯常驻' : '🟢绿灯关键词'}`);
      loadLorebook();
    });
  });

  box.querySelectorAll('.btn-lore-toggle').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const item = lorebookItemsCache.find((x) => String(x.id) === btn.dataset.id);
      if (!item) return;
      await api(`/api/lorebook/${item.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !item.enabled }) });
      showToast(`已${!item.enabled ? '启用' : '停用'}词条 #${item.id}`);
      loadLorebook();
    });
  });

  box.querySelectorAll('.btn-lore-edit').forEach((btn) => {
    btn.addEventListener('click', () => {
      const item = lorebookItemsCache.find((x) => String(x.id) === btn.dataset.id);
      if (!item) return;
      $('loreEditId').value = String(item.id);
      $('loreFormTitle').textContent = `编辑词条 #${item.id}`;
      $('btnLoreSubmit').textContent = `保存词条 #${item.id}`;
      $('btnLoreResetForm').classList.remove('hidden');
      $('loreInputTitle').value = item.title || '';
      $('loreInputCategory').value = item.category || '网络热梗';
      $('loreInputScope').value = item.scope || 'global';
      $('loreInputConstant').value = item.constant ? '1' : '0';
      $('loreInputPriority').value = String(item.priority ?? 100);
      $('loreInputKeys').value = (item.keys || []).join(', ');
      $('loreInputSecKeys').value = (item.secondaryKeys || []).join(', ');
      $('loreInputLogic').value = item.selectiveLogic || 'AND_ANY';
      $('loreInputContent').value = item.content || '';
      $('loreInputTitle').scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  });

  box.querySelectorAll('.btn-lore-del').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await api(`/api/lorebook/${btn.dataset.id}`, { method: 'DELETE' });
      showToast(`已删除世界书词条 #${btn.dataset.id}`);
      if ($('loreEditId').value === btn.dataset.id) resetLoreForm();
      loadLorebook();
    });
  });
}

$('btnLoreResetForm').addEventListener('click', resetLoreForm);

$('btnLoreSubmit').addEventListener('click', async () => {
  const editId = $('loreEditId').value.trim();
  const payload = {
    title: $('loreInputTitle').value.trim(),
    category: $('loreInputCategory').value,
    scope: $('loreInputScope').value.trim() || 'global',
    constant: $('loreInputConstant').value === '1',
    priority: Number($('loreInputPriority').value || 100),
    keys: $('loreInputKeys').value,
    secondaryKeys: $('loreInputSecKeys').value,
    selectiveLogic: $('loreInputLogic').value,
    content: $('loreInputContent').value.trim()
  };
  try {
    if (editId) {
      await api(`/api/lorebook/${editId}`, { method: 'PATCH', body: JSON.stringify(payload) });
      showToast(`已更新世界书词条 #${editId}`);
    } else {
      const created = await api('/api/lorebook', { method: 'POST', body: JSON.stringify(payload) });
      showToast(`已新增世界书词条 #${created.id}`);
    }
    resetLoreForm();
    loadLorebook();
  } catch (e) {
    showToast(`保存词条失败: ${e.message}`);
  }
});

$('btnLoreTestMatch').addEventListener('click', async () => {
  const box = $('loreTestResult');
  box.classList.remove('hidden');
  try {
    const r = await api('/api/lorebook/test-match', {
      method: 'POST',
      body: JSON.stringify({
        text: $('loreTestText').value,
        scope: $('loreTestScope').value.trim() || 'global'
      })
    });
    if (!r.entries?.length && !r.memewikiEntries?.length) {
      box.innerHTML = '<div class="muted">L1 世界书与 L2 梗百科均未命中 → 星喵遇到不懂的新梗时将自动调用 L3 联网搜索并沉淀入 L1 世界书。</div>';
    } else {
      const l1Tags = (r.entries || [])
        .map((e) => `<span class="tag tag-emerald">L1 #${e.id} ${escapeHtml(e.title)} (${e.constant ? '🔵常驻' : escapeHtml((e.matchedKeys || []).join(','))})</span>`)
        .join(' ');
      const l2Tags = (r.memewikiEntries || [])
        .map((e) => `<span class="tag tag-violet">L2 梗百科「${escapeHtml(e.title)}」(${escapeHtml(e.matchReason || '命中')})</span>`)
        .join(' ');
      box.innerHTML = `
        <div class="pill-row">${l1Tags} ${l2Tags}</div>
        <pre style="margin:0;white-space:pre-wrap;font-size:12px;background:#fff;padding:10px;border-radius:10px;border:1px solid rgba(109,93,252,0.16)">${escapeHtml(r.promptBlock || '')}</pre>
      `;
    }
  } catch (e) {
    box.innerHTML = `<div class="error-text">测试失败: ${escapeHtml(e.message)}</div>`;
  }
});

$('btnSaveLoreCfg').addEventListener('click', async () => {
  state.config = await api('/api/config', {
    method: 'PATCH',
    body: JSON.stringify({
      lorebook: {
        enabled: $('cfgLoreEnabled').checked,
        autoRecord: $('cfgLoreAutoRecord').checked,
        groupRequireApproval: $('cfgLoreGroupApproval').checked,
        maxInjectEntries: Number($('cfgLoreMaxEntries').value || 4),
        maxInjectChars: Number($('cfgLoreMaxChars').value || 1200),
        sessionCooldownTurns: Number($('cfgLoreCooldown').value || 6)
      }
    })
  });
  showToast('世界书配置已保存并生效！');
});

$('btnLoreExportSt').addEventListener('click', () => {
  const scope = $('loreFilterScope')?.value;
  const qs = scope && scope !== 'all' ? `?scope=${encodeURIComponent(scope)}` : '';
  window.open(withTokenUrl(`/api/lorebook/export/st${qs}`), '_blank');
});

$('btnLoreImportSt').addEventListener('click', () => $('loreImportFile').click());
$('loreImportFile').addEventListener('change', async (ev) => {
  const file = ev.target.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const json = JSON.parse(text);
    const defaultScope = $('loreInputScope').value.trim() || 'global';
    const r = await api('/api/lorebook/import/st', {
      method: 'POST',
      body: JSON.stringify({ json, defaultScope })
    });
    showToast(`✅ SillyTavern 世界书导入完成：新增 ${r.imported}，合并 ${r.merged}，跳过 ${r.skipped}`);
    loadLorebook();
  } catch (e) {
    showToast(`导入失败: ${e.message}`);
  } finally {
    ev.target.value = '';
  }
});

$('btnLoreSearch').addEventListener('click', () => loadLorebook());
$('btnLoreRefresh').addEventListener('click', () => loadLorebook());
$('loreSearchInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') loadLorebook();
});
$('loreFilterCategory').addEventListener('change', () => loadLorebook());
$('loreFilterScope').addEventListener('change', () => loadLorebook());
$('loreFilterStatus').addEventListener('change', () => loadLorebook());

// L2 Public MemeWiki & Troll Level Controls
function updateTrollLevelLabel(rawVal) {
  const el = $('trollLevelLabel');
  if (!el) return;
  const v = Math.max(0, Math.min(100, Math.round(Number(rawVal ?? 100))));
  const tier = v <= 20 ? '礼貌温和' : v <= 45 ? '轻度调侃' : v <= 70 ? '社区常态' : '放开开串';
  el.textContent = `${v}/100（${tier}）`;
}

$('cfgTrollLevel')?.addEventListener('input', (e) => {
  updateTrollLevelLabel(e.target.value);
});

let memeSyncPollTimer = null;
function renderMemeSyncState(stats) {
  const box = $('memeSyncStatus');
  const btn = $('btnMemeSync');
  if (!box || !stats) return;
  const s = stats.sync || {};
  if (s.status === 'running') {
    box.classList.remove('hidden');
    const lastLine = (s.logs || []).slice(-1)[0] || '正在扫描 cnmeme.wiki 公开词库...';
    box.textContent = `⏳ 正在后台同步梗百科：${lastLine}`;
    if (btn) {
      btn.disabled = true;
      btn.textContent = '同步中...';
    }
    if (!memeSyncPollTimer) {
      memeSyncPollTimer = setInterval(async () => {
        try {
          const st = await api('/api/memewiki/sync');
          renderMemeSyncState(st);
          if (st.sync?.status !== 'running') {
            clearInterval(memeSyncPollTimer);
            memeSyncPollTimer = null;
            loadMemeWiki();
          }
        } catch {
          clearInterval(memeSyncPollTimer);
          memeSyncPollTimer = null;
        }
      }, 2500);
    }
  } else {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '🔄 增量更新词库 (0 Token)';
    }
    if (s.status === 'done') {
      box.classList.remove('hidden');
      box.textContent = `✅ 上次同步完成：新增 ${s.added} 条、更新 ${s.updated} 条，当前共 ${stats.count} 条`;
    } else if (s.status === 'error') {
      box.classList.remove('hidden');
      box.textContent = `⚠️ 同步失败：${s.error || '未知错误'}`;
    } else {
      box.classList.add('hidden');
    }
  }
}

async function loadMemeWiki() {
  const container = $('memeListContainer');
  if (!container) return;
  try {
    const q = ($('memeSearchInput')?.value || '').trim();
    const qs = new URLSearchParams({ q, limit: '15', offset: '0' });
    const data = await api(`/api/memewiki?${qs.toString()}`);
    const stats = data.stats || {};
    const chip = $('memeStatsChip');
    if (chip) {
      chip.textContent = stats.available
        ? `已收录 ${stats.count} 条${stats.builtAt ? ` · 构建 ${stats.builtAt.slice(0, 10)}` : ''}`
        : '未检测到 data/memes.db';
    }
    renderMemeSyncState(stats);
    const items = data.items || [];
    if (!items.length) {
      container.innerHTML = `<div class="muted">${stats.available ? '未搜索到匹配的梗百科词条。' : 'data/memes.db 暂未就绪。'}</div>`;
      return;
    }
    container.innerHTML = items
      .map((item) => {
        const usage = String(item.usage || '').replace(/\s+/g, ' ').trim();
        const origin = String(item.summary || item.origin || '').replace(/\s+/g, ' ').trim();
        const preview = usage ? `怎么接：${usage.slice(0, 150)}${usage.length > 150 ? '…' : ''}` : origin.slice(0, 150);
        return `
          <div class="lore-item">
            <div class="lore-item-head">
              <div class="lore-item-title">
                <span class="tag tag-violet">L2 梗百科</span>
                <strong>${escapeHtml(item.title)}</strong>
                ${item.aliases ? `<span class="muted">别名: ${escapeHtml(item.aliases)}</span>` : ''}
                ${item.tags ? `<span class="muted">${escapeHtml(String(item.tags).slice(0, 40))}</span>` : ''}
              </div>
              <div class="btn-group">
                <button class="btn btn-xs btn-soft" data-meme-promote="${escapeHtml(item.title)}">⬆️ 复制进 L1 魔改</button>
              </div>
            </div>
            <div class="lore-item-body">${escapeHtml(preview)}</div>
          </div>
        `;
      })
      .join('');
    container.querySelectorAll('[data-meme-promote]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const title = btn.dataset.memePromote;
        btn.disabled = true;
        try {
          const created = await api('/api/memewiki/promote', {
            method: 'POST',
            body: JSON.stringify({ title, scope: 'global' })
          });
          showToast(`已将「${title}」复制到 L1 世界书 #${created.id}，现在可以自由魔改覆盖公版！`);
          loadLorebook();
        } catch (e) {
          showToast(`复制失败: ${e.message}`);
        } finally {
          btn.disabled = false;
        }
      });
    });
  } catch (e) {
    container.innerHTML = `<div class="error-text">加载梗百科失败: ${escapeHtml(e.message)}</div>`;
  }
}

$('btnMemeSearch')?.addEventListener('click', () => loadMemeWiki());
$('memeSearchInput')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') loadMemeWiki();
});
$('btnSaveMemeCfg')?.addEventListener('click', async () => {
  const trollLevel = Number($('cfgTrollLevel')?.value ?? 100);
  state.config = await api('/api/config', {
    method: 'PATCH',
    body: JSON.stringify({
      memewiki: {
        enabled: $('cfgMemeWikiEnabled').checked,
        trollModeEnabled: $('cfgTrollModeEnabled').checked,
        trollLevel
      }
    })
  });
  showToast(`已保存梗百科配置（串子程度 ${$('cfgTrollModeEnabled').checked ? `${trollLevel}/100` : '交由模型自决'}），下一轮即时生效！`);
});
$('btnMemeSync')?.addEventListener('click', async () => {
  try {
    await api('/api/memewiki/sync', { method: 'POST', body: JSON.stringify({ mode: 'no-existing' }) });
    showToast('已启动后台增量更新（约 4~5 分钟，纯脚本 0 Token）');
    const st = await api('/api/memewiki/sync');
    renderMemeSyncState(st);
  } catch (e) {
    showToast(`启动同步失败: ${e.message}`);
  }
});

// Playground Simulator
$('btnRunSim').addEventListener('click', async () => {
  const btn = $('btnRunSim');
  const box = $('simResultBox');
  btn.disabled = true;
  btn.textContent = '推理中...';
  box.classList.remove('hidden');
  box.innerHTML = '<div class="muted">正在走真实 agy acp --stdio 通道，请稍候...</div>';
  try {
    let imageBase64 = '';
    const imgFile = $('simImageFile').files[0];
    if (imgFile) imageBase64 = await readFileAsBase64(imgFile);

    const res = await api('/api/simulate', {
      method: 'POST',
      body: JSON.stringify({
        scene: $('simScene').value,
        text: $('simTextInput').value.trim() || '你好呀，介绍一下你自己吧',
        imageBase64,
        requestVoice: $('simRequestVoice').checked
      })
    });

    const bubblesHtml = (res.chunks || [res.displayText])
      .map((c, i) => `<div class="sim-bubble"><span class="muted">#${i + 1}</span> ${escapeHtml(c)}</div>`)
      .join('');

    const voiceHtml = res.voice
      ? res.voice.error
        ? `<div class="muted">语音降级: ${escapeHtml(res.voice.error)}</div>`
        : `<div><span class="tag tag-violet">语音 [${escapeHtml(res.voice.emotion)}] ${res.voice.cached ? 'SHA-256 缓存秒回' : `${res.voice.latencyMs}ms`}</span><br/><audio controls src="data:audio/${res.voice.format || 'wav'};base64,${res.voice.audioBase64}"></audio></div>`
      : '';

    const stickerHtml = res.sticker
      ? `<div><span class="tag tag-amber">触发斗图 #${res.sticker.id} [${escapeHtml(res.sticker.tags)}] (匹配分 ${res.sticker.score})</span><br/><img src="${escapeHtml(withTokenUrl(res.sticker.url))}" style="max-height:110px;border-radius:10px;margin-top:6px" /></div>`
      : '';

    const loreHitHtml = res.lorebookHits?.length
      ? `<div><span class="tag tag-emerald">📖 命中 L1 世界书 (${res.lorebookHits.length} 条)</span> ${res.lorebookHits
          .map((e) => `<code>#${e.id} ${escapeHtml(e.title)}</code>`)
          .join(' ')}</div>`
      : '';

    const memeHitHtml = res.memewikiHits?.length
      ? `<div><span class="tag tag-violet">📚 命中 L2 梗百科 (${res.memewikiHits.length} 条)</span> ${res.memewikiHits
          .map((e) => `<code>${escapeHtml(e.title)}</code>`)
          .join(' ')}</div>`
      : '';

    const loreRecHtml = res.lorebookRecorded?.length
      ? `<div><span class="tag tag-violet">✍️ AI 自动记入世界书 (${res.lorebookRecorded.length} 条)</span> ${res.lorebookRecorded
          .map((e) => `<code>#${e.id} [${escapeHtml(e.category)}·${escapeHtml(e.scope)}] ${escapeHtml(e.title)}</code>`)
          .join(' ')}</div>`
      : '';

    box.innerHTML = `
      <div class="pill-row">
        <span class="tag tag-violet">通道: ${escapeHtml(res.lane)}</span>
        <span class="tag tag-emerald">模型: ${escapeHtml(res.model)}</span>
        <span class="tag tag-amber">耗时: ${res.latencyMs}ms</span>
        <span class="tag tag-violet">情绪: ${escapeHtml(res.emotion)}</span>
        <span class="muted">Tokens: in=${res.usage?.inputTokens || 0} / out=${res.usage?.outputTokens || 0} / cache=${res.usage?.cachedReadTokens || 0}</span>
      </div>
      ${loreHitHtml}
      ${memeHitHtml}
      ${bubblesHtml}
      ${loreRecHtml}
      ${voiceHtml}
      ${stickerHtml}
    `;
    await refreshStatus();
  } catch (e) {
    box.innerHTML = `<div class="error-text">联调失败: ${escapeHtml(e.message)}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = '发送联调测试';
  }
});

// Logs SSE
function appendLogLine(entry) {
  const term = $('logTerminal');
  const div = document.createElement('div');
  div.className = `log-line log-${entry.level || 'info'}`;
  const t = new Date(entry.ts || Date.now()).toLocaleTimeString('zh-CN', { hour12: false });
  div.textContent = `[${t}][${String(entry.level || 'info').toUpperCase()}][${entry.source || 'sys'}] ${entry.message}`;
  term.prepend(div);
  while (term.children.length > 200) term.lastChild.remove();
}

$('btnClearLogs').addEventListener('click', () => {
  $('logTerminal').innerHTML = '';
});

function connectSse() {
  if (state.sse) state.sse.close();
  const es = new EventSource(withTokenUrl('/api/events'));
  es.addEventListener('log', (e) => {
    try { appendLogLine(JSON.parse(e.data)); } catch {}
  });
  es.addEventListener('status', () => {
    refreshStatus().catch(() => {});
  });
  state.sse = es;
}

async function boot() {
  try {
    const avatarImg = $('personaAvatarImg');
    if (avatarImg && state.token) {
      avatarImg.src = withTokenUrl('/api/persona/avatar');
      avatarImg.style.display = '';
    }
    await loadConfig();
    await refreshStatus();
    await loadTtsAssets();
    const logs = await api('/api/logs');
    $('logTerminal').innerHTML = '';
    for (const item of [...logs].reverse()) appendLogLine(item);
    connectSse();
  } catch (e) {
    if (!String(e.message).includes('授权')) {
      showToast(`初始化提示: ${e.message}`);
    }
  }
}

boot();
