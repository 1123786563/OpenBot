export const LINK_CODE =
  /\blink\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i;
export const LINK_CODES = new RegExp(LINK_CODE.source, "gi");
