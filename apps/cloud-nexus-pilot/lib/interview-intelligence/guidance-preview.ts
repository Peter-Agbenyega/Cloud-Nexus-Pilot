type JsonStringPrefix = { text: string; end: number; complete: boolean };

function readString(raw: string, start: number): JsonStringPrefix | null {
  if (raw[start] !== '"') return null;
  let text = "";
  for (let index = start + 1; index < raw.length; index += 1) {
    const character = raw[index]!;
    if (character === '"') return { text, end: index + 1, complete: true };
    if (character.charCodeAt(0) < 32) return null;
    if (character !== "\\") { text += character; continue; }
    const escape = raw[++index];
    if (escape === undefined) return { text, end: raw.length, complete: false };
    if (escape === "u") {
      const digits = raw.slice(index + 1, index + 5);
      if (digits.length < 4) return /^[a-f0-9]*$/i.test(digits) ? { text, end: raw.length, complete: false } : null;
      if (!/^[a-f0-9]{4}$/i.test(digits)) return null;
      text += String.fromCharCode(parseInt(digits, 16)); index += 4;
    } else {
      const escapes: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
      if (!(escape in escapes)) return null;
      text += escapes[escape];
    }
  }
  return { text, end: raw.length, complete: false };
}

function skipSpace(raw: string, start: number): number {
  let index = start;
  while (/\s/.test(raw[index] ?? "") && index < raw.length) index += 1;
  return index;
}

function valueEnd(raw: string, start: number): number | null {
  let depth = 0;
  for (let index = start; index < raw.length; index += 1) {
    const character = raw[index];
    if (character === '"') {
      const value = readString(raw, index);
      if (!value?.complete) return null;
      index = value.end - 1;
    } else if (depth === 0 && (character === "," || character === "}")) {
      try { JSON.parse(raw.slice(start, index)); return index; } catch { return null; }
    } else if (character === "{" || character === "[") depth += 1;
    else if (character === "}" || character === "]") depth -= 1;
    if (depth < 0) return null;
  }
  return null;
}

/** Read only the top-level speakNow string. A preview is provisional, never a final payload. */
export function extractGuidancePreview(input: string): string | null {
  if (input.length > 32_768) return null;
  const raw = input.trimStart().replace(/^```(?:json)?\s*/i, "");
  if (raw[0] !== "{") return null;
  let index = 1;
  while (index < raw.length) {
    index = skipSpace(raw, index);
    const key = readString(raw, index);
    if (!key?.complete) return null;
    index = skipSpace(raw, key.end);
    if (raw[index] !== ":") return null;
    index = skipSpace(raw, index + 1);
    if (key.text === "speakNow") {
      const value = readString(raw, index);
      if (!value) return null;
      // Do not flash half a word, a raw JSON escape, or an unfinished surrogate.
      const decoded = value.text.replace(/[\uD800-\uDBFF]$/, "");
      const text = (value.complete ? decoded : decoded.replace(/\S+$/, "")).trim().slice(0, 2400);
      return text && (value.complete || text.length >= 12) ? text : null;
    }
    const end = valueEnd(raw, index);
    if (end === null || raw[end] !== ",") return null;
    index = end + 1;
  }
  return null;
}
