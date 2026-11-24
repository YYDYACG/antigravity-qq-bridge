import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables
} from '@modelcontextprotocol/ext-apps';

const app = new App({ name: 'Antigravity Hub', version: '1.2.2' }, {});

const elLoading = document.getElementById('viewLoading');
const elLoadingTitle = document.getElementById('loadingTitle');
const elLoadingDesc = document.getElementById('loadingDesc');
const elLoadingServices = document.getElementById('loadingServices');
const elOffline = document.getElementById('viewOffline');
const elOfflineServices = document.getElementById('offlineServices');
const elFrameWrap = document.getElementById('viewFrameWrap');
const elFrame = document.getElementById('hubFrame');
const elOfflineSub = document.getElementById('offlineSub');
const elOfflineErr = document.getElementById('offlineErr');
const elToast = document.getElementById('hubToast');
const btnStart = document.getElementById('btnStartHub');
const btnRecheck = document.getElementById('btnRecheck');
const btnOpenBrowserOffline = document.getElementById('btnOpenBrowserOffline');
const btnFloatEnsure = document.getElementById('btnFloatEnsure');
const btnFloatReload = document.getElementById('btnFloatReload');
const btnFloatPopout = document.getElementById('btnFloatPopout');

let currentSession = null;
let autoStartAttempted = false;
let fetching = false;
let toastTimer = null;

function showView(mode) {
  elLoading.classList.toggle('hidden', mode !== 'loading');
  elOffline.classList.toggle('hidden', mode !== 'offline');
  elFrameWrap.classList.toggle('hidden', mode !== 'online');
}

function setLoadingText(title, desc) {
  if (elLoadingTitle) elLoadingTitle.textContent = title;
  if (elLoadingDesc) elLoadingDesc.textContent = desc;
}

function showToast(msg, ms = 7000) {
  if (!elToast || !msg) return;
  elToast.textContent = msg;
  elToast.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    elToast.classList.add('hidden');
  }, ms);
}

function formatServiceNames(keys = []) {
  const map = {
    bridge: 'Bridge',
    napcat: 'NapCatQQ',
    sovits: 'GPT-SoVITS v5'
  };
  return keys.map((k) => map[k] || k).join('、');
}

function renderServicePills(container, services) {
  if (!container) return;
  container.innerHTML = '';
  if (!services || typeof services !== 'object') return;
  const items = [
    { label: 'Bridge', info: services.bridge },
    { label: 'NapCatQQ', info: services.napcat },
    { label: 'GPT-SoVITS v5', info: services.sovits }
  ];
  for (const { label, info } of items) {
    if (!info) continue;
    const pill = document.createElement('span');
    let cls = 'off';
    let stateText = '未启动';
    if (info.enabled === false) {
      cls = '';
      stateText = '已禁用';
    } else if (info.online) {
      cls = 'ok';
      stateText = '在线';
    } else if (info.booting) {
      cls = 'boot';
      stateText = '启动中';
    }
    pill.className = `svc-pill ${cls}`.trim();
    const dot = document.createElement('span');
    dot.className = 'dot';
    pill.appendChild(dot);
    pill.appendChild(document.createTextNode(`${label} · ${stateText}`));
    container.appendChild(pill);
  }
}

function applyTheme(ctx) {
  if (ctx?.theme) applyDocumentTheme(ctx.theme);
  if (ctx?.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
}

function isSafeLocalhostUrl(raw) {
  try {
    const u = new URL(String(raw || ''));
    return (
      (u.protocol === 'http:' || u.protocol === 'https:') &&
      (u.hostname === '127.0.0.1' || u.hostname === 'localhost')
    );
  } catch {
    return false;
  }
}

function openExternal(url) {
  if (!url) return;
  const caps = app.getHostCapabilities?.();
  if (caps?.openLinks) {
    app.openLink({ url }).catch(() => window.open(url, '_blank', 'noopener'));
  } else {
    window.open(url, '_blank', 'noopener');
  }
}

// Bridge external localhost links (e.g. NapCat QR login WebUI) clicked inside the sandboxed Hub iframe
window.addEventListener('message', (event) => {
  const data = event?.data;
  if (!data || data.type !== 'agyqq:open-external') return;
  const reply = (ok) => {
    try {
      event.source?.postMessage?.({ type: 'agyqq:open-external-ack', reqId: data.reqId, ok }, '*');
    } catch {
      // ignore cross-origin postMessage error
    }
  };
  if (!isSafeLocalhostUrl(data.url)) {
    reply(false);
    return;
  }
  const caps = app.getHostCapabilities?.();
  if (caps?.openLinks) {
    app
      .openLink({ url: data.url })
      .then(() => reply(true))
      .catch(() => reply(false));
  } else {
    reply(false);
  }
});

function renderSession(st, { toastOnLaunch = true } = {}) {
  if (!st || typeof st !== 'object') return;
  currentSession = st;
  renderServicePills(elLoadingServices, st.services);
  renderServicePills(elOfflineServices, st.services);

  if (st.online && st.hubUrl) {
    if (elFrame.getAttribute('src') !== st.hubUrl) {
      elFrame.setAttribute('src', st.hubUrl);
    }
    showView('online');
    if (toastOnLaunch && Array.isArray(st.launched) && st.launched.length) {
      const hasSovits = st.launched.includes('sovits');
      showToast(
        `已自动后台拉起：${formatServiceNames(st.launched)}${hasSovits ? '（语音底模加载约需 30 秒，就绪后页内状态灯会自动变绿）' : ''}`,
        hasSovits ? 9000 : 6000
      );
    }
  } else {
    elOfflineSub.textContent = `本地服务 ${st.baseUrl || 'http://127.0.0.1:3200'} 当前未就绪，可点击下方按钮一键拉起缺失服务。`;
    elOfflineErr.textContent = st.error ? `检测详情：${st.error}` : '';
    elOfflineErr.classList.toggle('hidden', !st.error);
    showView('offline');
  }
}

async function fetchOrAutoStart({ allowAutoStart = true } = {}) {
  if (fetching) return;
  fetching = true;
  try {
    const res = await app.callServerTool({ name: 'app_get_hub_session', arguments: {} });
    const data = res?.structuredContent;

    // Case 1: Bridge online & all enabled companion services already running/booting
    if (data?.online && data?.hubUrl && !data?.needsAutoStart) {
      renderSession(data, { toastOnLaunch: false });
      return;
    }

    // Case 2: Bridge already online, but NapCatQQ or GPT-SoVITS v5 is offline -> show Hub immediately & start missing ones in background!
    if (data?.online && data?.hubUrl && data?.needsAutoStart && allowAutoStart && !autoStartAttempted) {
      autoStartAttempted = true;
      renderSession(data, { toastOnLaunch: false });
      const missingText = formatServiceNames(data.missingServices || []);
      if (missingText) {
        showToast(`检测到 ${missingText} 未运行，正在后台自动拉起...`, 5000);
      }
      const started = await app.callServerTool({ name: 'app_start_hub', arguments: {} });
      if (started?.structuredContent) {
        renderSession(started.structuredContent, { toastOnLaunch: true });
      }
      return;
    }

    // Case 3: Bridge offline (e.g. fresh Windows boot) -> auto-launch full stack!
    if (allowAutoStart && !autoStartAttempted) {
      autoStartAttempted = true;
      const missingText = formatServiceNames(data?.missingServices?.length ? data.missingServices : ['napcat', 'sovits', 'bridge']);
      renderServicePills(elLoadingServices, data?.services);
      setLoadingText(
        '正在自动拉起星喵全套服务...',
        `检测到 ${missingText} 尚未运行，正在后台一键启动（控制台约 2~4 秒就绪，语音底模将在后台继续热身）...`
      );
      showView('loading');
      const started = await app.callServerTool({ name: 'app_start_hub', arguments: {} });
      renderSession(started?.structuredContent || { online: false, error: '自动启动未返回有效状态' });
      return;
    }

    renderSession(data || { online: false, error: '未获取到本地会话信息' }, { toastOnLaunch: false });
  } catch (err) {
    renderSession({ online: false, error: err?.message || String(err) }, { toastOnLaunch: false });
  } finally {
    fetching = false;
  }
}

// Register handlers BEFORE connect() so no host notification is missed
app.ontoolinput = () => {
  if (!currentSession?.online) {
    setLoadingText('正在检测星喵全套服务...', '自动检查 Bridge、NapCatQQ 与 GPT-SoVITS v5，未启动的服务将自动后台拉起...');
    showView('loading');
  }
};

app.ontoolresult = () => {
  fetchOrAutoStart({ allowAutoStart: true });
};

app.onhostcontextchanged = (ctx) => {
  applyTheme(ctx);
};

btnStart.addEventListener('click', async () => {
  btnStart.disabled = true;
  btnStart.textContent = '正在拉起服务...';
  elOfflineErr.classList.add('hidden');
  try {
    const res = await app.callServerTool({ name: 'app_start_hub', arguments: {} });
    renderSession(res?.structuredContent || { online: false, error: '启动结果为空' });
  } catch (err) {
    elOfflineErr.textContent = `启动失败：${err?.message || err}`;
    elOfflineErr.classList.remove('hidden');
  } finally {
    btnStart.disabled = false;
    btnStart.textContent = '🚀 一键拉起全套服务';
  }
});

btnRecheck.addEventListener('click', async () => {
  btnRecheck.disabled = true;
  btnRecheck.textContent = '检测中...';
  try {
    await fetchOrAutoStart({ allowAutoStart: false });
  } finally {
    btnRecheck.disabled = false;
    btnRecheck.textContent = '🔄 重新检测';
  }
});

btnOpenBrowserOffline.addEventListener('click', () => {
  openExternal(currentSession?.hubUrl || 'http://127.0.0.1:3200/');
});

btnFloatEnsure.addEventListener('click', async () => {
  btnFloatEnsure.disabled = true;
  const orig = btnFloatEnsure.textContent;
  btnFloatEnsure.textContent = '检测中...';
  try {
    const res = await app.callServerTool({ name: 'app_start_hub', arguments: {} });
    const st = res?.structuredContent;
    if (st) {
      currentSession = st;
      if (Array.isArray(st.launched) && st.launched.length) {
        const hasSovits = st.launched.includes('sovits');
        showToast(
          `已后台拉起：${formatServiceNames(st.launched)}${hasSovits ? '（语音底模加载约需 30 秒）' : ''}`,
          hasSovits ? 8000 : 5000
        );
      } else {
        const booting = ['bridge', 'napcat', 'sovits'].filter((k) => st.services?.[k]?.booting);
        showToast(
          booting.length
            ? `${formatServiceNames(booting)} 正在后台启动中，其余服务均已在线`
            : '三大服务（Bridge / NapCatQQ / GPT-SoVITS v5）均已在线 ✓',
          4500
        );
      }
      if (st.online && st.hubUrl && elFrame.getAttribute('src') !== st.hubUrl) {
        elFrame.setAttribute('src', st.hubUrl);
      }
    }
  } catch (err) {
    showToast(`检测拉起失败：${err?.message || err}`, 5000);
  } finally {
    btnFloatEnsure.disabled = false;
    btnFloatEnsure.textContent = orig;
  }
});

btnFloatReload.addEventListener('click', () => {
  if (currentSession?.hubUrl) {
    elFrame.setAttribute('src', 'about:blank');
    setTimeout(() => elFrame.setAttribute('src', currentSession.hubUrl), 40);
  } else {
    fetchOrAutoStart({ allowAutoStart: true });
  }
});

btnFloatPopout.addEventListener('click', () => {
  openExternal(currentSession?.hubUrl || 'http://127.0.0.1:3200/');
});

async function main() {
  showView('loading');
  await app.connect();
  applyTheme(app.getHostContext?.());
  await fetchOrAutoStart({ allowAutoStart: true });
}

main().catch((err) => {
  renderSession({ online: false, error: `MCP App 初始化失败：${err?.message || err}` });
});
