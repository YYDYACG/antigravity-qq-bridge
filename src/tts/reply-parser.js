import { EMOTION_KEYS } from '../config/schema.js';

const EMOTION_SYNONYMS = {
  平静: '平静',
  正常: '平静',
  日常: '平静',
  淡定: '平静',
  温柔: '温柔',
  关心: '温柔',
  安慰: '温柔',
  撒娇: '温柔',
  贴贴: '温柔',
  开心: '开心',
  高兴: '开心',
  兴奋: '开心',
  欢快: '开心',
  得意: '开心',
  调皮: '调皮',
  傲娇: '调皮',
  吐槽: '调皮',
  坏笑: '调皮',
  俏皮: '调皮',
  委屈: '委屈',
  害羞: '委屈',
  难过: '委屈',
  失落: '委屈',
  可怜: '委屈',
  疑问: '疑问',
  疑惑: '疑问',
  好奇: '疑问',
  困惑: '疑问',
  惊讶: '疑问'
};

export function normalizeEmotion(raw, fallback = '平静') {
  const key = String(raw || '').trim();
  if (EMOTION_KEYS.includes(key)) return key;
  if (EMOTION_SYNONYMS[key]) return EMOTION_SYNONYMS[key];
  return EMOTION_KEYS.includes(fallback) ? fallback : '平静';
}

export function parseAssistantReply(rawText, defaultEmotion = '平静') {
  let text = String(rawText || '').trim();

  if (/^\[(静默|SILENT)\]$/i.test(text)) {
    return {
      silent: true,
      emotion: defaultEmotion,
      stickerId: null,
      stickerQuery: null,
      voiceText: null,
      loreEntries: [],
      displayText: ''
    };
  }

  let emotion = defaultEmotion;
  let hasExplicitEmotion = false;
  text = text.replace(/\[(?:情绪|emotion)\s*[:：]\s*([^\]\r\n]+)\]/gi, (_, val) => {
    emotion = normalizeEmotion(val, defaultEmotion);
    hasExplicitEmotion = true;
    return '';
  });

  let stickerId = null;
  let stickerQuery = null;
  text = text.replace(/\[(?:表情|sticker)\s*[:：]\s*([^\]\r\n]+)\]/gi, (_, val) => {
    const q = String(val || '').trim();
    const idMatch = q.match(/^#?(\d+)$/);
    if (idMatch) {
      stickerId = Number(idMatch[1]);
    } else if (q) {
      stickerQuery = q;
    }
    return '';
  });

  let voiceText = null;
  text = text.replace(/\[(?:语音|voice)\s*[:：]\s*([^\]\r\n]+)\]/gi, (_, val) => {
    const v = String(val || '').trim();
    if (v) voiceText = v;
    return '';
  });

  const loreEntries = [];
  text = text.replace(/\[(?:词条|记忆|世界书|lore)\s*[:：]\s*([^\]\r\n]+)\]/gi, (_, rawVal) => {
    const parts = String(rawVal || '')
      .split(/[|｜]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length >= 4) {
      // [词条:范围|分类|关键词1,关键词2|释义]
      loreEntries.push({
        scopeHint: parts[0],
        category: parts[1],
        keys: parts[2].split(/[,，、;]+/).map((s) => s.trim()).filter(Boolean),
        content: parts.slice(3).join(' | ')
      });
    } else if (parts.length === 3) {
      // [词条:分类|关键词1,关键词2|释义]
      loreEntries.push({
        scopeHint: '',
        category: parts[0],
        keys: parts[1].split(/[,，、;]+/).map((s) => s.trim()).filter(Boolean),
        content: parts[2]
      });
    } else if (parts.length === 2) {
      // [词条:关键词1,关键词2|释义]
      loreEntries.push({
        scopeHint: '',
        category: '',
        keys: parts[0].split(/[,，、;]+/).map((s) => s.trim()).filter(Boolean),
        content: parts[1]
      });
    }
    return '';
  });

  const displayText = text.replace(/^\s+|\s+$/g, '').replace(/\n{3,}/g, '\n\n');

  return {
    silent: !displayText && !stickerId && !stickerQuery && !voiceText,
    emotion,
    hasExplicitEmotion,
    stickerId,
    stickerQuery,
    voiceText,
    loreEntries,
    displayText
  };
}

/**
 * Clean Markdown, URLs, code artifacts, and noisy symbols before feeding text to GPT-SoVITS.
 */
export function sanitizeVoiceText(rawText, maxChars = 120) {
  let s = String(rawText || '');
  // Remove fenced code blocks, convert markdown links [label](url) -> label, then strip bare URLs
  s = s.replace(/```[\s\S]*?```/g, ' ');
  s = s.replace(/\[([^\]\r\n]+)\]\([^)\r\n]+\)/g, '$1');
  s = s.replace(/https?:\/\/\S+/gi, ' ');
  // Strip markdown emphasis/headings/backticks/blockquotes
  s = s.replace(/[`*_#>]+/g, '');
  s = s.replace(/~~([^~]+)~~/g, '$1');
  // Collapse repeated tildes, em-dashes, stacked exclamation/question marks & newlines to natural TTS pauses
  s = s.replace(/[~～]{2,}/g, '～');
  s = s.replace(/[—\-]{2,}[！!？?]*\s*/g, '，');
  s = s.replace(/[！!]{2,}/g, '！');
  s = s.replace(/[？?]{2,}/g, '？');
  s = s.replace(/…{2,}|\.{3,}/g, '，');
  s = s.replace(/\r?\n+/g, '，');

  // Prevent unnatural TTS stuttering from stacked modal particles / interjections (keep at most 1):
  // 1) Repeated identical interjections (呜呜呜 -> 呜, 啊啊啊 -> 啊, 喵喵 -> 喵)
  s = s.replace(/([呜哇啊呀哦噢嗯呃唉哎嘛啦呢吧哟咯呐喵])\1+/g, '$1');
  // 2) Mixed opening/standalone interjection stacks (呜哇啊啊 -> 哇, 哎呀呀 -> 呀, 呜啊啊 -> 呜)
  s = s.replace(/(?:^|(?<=[，,。！？!?\s]))[呜哇啊呀哦噢呃唉哎]{2,}(?=$|[，,。！？!?~～\s])/g, (m) =>
    m.includes('哇') ? '哇' : m[0]
  );
  // 3) Sentence-ending stacked particles before 喵 (处刑啊喵！ -> 处刑喵！, 开心啦喵~ -> 开心喵~)
  s = s.replace(/[呜哇啊呀哦噢嘛啦呢吧哟咯呐]+(?=喵(?:$|[，,。！？!?~～\s]))/g, '');
  // 4) Other sentence-ending stacked particles (好委屈啊呜！ -> 好委屈啊！, 真的呀哦~ -> 真的呀~)
  s = s.replace(/([呜哇啊呀哦噢嘛啦呢吧哟咯呐])[呜哇啊呀哦噢嘛啦呢吧哟咯呐]+(?=$|[，,。！？!?~～\s])/g, '$1');

  s = s.replace(/[，,]{2,}/g, '，');
  s = s.replace(/\s+/g, ' ').trim();
  // Trim dangling punctuation
  s = s.replace(/^[，,、。.\s]+/, '').trim();
  return s.slice(0, Math.max(10, Number(maxChars) || 120));
}

/**
 * Decide whether a plain text reply is suitable for spontaneous situational voice
 * (short, spoken conversational style — never long explanations, lists, URLs, or code).
 */
export function isGoodForSpontaneousVoice(displayText, maxChars = 65) {
  const raw = String(displayText || '').trim();
  if (!raw) return false;
  if (/```|https?:\/\/|[a-zA-Z]:\\|^\s*[-*•\d]+[.)、]\s/m.test(raw)) return false;
  const cleaned = sanitizeVoiceText(raw, maxChars + 20);
  if (cleaned.length < 4 || cleaned.length > maxChars) return false;
  // Require at least 3 CJK/letter characters (skip pure punctuation/emojis)
  const spokenChars = (cleaned.match(/[\u4e00-\u9fa5a-zA-Z]/g) || []).length;
  return spokenChars >= 3;
}

export function hasSpontaneousVoiceCue({ displayText = '', emotion = '平静', hasExplicitEmotion = false } = {}) {
  if (hasExplicitEmotion && emotion && emotion !== '平静') return true;
  return /(?:早安|晚安|午安|好梦|想你|爱你|喜欢你|贴贴|抱抱|摸摸|辛苦啦|辛苦了|哼哼|呜呜|委屈|撒娇|开心|太棒啦|最棒|喵~|喵！)/i.test(
    String(displayText || '')
  );
}
