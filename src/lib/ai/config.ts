/* Central provider registry and role -> provider/model resolution for the Research Agent
 * pipeline (ARCHITECTURE.md §4, §5.3 rule 2: "All env access through one config.ts. Never
 * process.env scattered through roles."). Every AI module asks this file for a resolved
 * connection; nothing else reads a provider env var directly.
 *
 * Two kinds of "not configured" resolve to null the same way, deliberately: an unset role
 * mapping (CARIBECON_<ROLE>_PROVIDER / _MODEL) and an unset provider connection (its base URL
 * or API key) are both just "cannot proceed," never a guess. This is the project's existing
 * fail-closed rule (api/research.ts's CARIBECON_RESEARCH_TOKEN check) applied to model config:
 * missing configuration is a 503 at request start, not a runtime surprise (ARCHITECTURE.md §1
 * item 5's "fail closed" vs "degrade" split).
 *
 * Base URLs are NOT hardcoded for Nebius or MiniMax. This project's rule — "do not invent or
 * hard-code a model ID for a new provider route; it must be explicitly configured and
 * live-validated" — applies with equal force to an endpoint URL: a wrong-but-plausible base URL
 * is worse than an honest 503, because it can silently send a request, and a credential, to the
 * wrong host. NoInfra is the one exception: its base URL was directly verified against the live
 * gateway during the Phase 0b spike (docs/NOINFRA_SPIKE.md — "api": "openai-completions" in its
 * own model config) and is pre-filled as a default, still overridable via NOINFRA_BASE_URL.
 */

export type Role = 'interpret' | 'plan' | 'synthesis' | 'verify' | 'newsExtract';
export const ROLES: readonly Role[] = ['interpret', 'plan', 'synthesis', 'verify', 'newsExtract'];

export type ProviderName = 'nebius' | 'minimax' | 'noinfra';
// Impala is added here once access lands and its API shape is confirmed OpenAI-compatible
// (ARCHITECTURE.md §4.3) — either a registry entry like these, or its own small adapter.

interface ProviderRegistryEntry {
  baseUrlEnv: string;
  apiKeyEnv: string;
  /* Only ever set for a base URL this project has actually verified live — see the file header.
     Absence is the normal, expected state for a provider whose URL has not been confirmed. */
  verifiedDefaultBaseUrl?: string;
}

const PROVIDER_REGISTRY: Record<ProviderName, ProviderRegistryEntry> = {
  nebius: { baseUrlEnv: 'NEBIUS_BASE_URL', apiKeyEnv: 'NEBIUS_API_KEY' },
  minimax: { baseUrlEnv: 'MINIMAX_BASE_URL', apiKeyEnv: 'MINIMAX_API_KEY' },
  noinfra: {
    baseUrlEnv: 'NOINFRA_BASE_URL',
    apiKeyEnv: 'NOINFRA_API_KEY',
    // Confirmed live 2026-08-17 against the real gateway (docs/NOINFRA_SPIKE.md).
    verifiedDefaultBaseUrl: 'https://inference.noinfra.ai/v1',
  },
};

function isKnownProvider(name: string): name is ProviderName {
  return name in PROVIDER_REGISTRY;
}

export interface ResolvedProvider {
  name: ProviderName;
  baseUrl: string;
  apiKey: string;
}

/* A provider's ready-to-call connection details, or null if either half is missing. Never falls
   back to a guessed value for Nebius/MiniMax — only NoInfra has a verified default, and even
   that stays overridable. */
export function resolveProvider(name: string): ResolvedProvider | null {
  if (!isKnownProvider(name)) return null;
  const entry = PROVIDER_REGISTRY[name];
  const baseUrl = process.env[entry.baseUrlEnv] || entry.verifiedDefaultBaseUrl;
  const apiKey = process.env[entry.apiKeyEnv];
  if (!baseUrl || !apiKey) return null;
  return { name, baseUrl, apiKey };
}

export interface RoleConfig {
  role: Role;
  provider: ProviderName;
  model: string;
}

/* Which provider+model serves a role, read from CARIBECON_<ROLE>_PROVIDER /
   CARIBECON_<ROLE>_MODEL. The model is whatever string is configured — this function does not
   validate it names a real model on that provider; that is what "live-validated" means, and it
   happens by the call actually succeeding, not by a guess baked in here. */
export function resolveRole(role: Role): RoleConfig | null {
  const provider = process.env[`CARIBECON_${role.toUpperCase()}_PROVIDER`];
  const model = process.env[`CARIBECON_${role.toUpperCase()}_MODEL`];
  if (!provider || !model || !isKnownProvider(provider)) return null;
  return { role, provider, model };
}

export interface ResolvedRole extends RoleConfig {
  connection: ResolvedProvider;
}

/* The one function most callers actually want: a role's provider+model AND a ready-to-call
   connection, or null if any link in that chain is unconfigured. */
export function resolveRoleFully(role: Role): ResolvedRole | null {
  const roleConfig = resolveRole(role);
  if (!roleConfig) return null;
  const connection = resolveProvider(roleConfig.provider);
  if (!connection) return null;
  return { ...roleConfig, connection };
}

// ── Phase 3 budget constants (ARCHITECTURE.md §7) ──────────────────────────────────────────
// Starting points only what Phase 3's own code needs — not the full §7 shared-deadline object.

export const MAX_PLAN_STEPS = 8; // ARCHITECTURE.md §7 starting point — plan truncated, not rejected
export const MAX_TAVILY_SEARCHES = 2; // ARCHITECTURE.md §7 starting point
export const MAX_TAVILY_EXTRACTS = 3; // ARCHITECTURE.md §7 starting point
export const MAX_EXTRACT_CHARS = 6_000; // ARCHITECTURE.md §7 starting point — per-URL cap
export const MAX_EXTRACT_TOTAL = 15_000; // ARCHITECTURE.md §7 starting point — total cap across extracts
// New, independent Phase-3 addition for the news-digest path (2h) — NOT shared with the Tavily
// constants above, since this path is a plain HTTP fetch, not Tavily; kept small because each
// digest is an extra model call.
export const MAX_NEWS_DIGESTS = 2;
