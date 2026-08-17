/* Types for service.mjs, which stays plain JavaScript so it can run unmodified on any runtime
   with no build step (§5.3 rule 1). This declaration is what lets a TypeScript Vercel function
   import the very same file the NoInfra MCP adapter imports. */

export declare const DEFAULT_RUNTIME: 'noinfra';

export declare class InvalidRequestError extends Error {}

export interface ResearchStubResult {
  ok: true;
  service: 'caribecon-research';
  runtime: string;
}

export declare function research(
  request?: { question?: unknown },
  options?: { runtime?: string },
): Promise<ResearchStubResult>;
