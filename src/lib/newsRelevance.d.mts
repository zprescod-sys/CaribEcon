// Types for newsRelevance.mjs (plain-ESM module shared with scripts/build-feeds.mjs).
export function isRelevantNews(title: string, tags?: string[]): boolean;
export function isDisplayableNews(title: string, tags?: string[]): boolean;
export function assessNews(
  title: string,
  tags?: string[],
  context?: { businessFeed?: boolean },
): {
  decision: 'publish' | 'review' | 'drop';
  category: string;
  group: string;
  confidence: 'low' | 'weak' | 'medium' | 'high';
  reason: string;
};
export function classifyNews(
  title: string,
  tags?: string[],
): { category: string; group: string; confidence: 'low' | 'weak' | 'medium' | 'high' };
export function getNewsReviewDecision(
  title: string,
  tags?: string[],
  context?: { businessFeed?: boolean },
): { candidate: boolean; suggestedCategory: string; confidence: 'low' | 'weak' | 'medium' | 'high'; reason: string };
export const CONFIDENCE_RANK: Record<'low' | 'weak' | 'medium' | 'high', number>;
export const MIN_NEWS_CONFIDENCE: 'low' | 'weak' | 'medium' | 'high';
export const NEWS_CATEGORY_GROUPS: Readonly<Record<string, string>>;
export const NEWS_GROUPS: string[];
