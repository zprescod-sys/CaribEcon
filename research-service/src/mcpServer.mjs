/* MCP stdio adapter — the ONLY OpenClaw-facing surface of the Research Service.
 *
 * Why an MCP tool rather than an HTTP server: the NoInfra container exposes no inbound port to
 * the public internet, so a Node server started here is unreachable from Vercel. What IS
 * reachable is the OpenClaw gateway's /tools/invoke endpoint. Registering this process in
 * OpenClaw's `mcp.servers` config makes it a child process whose single tool is callable
 * through that endpoint — direct tool execution, with no agent reasoning loop in the path.
 *
 * That last property is the architectural point, not an implementation detail. ARCHITECTURE.md
 * §3.2/§5.2 require that OpenClaw "never become a second planner" — it starts and supervises
 * the service and must never decide what evidence to gather. Invoking a named tool with typed
 * arguments respects that boundary; routing through /v1/chat/completions (where OpenClaw's own
 * model decides whether and how to comply) would violate it. That endpoint stays disabled.
 *
 * This file is an ADAPTER and holds no research logic. Everything it does is: decode arguments,
 * call research(), encode the result. See service.mjs for why that separation is load-bearing.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { research, DEFAULT_RUNTIME, InvalidRequestError } from './service.mjs';

/* Reading the runtime label here — in the adapter — rather than inside research() is the §5.3
   rule 1 boundary in practice: the service stays unaware of where it runs, and the adapter is
   the one thing that knows. */
const RUNTIME = process.env.CARIBECON_RUNTIME || DEFAULT_RUNTIME;

/* The tool name. OpenClaw namespaces MCP tools by their `mcp.servers` key, so the name the
   gateway actually exposes is expected to be "<server key>__caribecon_research". That prefix is
   the gateway's to assign, not ours — the Vercel caller reads the full name from config rather
   than assuming it, and the first live invoke confirms it. */
export const TOOL_NAME = 'caribecon_research';

const server = new McpServer({ name: 'caribecon-research', version: '0.0.1' });

server.registerTool(
  TOOL_NAME,
  {
    title: 'CaribEcon research',
    description:
      'Phase 0b connectivity stub for the CaribEcon Research Service. Accepts a question and ' +
      'returns a fixed structured result. It performs NO retrieval, NO calculation and NO ' +
      'synthesis, and its response carries no figures or citations.',
    inputSchema: { question: z.string().min(1).describe('The research question.') },
    outputSchema: {
      ok: z.boolean(),
      service: z.string(),
      runtime: z.string(),
    },
  },
  async ({ question }) => {
    try {
      const result = await research({ question }, { runtime: RUNTIME });
      /* Both encodings, deliberately: `structuredContent` is the typed channel matching
         outputSchema, while `content` carries the same JSON as text for clients that only read
         the text block. We do not yet know which one OpenClaw's /tools/invoke surfaces, and a
         spike whose job is to prove a pipe should not fail on that guess. */
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result,
      };
    } catch (error) {
      if (error instanceof InvalidRequestError) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: error.message }) }],
          isError: true,
        };
      }
      throw error;
    }
  },
);

/* stdio only — this process must never open a port. It is reached exclusively as an OpenClaw
   child process, which is what keeps it off the public internet. */
const transport = new StdioServerTransport();
await server.connect(transport);
