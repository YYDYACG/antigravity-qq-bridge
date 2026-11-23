export class SmartMergeWindow {
  constructor({ getWindowMs, getDedupWindowMs, onFlush, maxWindowMs = 8000 }) {
    this.getWindowMs = getWindowMs || (() => 2500);
    this.getDedupWindowMs = getDedupWindowMs || (() => 90000);
    this.onFlush = onFlush;
    this.maxWindowMs = maxWindowMs;

    this.buckets = new Map(); // sessionKey -> { items, firstAt, timer }
    this.recentFingerprints = new Map(); // fingerprint -> ts
  }

  _pruneDedup(now) {
    const ttl = Math.max(0, Number(this.getDedupWindowMs() || 0));
    if (this.recentFingerprints.size > 500) {
      for (const [k, ts] of this.recentFingerprints.entries()) {
        if (now - ts > ttl) this.recentFingerprints.delete(k);
      }
    }
  }

  isDuplicate(sessionKey, userId, text, hasImages = false) {
    const ttl = Math.max(0, Number(this.getDedupWindowMs() || 0));
    if (!ttl || hasImages) return false;
    const trimmed = String(text || '').trim();
    if (!trimmed) return false;

    const now = Date.now();
    this._pruneDedup(now);
    const key = `${sessionKey}|${userId}|${trimmed}`;
    const prev = this.recentFingerprints.get(key);
    if (prev !== undefined && now - prev < ttl) {
      return true;
    }
    this.recentFingerprints.set(key, now);
    return false;
  }

  push(sessionKey, item) {
    const windowMs = Math.max(0, Number(this.getWindowMs() || 0));
    if (windowMs === 0) {
      this._emitBatch(sessionKey, [item]);
      return { merged: false, batchSize: 1 };
    }

    const now = Date.now();
    let bucket = this.buckets.get(sessionKey);
    if (!bucket) {
      bucket = { items: [], firstAt: now, timer: null };
      this.buckets.set(sessionKey, bucket);
    }

    bucket.items.push(item);

    if (bucket.timer) {
      clearTimeout(bucket.timer);
      bucket.timer = null;
    }

    const elapsed = now - bucket.firstAt;
    const remaining = Math.min(windowMs, Math.max(0, this.maxWindowMs - elapsed));
    if (remaining <= 0) {
      this.flush(sessionKey);
    } else {
      bucket.timer = setTimeout(() => this.flush(sessionKey), remaining);
    }

    return { merged: bucket.items.length > 1, batchSize: bucket.items.length };
  }

  flush(sessionKey) {
    const bucket = this.buckets.get(sessionKey);
    if (!bucket) return;
    if (bucket.timer) clearTimeout(bucket.timer);
    this.buckets.delete(sessionKey);
    if (bucket.items.length > 0) {
      this._emitBatch(sessionKey, bucket.items);
    }
  }

  _emitBatch(sessionKey, items) {
    const mergedText = SmartMergeWindow.formatMergedText(items);
    const mergedImages = [];
    for (const it of items) {
      if (Array.isArray(it.images)) {
        for (const img of it.images) mergedImages.push(img);
      }
    }
    const last = items[items.length - 1];
    const batch = {
      sessionKey,
      items,
      count: items.length,
      text: mergedText,
      images: mergedImages,
      lastItem: last
    };
    Promise.resolve(this.onFlush(batch)).catch(() => {});
  }

  static formatMergedText(items) {
    if (!items.length) return '';
    if (items.length === 1) return String(items[0].text || '').trim();
    const isGroup = items[0].messageType === 'group';
    const distinctUsers = new Set(items.map((i) => String(i.userId || '')));
    if (isGroup && distinctUsers.size > 1) {
      return items
        .map((i) => `${i.senderName || i.userId}: ${String(i.text || '').trim()}`)
        .filter((s) => s.length > 2)
        .join('\n');
    }
    return items
      .map((i) => String(i.text || '').trim())
      .filter(Boolean)
      .join(' / ');
  }

  clearAll() {
    for (const bucket of this.buckets.values()) {
      if (bucket.timer) clearTimeout(bucket.timer);
    }
    this.buckets.clear();
  }
}
