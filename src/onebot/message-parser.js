function decodeCqValue(v) {
  return String(v || '')
    .replace(/&#91;/g, '[')
    .replace(/&#93;/g, ']')
    .replace(/&#44;/g, ',')
    .replace(/&amp;/g, '&');
}

export function parseCqString(raw) {
  const str = String(raw || '');
  const segments = [];
  const regex = /\[CQ:([a-zA-Z0-9_-]+)((?:,[^\]]*)?)\]/g;
  let lastIndex = 0;
  let match;
  while ((match = regex.exec(str)) !== null) {
    if (match.index > lastIndex) {
      const text = decodeCqValue(str.slice(lastIndex, match.index));
      if (text) segments.push({ type: 'text', data: { text } });
    }
    const type = match[1];
    const paramsStr = match[2] || '';
    const data = {};
    if (paramsStr) {
      for (const pair of paramsStr.slice(1).split(',')) {
        const eq = pair.indexOf('=');
        if (eq > 0) {
          const k = pair.slice(0, eq).trim();
          const v = decodeCqValue(pair.slice(eq + 1));
          data[k] = v;
        }
      }
    }
    segments.push({ type, data });
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < str.length) {
    const tail = decodeCqValue(str.slice(lastIndex));
    if (tail) segments.push({ type: 'text', data: { text: tail } });
  }
  return segments;
}

function normalizeCardImageUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith('//')) return `https:${s}`;
  if (/^[a-z0-9.-]+\.[a-z]{2,}\//i.test(s)) return `https://${s}`;
  return '';
}

function normalizeCardJumpUrl(rawUrl, fallbackPath = '') {
  const candidates = [rawUrl, fallbackPath].map((s) => String(s || '').trim()).filter(Boolean);
  for (const s of candidates) {
    if (/^https?:\/\//i.test(s)) return s;
    const bvMatch = s.match(/[?&]bvid=(BV1[0-9A-Za-z]{9})\b/i);
    if (bvMatch) return `https://www.bilibili.com/video/${bvMatch[1]}`;
    const avMatch = s.match(/[?&](?:avid|aid)=(\d{4,14})\b/i);
    if (avMatch) return `https://www.bilibili.com/video/av${avMatch[1]}`;
  }
  return '';
}

function formatDisplayCardUrl(rawUrl) {
  const s = String(rawUrl || '').trim();
  if (!/^https?:\/\//i.test(s)) return '';
  try {
    const u = new URL(s);
    if (/^(?:b23\.tv|bili2233\.cn)$/i.test(u.hostname)) {
      return `${u.origin}${u.pathname}`;
    }
    if (/(?:^|\.)bilibili\.com$/i.test(u.hostname)) {
      return `${u.origin}${u.pathname}`;
    }
  } catch {
    // keep raw fallback below
  }
  return s.slice(0, 140);
}

function parseJsonCardSegment(rawData) {
  let obj = rawData;
  if (typeof rawData === 'string') {
    try {
      obj = JSON.parse(rawData);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== 'object') return null;

  const meta = obj.meta && typeof obj.meta === 'object' ? obj.meta : {};
  const card =
    meta.detail_1 ||
    meta.news ||
    meta.music ||
    meta.miniapp ||
    Object.values(meta).find((v) => v && typeof v === 'object') ||
    {};

  const promptClean = String(obj.prompt || '')
    .replace(/^\[(?:QQ小程序|分享|音乐|视频)\]\s*/i, '')
    .trim();
  const appLabel = String(card.tag || (meta.detail_1 ? card.title : '') || promptClean || '分享卡片').trim();
  const mainTitle = meta.detail_1
    ? String(card.desc || card.title || promptClean || '').trim()
    : String(card.title || card.desc || promptClean || '').trim();
  const extraDesc = !meta.detail_1 && card.title && card.desc && card.desc !== card.title
    ? String(card.desc).trim()
    : '';
  const sharer = String(card.host?.nick || card.nick || card.author || '').trim();
  const jumpUrl = normalizeCardJumpUrl(
    card.qqdocurl || card.jumpUrl || card.url || card.musicUrl || '',
    card.url || card.path || ''
  );
  const displayUrl = formatDisplayCardUrl(jumpUrl);
  const previewUrl = normalizeCardImageUrl(card.preview || card.icon || card.cover || '');

  const parts = [`[分享卡片 · ${appLabel}]`];
  if (mainTitle) parts.push(mainTitle);
  if (extraDesc) parts.push(`- ${extraDesc}`);
  if (sharer && !mainTitle.includes(sharer)) parts.push(`(分享人: ${sharer})`);
  if (displayUrl) parts.push(displayUrl);

  return {
    text: parts.join(' ').trim(),
    jumpUrl,
    previewUrl
  };
}

function parseXmlCardSegment(rawXml) {
  const s = String(rawXml || '');
  if (!s) return null;
  const brief = s.match(/brief="([^"]+)"/i)?.[1] || '';
  const title = s.match(/<title>([^<]+)<\/title>/i)?.[1] || '';
  const summary = s.match(/<summary>([^<]+)<\/summary>/i)?.[1] || '';
  const rawUrl = decodeCqValue(s.match(/\burl="([^"]+)"/i)?.[1] || '').trim();
  const jumpUrl = normalizeCardJumpUrl(rawUrl);
  const displayUrl = formatDisplayCardUrl(jumpUrl);
  const body = [title, summary].filter(Boolean).join(' - ') || brief;
  const textParts = [];
  if (body) textParts.push(`[分享卡片] ${decodeCqValue(body).trim()}`);
  if (displayUrl) textParts.push(displayUrl);
  return {
    text: textParts.join(' ').trim(),
    jumpUrl
  };
}

export function normalizeSegments(message, rawMessage = '') {
  if (Array.isArray(message)) {
    return message.filter((s) => s && typeof s.type === 'string');
  }
  if (typeof message === 'string' && message.length > 0) {
    return parseCqString(message);
  }
  if (typeof rawMessage === 'string' && rawMessage.length > 0) {
    return parseCqString(rawMessage);
  }
  return [];
}

export function parseOneBotMessageEvent(event) {
  const selfId = String(event?.self_id ?? '');
  const userId = String(event?.user_id ?? '');
  const groupId = event?.group_id !== undefined && event?.group_id !== null ? String(event.group_id) : '';
  const messageType = event?.message_type === 'group' ? 'group' : 'private';
  const messageId = event?.message_id !== undefined && event?.message_id !== null ? String(event.message_id) : '';
  const sender = event?.sender || {};
  const senderName = String(sender.card || sender.nickname || userId || '未知用户').trim();

  const segments = normalizeSegments(event?.message, event?.raw_message);
  const textParts = [];
  const images = [];
  const links = [];
  const forwards = [];
  const ats = [];
  let isAtSelf = false;
  let replyToId = null;

  for (const seg of segments) {
    const d = seg.data || {};
    switch (seg.type) {
      case 'text': {
        if (d.text) textParts.push(String(d.text));
        break;
      }
      case 'at': {
        const target = String(d.qq || '').trim();
        if (target) {
          ats.push(target);
          if (selfId && target === selfId) {
            isAtSelf = true;
          }
        }
        break;
      }
      case 'reply': {
        if (d.id !== undefined && d.id !== null) {
          replyToId = String(d.id);
        }
        break;
      }
      case 'image':
      case 'mface': {
        const url = String(d.url || '').trim();
        const file = String(d.file || '').trim();
        const summary = String(d.summary || '').trim();
        const subType = d.sub_type ?? d.subType ?? 0;
        const isSticker =
          seg.type === 'mface' ||
          Number(subType) === 1 ||
          String(subType) === '1' ||
          summary.includes('表情') ||
          Boolean(d.emoji_id);
        if (url || file) {
          images.push({
            url,
            file,
            summary,
            subType,
            emojiId: d.emoji_id ? String(d.emoji_id) : '',
            isSticker
          });
        }
        break;
      }
      case 'face': {
        textParts.push(`[QQ表情:${d.id || ''}]`);
        break;
      }
      case 'json': {
        const card = parseJsonCardSegment(d.data);
        if (card?.text) {
          textParts.push(card.text);
        }
        if (card?.jumpUrl && !links.includes(card.jumpUrl)) {
          links.push(card.jumpUrl);
        }
        if (card?.previewUrl) {
          images.push({
            url: card.previewUrl,
            file: '',
            summary: '[卡片封面]',
            subType: 0,
            emojiId: '',
            isSticker: false,
            isCardPreview: true
          });
        }
        break;
      }
      case 'xml': {
        const xmlCard = parseXmlCardSegment(d.data);
        if (xmlCard?.text) textParts.push(xmlCard.text);
        if (xmlCard?.jumpUrl && !links.includes(xmlCard.jumpUrl)) {
          links.push(xmlCard.jumpUrl);
        }
        break;
      }
      case 'video': {
        textParts.push('[视频消息]');
        break;
      }
      case 'forward': {
        textParts.push('[合并转发聊天记录]');
        const fid = String(d.id ?? d.resid ?? d.resId ?? d.message_id ?? '').trim();
        const inlineContent = Array.isArray(d.content) ? d.content : null;
        if (fid || inlineContent?.length) {
          forwards.push({ id: fid, content: inlineContent });
        }
        break;
      }
      default:
        break;
    }
  }

  const text = textParts.join('').trim();
  const sessionKey = messageType === 'group' ? `group:${groupId}` : `private:${userId}`;

  return {
    selfId,
    userId,
    groupId,
    messageType,
    messageId,
    senderName,
    sessionKey,
    text,
    images,
    links,
    forwards,
    ats,
    isAtSelf,
    replyToId,
    timestamp: Number(event?.time || Math.floor(Date.now() / 1000)) * 1000,
    raw: event
  };
}
