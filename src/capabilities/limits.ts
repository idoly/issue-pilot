export const MAX_BROWSER_ACTIONS = 50;
export const MAX_CAPABILITY_RESULT_BYTES = 1024 * 1024;
export const MAX_DATABASE_ROWS = 500;
export const MAX_ES_RESULTS = 200;
export const MAX_NACOS_DATA_IDS = 50;
export const MAX_REDIS_KEYS = 100;
export const MAX_REDIS_RESULTS = 500;
export const MAX_SLS_RESULTS = 200;

export function capabilityResultText(value: unknown): string {
  const text = JSON.stringify(value, null, 2);
  if (Buffer.byteLength(text) > MAX_CAPABILITY_RESULT_BYTES) throw new Error("capability_result_too_large");
  return text;
}
