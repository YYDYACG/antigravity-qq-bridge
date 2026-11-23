function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function cleanChatMarkdown(text) {
  let out = String(text || '').trim();
  // Remove bold/heading noise only lightly so code blocks stay readable for owner
  out = out.replace(/^#{1,6}\s+/gm, '');
  out = out.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  return out.trim();
}

export function splitNaturalChunks(text, { maxChunkChars = 140, maxChunksPerReply = 6 } = {}) {
  const cleaned = cleanChatMarkdown(text);
  if (!cleaned) return [];

  // Preserve fenced code blocks as intact chunks so owner code replies never break
  if (cleaned.includes('```')) {
    const blocks = cleaned.split(/(```[\s\S]*?```)/g).map((s) => s.trim()).filter(Boolean);
    return blocks.slice(0, maxChunksPerReply);
  }

  const paragraphs = cleaned
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean);

  const chunks = [];
  for (const para of paragraphs) {
    if (para.length <= maxChunkChars) {
      chunks.push(para);
      continue;
    }
    // Split long paragraph along natural sentence endings
    const sentences = para.match(/[^。！？!?~～]+[。！？!?~～]*/g) || [para];
    let current = '';
    for (const sent of sentences) {
      const s = sent.trim();
      if (!s) continue;
      if (!current) {
        if (s.length <= maxChunkChars) {
          current = s;
        } else {
          // Hard wrap very long single sentence without punctuation
          for (let i = 0; i < s.length; i += maxChunkChars) {
            chunks.push(s.slice(i, i + maxChunkChars));
          }
        }
      } else if (current.length + s.length <= maxChunkChars) {
        current += s;
      } else {
        chunks.push(current);
        if (s.length <= maxChunkChars) {
          current = s;
        } else {
          for (let i = 0; i < s.length; i += maxChunkChars) {
            chunks.push(s.slice(i, i + maxChunkChars));
          }
          current = '';
        }
      }
    }
    if (current) chunks.push(current);
  }

  if (chunks.length <= maxChunksPerReply) {
    return chunks;
  }

  const kept = chunks.slice(0, maxChunksPerReply - 1);
  const rest = chunks.slice(maxChunksPerReply - 1).join('\n');
  kept.push(rest);
  return kept;
}

export function isRiskControlError(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  return (
    msg.includes('1200') ||
    msg.includes('wind control') ||
    msg.includes('风控') ||
    msg.includes('频率') ||
    msg.includes('rate limit') ||
    msg.includes('too fast') ||
    msg.includes('禁言') ||
    msg.includes('muted')
  );
}

export class RateLimiter {
  constructor(configStore) {
    this.configStore = configStore;
    this.backoffUntil = new Map(); // sessionKey -> timestamp
  }

  isInBackoff(sessionKey) {
    const until = this.backoffUntil.get(sessionKey) || 0;
    if (until > Date.now()) {
      return { active: true, remainingSec: Math.ceil((until - Date.now()) / 1000) };
    }
    if (until) this.backoffUntil.delete(sessionKey);
    return { active: false, remainingSec: 0 };
  }

  triggerBackoff(sessionKey, customSec) {
    const sec = customSec ?? this.configStore.get().guard.riskBackoffSec ?? 90;
    const until = Date.now() + sec * 1000;
    this.backoffUntil.set(sessionKey, until);
    return { until, sec };
  }

  async sendChunked(sessionKey, text, sendFn, { onBackoff } = {}) {
    const backoff = this.isInBackoff(sessionKey);
    if (backoff.active) {
      return { sent: 0, skippedBackoff: true, remainingSec: backoff.remainingSec };
    }

    const g = this.configStore.get().guard;
    const chunks = splitNaturalChunks(text, {
      maxChunkChars: g.maxChunkChars,
      maxChunksPerReply: g.maxChunksPerReply
    });

    const baseDelayMs = Math.max(0, Number(g.chunkDelaySec ?? 0.45) * 1000);
    let sent = 0;

    for (let i = 0; i < chunks.length; i++) {
      if (i > 0 && baseDelayMs > 0) {
        const jitter = 0.85 + Math.random() * 0.3; // +-15% natural cadence
        await sleep(Math.round(baseDelayMs * jitter));
      }
      try {
        await sendFn(chunks[i], i, chunks.length);
        sent += 1;
      } catch (err) {
        if (isRiskControlError(err)) {
          const info = this.triggerBackoff(sessionKey);
          if (typeof onBackoff === 'function') onBackoff(info, err);
          return { sent, skippedBackoff: false, triggeredBackoff: true, backoffSec: info.sec, error: err.message };
        }
        throw err;
      }
    }

    return { sent, chunks, skippedBackoff: false, triggeredBackoff: false };
  }
}
