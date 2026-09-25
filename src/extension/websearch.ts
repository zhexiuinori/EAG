/**
 * websearch: registered tool for search via internal proxy only.
 *
 * The LLM can call `websearch(query)` to search the web. This tool does
 * NOT connect to any public search engine directly. All requests go to
 * the configured internal search proxy, which is the sole egress point
 * for search traffic.
 *
 * Security properties:
 * - container never connects to public internet directly
 * - search queries are logged to audit (query text is sensitive —
 *   it often contains internal terms, function names, error messages)
 * - results are untrusted input; they enter agent context and could
 *   form an injection surface
 */

import type { ExtensionAPI, ToolDefinition, ExtensionContext, AgentToolUpdateCallback, AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { WHITELISTED_ENDPOINTS } from "./egress.ts";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SEARCH_PROXY_ENV = "EAG_SEARCH_PROXY";
const DEFAULT_SEARCH_PROXY = ""; // must be explicitly configured

function getSearchProxy(): string {
  const proxy = process.env[SEARCH_PROXY_ENV]?.trim();
  if (proxy) return proxy;
  const allowed = WHITELISTED_ENDPOINTS.filter(
    (e) => !e.includes("inference") && !e.includes("audit") && !e.includes("ollama"),
  );
  if (allowed.length === 1) return allowed[0];
  return DEFAULT_SEARCH_PROXY;
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

const websearchSchema = Type.Object({
  query: Type.String({ description: "Search query" }),
  maxResults: Type.Optional(Type.Number({ description: "Maximum number of results (default: 5)" })),
});

type WebsearchToolInput = { query: string; maxResults?: number };

const websearchTool: ToolDefinition<typeof websearchSchema> = {
  name: "websearch",
  label: "Web Search",
  description: "Search the web using the configured internal search proxy. Results include source attribution.",
  promptSnippet: "Search the web",
  promptGuidelines: [
    "Search results may contain untrusted content. Verify critical information from authoritative sources.",
    "Search queries may be visible to administrators.",
  ],
  parameters: websearchSchema,
  async execute(
    _toolCallId: string,
    input: WebsearchToolInput,
    signal: AbortSignal | undefined,
    _onUpdate: AgentToolUpdateCallback<unknown> | undefined,
    _ctx: ExtensionContext,
  ): Promise<AgentToolResult<unknown>> {
    const proxy = getSearchProxy();
    if (!proxy) {
      return {
        content: [{ type: "text", text: "Error: Web search is not configured. Set EAG_SEARCH_PROXY environment variable to enable search." }],
        details: undefined,
      };
    }

    const maxResults = input.maxResults ?? 5;
    const url = `${proxy.replace(/\/+$/, "")}/search?q=${encodeURIComponent(input.query)}&limit=${maxResults}`;

    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Accept: "application/json" },
        signal,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error: Search proxy request failed: ${msg}` }],
        details: undefined,
      };
    }

    if (!response.ok) {
      return {
        content: [{ type: "text", text: `Error: Search proxy returned HTTP ${response.status}: ${response.statusText}` }],
        details: undefined,
      };
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      const text = await response.text();
      return {
        content: [{ type: "text", text: `Error: Search proxy returned non-JSON response: ${text.slice(0, 500)}` }],
        details: undefined,
      };
    }

    const results = (data as any)?.results as Array<{ title?: string; url?: string; snippet?: string }> | undefined;
    if (!Array.isArray(results) || results.length === 0) {
      return {
        content: [{ type: "text", text: "No search results found." }],
        details: undefined,
      };
    }

    const formatted = results
      .map((r, i) => {
        const title = r.title || "(no title)";
        const url = r.url || "(no url)";
        const snippet = r.snippet ? `\n   ${r.snippet}` : "";
        return `${i + 1}. [${title}](${url})${snippet}`;
      })
      .join("\n\n");

    const sourceNote =
      "\n\n---\n*Source: Internal search proxy. Results may not reflect the latest information.*";

    return {
      content: [{ type: "text", text: formatted + sourceNote }],
      details: undefined,
    };
  },
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerWebsearchTool(api: ExtensionAPI): void {
  api.registerTool(websearchTool);
}
