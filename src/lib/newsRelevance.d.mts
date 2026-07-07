// Types for newsRelevance.mjs (plain-ESM module shared with scripts/build-feeds.mjs).
export function isRelevantNews(title: string, tags?: string[]): boolean;
export function classifyNews(
  title: string,
  tags?: string[],
): { category: string; group: string };
export const NEWS_GROUPS: string[];
