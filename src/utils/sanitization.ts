// Utility helpers for sanitizing user-provided strings

/**
 * Removes control characters from the supplied string.
 * Control characters include the ranges U+0000-U+001F and U+007F-U+009F.
 */
export const stripControlCharacters = (value: string): string => {
  let result = "";

  for (const char of value) {
    const code = char.charCodeAt(0);
    if ((code >= 0x20 && code <= 0x7e) || code > 0x9f) {
      result += char;
    }
  }

  return result;
};
