import fs from 'node:fs';
import path from 'node:path';

function normalizeFsPath(p) {
  const raw = String(p || '').trim();
  if (!raw) return '';
  try {
    const resolved = path.resolve(raw);
    const real = fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved;
    return process.platform === 'win32' ? real.toLowerCase() : real;
  } catch {
    return '';
  }
}

export class OwnerGuard {
  constructor(configStore, { readonlyAllowedFiles = [] } = {}) {
    this.configStore = configStore;
    this.readonlyAllowedFiles = new Set(
      (readonlyAllowedFiles || []).map((p) => normalizeFsPath(p)).filter(Boolean)
    );
    this.groupActiveState = new Map(); // groupId -> { expiresAt, activeReplies, lastActivatedAt, activatedBy }
    this.auditLog = [];
    this.maxAuditEntries = 100;
  }

  activateGroup(groupId, { activatedBy = '', now = Date.now() } = {}) {
    const gid = String(groupId || '').trim();
    if (!gid) return null;
    const g = this.configStore.get().guard || {};
    const windowSec = Number(g.groupActiveWindowSec ?? 180);
    if (windowSec <= 0) return null;
    const state = {
      expiresAt: now + windowSec * 1000,
      activeReplies: 0,
      consecutiveSilent: 0,
      lastActivatedAt: now,
      activatedBy: String(activatedBy || '')
    };
    this.groupActiveState.set(gid, state);
    return state;
  }

  touchGroupActive(groupId, { countReply = false, now = Date.now() } = {}) {
    const gid = String(groupId || '').trim();
    if (!gid) return null;
    const g = this.configStore.get().guard || {};
    const windowSec = Number(g.groupActiveWindowSec ?? 180);
    if (windowSec <= 0) return null;
    const cur = this.groupActiveState.get(gid);
    if (!cur || now >= cur.expiresAt) {
      this.groupActiveState.delete(gid);
      return null;
    }
    cur.expiresAt = now + windowSec * 1000;
    cur.consecutiveSilent = 0;
    if (countReply) {
      cur.activeReplies = (cur.activeReplies || 0) + 1;
    }
    return cur;
  }

  recordGroupSilent(groupId, now = Date.now()) {
    const gid = String(groupId || '').trim();
    const g = this.configStore.get().guard || {};
    const maxSilent = Math.round(Number(g.groupActiveMaxConsecutiveSilent ?? 2));
    if (!gid) return { deactivated: false, consecutiveSilent: 0, maxSilent };
    const cur = this.groupActiveState.get(gid);
    if (!cur || now >= cur.expiresAt) {
      if (cur) this.groupActiveState.delete(gid);
      return { deactivated: false, consecutiveSilent: 0, maxSilent };
    }
    cur.consecutiveSilent = (cur.consecutiveSilent || 0) + 1;
    if (maxSilent > 0 && cur.consecutiveSilent >= maxSilent) {
      this.groupActiveState.delete(gid);
      return { deactivated: true, consecutiveSilent: cur.consecutiveSilent, maxSilent };
    }
    return { deactivated: false, consecutiveSilent: cur.consecutiveSilent, maxSilent };
  }

  deactivateGroup(groupId) {
    const gid = String(groupId || '').trim();
    if (!gid) return false;
    return this.groupActiveState.delete(gid);
  }

  getGroupActiveStatus(groupId, now = Date.now()) {
    const gid = String(groupId || '').trim();
    const g = this.configStore.get().guard || {};
    const maxReplies = Number(g.groupActiveMaxReplies ?? 6);
    const windowSec = Number(g.groupActiveWindowSec ?? 180);
    if (!gid || windowSec <= 0) {
      return { active: false, remainingSec: 0, activeReplies: 0, maxReplies, windowSec };
    }
    const cur = this.groupActiveState.get(gid);
    if (!cur || now >= cur.expiresAt) {
      if (cur) this.groupActiveState.delete(gid);
      return { active: false, remainingSec: 0, activeReplies: 0, maxReplies, windowSec };
    }
    return {
      active: true,
      remainingSec: Math.max(0, Math.ceil((cur.expiresAt - now) / 1000)),
      activeReplies: cur.activeReplies || 0,
      maxReplies,
      windowSec
    };
  }

  allowReadonlyFile(filePath) {
    const norm = normalizeFsPath(filePath);
    if (norm) this.readonlyAllowedFiles.add(norm);
  }

  _isWhitelistedReadonlyTool(toolName, toolArgs) {
    const name = String(toolName || '').toLowerCase();
    if (name !== 'read_file' && name !== 'view_file') return false;
    const rawPath =
      toolArgs?.Path ??
      toolArgs?.path ??
      toolArgs?.AbsolutePath ??
      toolArgs?.file_path ??
      '';
    const norm = normalizeFsPath(rawPath);
    if (!norm) return false;
    return this.readonlyAllowedFiles.has(norm);
  }

  _recordAudit(entry) {
    this.auditLog.unshift({
      ts: Date.now(),
      ...entry
    });
    if (this.auditLog.length > this.maxAuditEntries) {
      this.auditLog.length = this.maxAuditEntries;
    }
  }

  getAuditLog() {
    return this.auditLog;
  }

  isOwner(userId) {
    const uid = String(userId || '').trim();
    if (!uid) return false;
    const owners = this.configStore.get().guard.ownerUsers || [];
    return owners.includes(uid);
  }

  evaluateIncoming({
    messageType,
    userId,
    groupId = '',
    isAtSelf = false,
    isReplyToSelf = false,
    isAtOtherOnly = false,
    text = '',
    isCommand = false,
    now = Date.now()
  }) {
    const g = this.configStore.get().guard;
    const uid = String(userId || '').trim();
    const gid = String(groupId || '').trim();
    const owner = this.isOwner(uid);

    if (uid && g.denyUsers.includes(uid)) {
      return { allowed: false, reason: 'user-denied', lane: 'group', isOwner: owner };
    }

    if (messageType === 'private') {
      const privateAllowed =
        owner ||
        g.allowPrivate.includes(uid) ||
        (g.allowPrivate.length === 0 && g.allowAllPrivateWhenEmpty);

      if (!privateAllowed) {
        return { allowed: false, reason: 'private-not-whitelisted', lane: 'group', isOwner: owner };
      }

      // Only verified owners in private chat receive the privileged 'owner' lane
      const lane = owner ? 'owner' : 'group';
      return { allowed: true, reason: owner ? 'owner-private' : 'private-whitelisted', lane, isOwner: owner };
    }

    if (messageType === 'group') {
      if (gid && g.denyGroups.includes(gid)) {
        return { allowed: false, reason: 'group-denied', lane: 'group', isOwner: owner };
      }

      const groupAllowed =
        g.allowGroups.includes(gid) ||
        (g.allowGroups.length === 0 && g.allowAllGroupsWhenEmpty);

      if (!groupAllowed) {
        return { allowed: false, reason: 'group-not-whitelisted', lane: 'group', isOwner: owner };
      }

      // Peer bot anti-ping-pong: record in 0-token ambient buffer only, never auto-trigger replies
      const isPeerBot = Boolean(uid && (g.peerBotUsers || []).includes(uid));
      if (isPeerBot && !isCommand) {
        return {
          allowed: false,
          reason: 'peer-bot-passive-only',
          lane: 'group',
          isOwner: false,
          passiveObserve: true
        };
      }

      // Check trigger condition unless it's a recognized command
      let triggerMode = isCommand ? 'command' : 'open';
      let activeRemainingSec = 0;
      const lower = String(text || '').toLowerCase();
      const keywordHit =
        !isAtOtherOnly &&
        (g.triggerKeywords || []).some((kw) => kw && lower.includes(String(kw).toLowerCase()));

      // Peer bot name avoidance: e.g. human talks to another bot by name without mentioning/replying to self
      const peerBotNameHit =
        !isCommand &&
        !isAtSelf &&
        !isReplyToSelf &&
        !keywordHit &&
        (g.peerBotNames || []).some((name) => name && lower.includes(String(name).toLowerCase()));
      if (peerBotNameHit) {
        return {
          allowed: false,
          reason: 'group-peer-bot-name-passive',
          lane: 'group',
          isOwner: owner,
          passiveObserve: true
        };
      }

      if (g.groupRequireAtOrKeyword && !isCommand) {
        if (isAtSelf || isReplyToSelf || keywordHit) {
          triggerMode = isAtSelf ? 'at' : isReplyToSelf ? 'reply-to-self' : 'keyword';
          const act = this.activateGroup(gid, { activatedBy: uid, now });
          activeRemainingSec = act ? Math.ceil((act.expiresAt - now) / 1000) : 0;
        } else if (isAtOtherOnly) {
          return {
            allowed: false,
            reason: 'group-at-other-passive',
            lane: 'group',
            isOwner: owner,
            passiveObserve: true
          };
        } else {
          const actStatus = this.getGroupActiveStatus(gid, now);
          if (actStatus.active && actStatus.activeReplies < actStatus.maxReplies) {
            triggerMode = 'active-window';
            activeRemainingSec = actStatus.remainingSec;
          } else {
            return {
              allowed: false,
              reason: 'group-trigger-not-matched',
              lane: 'group',
              isOwner: owner,
              passiveObserve: true // allow ambient group buffer + sticker auto-steal observation!
            };
          }
        }
      }

      // Hard Owner Guard: group chats ALWAYS stay on 'group' sandbox lane unless explicitly overridden
      const lane = owner && g.allowOwnerToolsInGroups ? 'owner' : 'group';
      if (owner && !g.allowOwnerToolsInGroups) {
        return {
          allowed: true,
          reason: triggerMode === 'active-window' ? 'group-active-window' : 'group-owner-sandboxed',
          triggerMode,
          activeRemainingSec,
          lane: 'group',
          isOwner: true
        };
      }
      return {
        allowed: true,
        reason: triggerMode === 'active-window' ? 'group-active-window' : 'group-allowed',
        triggerMode,
        activeRemainingSec,
        lane,
        isOwner: owner
      };
    }

    return { allowed: false, reason: 'unsupported-message-type', lane: 'group', isOwner: owner };
  }

  decideAcpToolPermission({ lane, toolName = 'unknown', toolKind = 'unknown', toolTitle = '', toolArgs = {} }) {
    const g = this.configStore.get().guard;

    // Narrow exact-file readonly exemption (e.g., data/sticker-catalog.md) even in group sandbox!
    if (this._isWhitelistedReadonlyTool(toolName, toolArgs)) {
      const decision = { allow: true, reason: 'sticker-catalog-readonly-whitelisted' };
      this._recordAudit({
        action: 'allow',
        lane,
        toolName,
        toolKind,
        toolTitle,
        reason: decision.reason
      });
      return decision;
    }

    if (lane !== 'owner') {
      const decision = { allow: false, reason: 'group-tools-blocked' };
      this._recordAudit({
        action: 'deny',
        lane,
        toolName,
        toolKind,
        toolTitle,
        reason: decision.reason
      });
      return decision;
    }

    if (!g.ownerToolsEnabled) {
      const decision = { allow: false, reason: 'owner-tools-disabled' };
      this._recordAudit({
        action: 'deny',
        lane,
        toolName,
        toolKind,
        toolTitle,
        reason: decision.reason
      });
      return decision;
    }

    if (!g.autoApproveOwnerTools) {
      const decision = { allow: false, reason: 'auto-approve-off' };
      this._recordAudit({
        action: 'deny',
        lane,
        toolName,
        toolKind,
        toolTitle,
        reason: decision.reason
      });
      return decision;
    }

    const decision = { allow: true, reason: 'owner-private-authorized' };
    this._recordAudit({
      action: 'allow',
      lane,
      toolName,
      toolKind,
      toolTitle,
      reason: decision.reason
    });
    return decision;
  }
}
