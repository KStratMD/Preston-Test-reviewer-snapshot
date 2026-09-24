/**
 * Utility helpers for working with JSON embedded in LLM responses or free-form text.
 */

const OPENING_TO_CLOSING: Record<string, string> = {
  "{": "}",
  "[": "]",
};

export function stripMarkdownCodeFences(text: string): string {
  return text.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
}

function extractJsonSnippet(raw: string): string | null {
  const text = raw.trim();
  let start = -1;
  const stack: string[] = [];
  let inString = false;
  let stringChar = "";
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === stringChar) {
        inString = false;
        stringChar = "";
      }
      continue;
    }

    if (char === "\"" || char === "'") {
      inString = true;
      stringChar = char;
      continue;
    }

    const closing = OPENING_TO_CLOSING[char];
    if (closing) {
      if (start === -1) {
        start = i;
      }
      stack.push(closing);
      continue;
    }

    if (stack.length > 0 && char === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0 && start !== -1) {
        return text.slice(start, i + 1);
      }
    }
  }

  return null;
}

export function parseJsonFromText<T = unknown>(content: string): T | null {
  const cleaned = stripMarkdownCodeFences(content);
  const snippet = extractJsonSnippet(cleaned);
  if (!snippet) {
    return null;
  }

  try {
    return JSON.parse(snippet) as T;
  } catch {
    return null;
  }
}
