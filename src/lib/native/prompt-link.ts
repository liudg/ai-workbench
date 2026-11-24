// 外部深层链接或命令行传入草稿的安全净化：
// 剥离零宽、控制、BiDi 方向覆盖/隔离与 Plane 14 标签/变体选择符等隐藏字符（保留合法 Emoji ZWJ 序列），
// 限制最大长度（8,000 字符），拦截仅含隐藏字符的载荷，并提供覆盖未发送草稿前的确认判断。
// 外部传入的提示词只允许写入作曲栏草稿，严禁自动发送执行。

export const MAX_PROMPT_LINK_LENGTH = 8_000;

const EXTENDED_PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const EMOJI_MODIFIER = /\p{Emoji_Modifier}/u;
const KEYCAP_BASE = /^[#*0-9]$/;

export type SanitizePromptOutcome =
  | {
      ok: true;
      prompt: string;
      hiddenCharactersRemoved: number;
      truncated: boolean;
    }
  | {
      ok: false;
      reason: "empty" | "only-hidden";
      hiddenCharactersRemoved: number;
    };

function isBaseHiddenCodePoint(cp: number): boolean {
  // C0 控制字符（保留 \t 0x09、\n 0x0A、\r 0x0D）
  if (cp <= 0x0008 || (cp >= 0x000b && cp <= 0x000c) || (cp >= 0x000e && cp <= 0x001f)) {
    return true;
  }
  // DEL 与 C1 控制字符
  if (cp >= 0x007f && cp <= 0x009f) {
    return true;
  }
  // 软连字符、组合字形连接符、阿拉伯字母标记
  if (cp === 0x00ad || cp === 0x034f || cp === 0x061c) {
    return true;
  }
  // 不可见填充符与自由变体选择符（谚文、高棉语、蒙古语）
  if (
    (cp >= 0x115f && cp <= 0x1160) ||
    (cp >= 0x17b4 && cp <= 0x17b5) ||
    (cp >= 0x180b && cp <= 0x180e) ||
    cp === 0x3164 ||
    cp === 0xffa0
  ) {
    return true;
  }
  // 零宽空格、零宽非连接符、LRM、RLM（U+200D ZWJ 单独按 Emoji 上下文判断）
  if (cp === 0x200b || cp === 0x200c || cp === 0x200e || cp === 0x200f) {
    return true;
  }
  // BiDi 嵌入与强制覆盖（LRE、RLE、PDF、LRO、RLO）
  if (cp >= 0x202a && cp <= 0x202e) {
    return true;
  }
  // 词连接符、不可见算符、BiDi 隔离符（LRI、RLI、FSI、PDI）与废弃格式控制符
  if (cp >= 0x2060 && cp <= 0x206f) {
    return true;
  }
  // 变体选择符 VS1..VS14（VS15/VS16 单独按 Emoji/Keycap 上下文判断）
  if (cp >= 0xfe00 && cp <= 0xfe0d) {
    return true;
  }
  // BOM / 零宽不换行空格与行间注解锚点
  if (cp === 0xfeff || (cp >= 0xfff9 && cp <= 0xfffb)) {
    return true;
  }
  // 速记与乐谱不可见格式控制符
  if ((cp >= 0x1bca0 && cp <= 0x1bca3) || (cp >= 0x1d173 && cp <= 0x1d17a)) {
    return true;
  }
  // Plane 14 标签字符与补充变体选择符（\u{E0000}-\u{E0FFF}）
  if (cp >= 0xe0000 && cp <= 0xe0fff) {
    return true;
  }
  return false;
}

function isValidEmojiPresentationSelector(chars: readonly string[], index: number): boolean {
  if (index === 0) return false;
  const prev = chars[index - 1]!;
  return EXTENDED_PICTOGRAPHIC.test(prev) || KEYCAP_BASE.test(prev);
}

function isValidEmojiZwj(chars: readonly string[], index: number): boolean {
  if (index === 0 || index + 1 >= chars.length) return false;
  const next = chars[index + 1]!;
  if (!EXTENDED_PICTOGRAPHIC.test(next)) return false;

  const prev = chars[index - 1]!;
  if (EXTENDED_PICTOGRAPHIC.test(prev)) return true;

  const prevCp = prev.codePointAt(0) ?? 0;
  if ((prevCp === 0xfe0f || EMOJI_MODIFIER.test(prev)) && index >= 2) {
    return EXTENDED_PICTOGRAPHIC.test(chars[index - 2]!);
  }
  return false;
}

interface GraphemeSegmenter {
  segment(input: string): Iterable<{ segment: string }>;
}

interface IntlWithSegmenter {
  Segmenter?: new (
    locales?: string | string[],
    options?: { granularity?: "grapheme" | "word" | "sentence" },
  ) => GraphemeSegmenter;
}

function truncateGraphemeSafe(input: string, maxLength: number): { text: string; truncated: boolean } {
  if (input.length <= maxLength) {
    return { text: input, truncated: false };
  }
  const SegmenterCtor = typeof Intl !== "undefined" ? (Intl as unknown as IntlWithSegmenter).Segmenter : undefined;
  if (typeof SegmenterCtor === "function") {
    const segmenter = new SegmenterCtor(undefined, { granularity: "grapheme" });
    let out = "";
    for (const { segment } of segmenter.segment(input)) {
      if (out.length + segment.length > maxLength) {
        return { text: out, truncated: true };
      }
      out += segment;
    }
    return { text: out, truncated: out.length < input.length };
  }

  let out = "";
  for (const ch of input) {
    if (out.length + ch.length > maxLength) {
      break;
    }
    out += ch;
  }
  // 防止降级分支把 Emoji ZWJ 截断在悬挂的 U+200D 上
  while (out.endsWith("\u200D")) {
    out = out.slice(0, -1);
  }
  return { text: out, truncated: true };
}

/** 剥离隐藏与控制字符、保留合法 Emoji ZWJ，并限制最大长度。 */
export function sanitizePromptLink(raw: string): SanitizePromptOutcome {
  if (!raw) {
    return { ok: false, reason: "empty", hiddenCharactersRemoved: 0 };
  }

  const normalizedNewlines = raw.replace(/\r\n?/g, "\n");
  const chars = Array.from(normalizedNewlines);
  const kept: string[] = [];
  let hiddenCharactersRemoved = 0;

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    const cp = ch.codePointAt(0) ?? 0;

    if (cp === 0x200d) {
      if (isValidEmojiZwj(chars, i)) {
        kept.push(ch);
      } else {
        hiddenCharactersRemoved += 1;
      }
      continue;
    }

    if (cp === 0xfe0e || cp === 0xfe0f) {
      if (isValidEmojiPresentationSelector(chars, i)) {
        kept.push(ch);
      } else {
        hiddenCharactersRemoved += 1;
      }
      continue;
    }

    if (isBaseHiddenCodePoint(cp)) {
      hiddenCharactersRemoved += 1;
      continue;
    }

    kept.push(ch);
  }

  const joined = kept.join("");
  if (joined.trim().length === 0) {
    return {
      ok: false,
      reason: hiddenCharactersRemoved > 0 ? "only-hidden" : "empty",
      hiddenCharactersRemoved,
    };
  }

  const { text, truncated } = truncateGraphemeSafe(joined, MAX_PROMPT_LINK_LENGTH);
  if (text.trim().length === 0) {
    return {
      ok: false,
      reason: hiddenCharactersRemoved > 0 ? "only-hidden" : "empty",
      hiddenCharactersRemoved,
    };
  }

  return {
    ok: true,
    prompt: text,
    hiddenCharactersRemoved,
    truncated,
  };
}

export function formatHiddenCharactersWarning(count: number, truncated = false): string {
  const base = `检测到并移除了 ${count} 个隐藏字符，发送前请仔细核对内容`;
  return truncated ? `${base}（超出 8,000 字的部分已截断）` : base;
}

/** 目标草稿已有非空且不同于传入提示词的未发送内容时，必须先经用户确认才能覆盖。 */
export function shouldConfirmDraftOverwrite(existingText: string, incomingPrompt: string): boolean {
  return existingText.trim().length > 0 && existingText !== incomingPrompt;
}
