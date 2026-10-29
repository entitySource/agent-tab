#!/usr/bin/env node
/**
 * Agent Tab MCP server: lets any MCP-capable agent (Claude Desktop, Cursor, custom
 * harnesses) call paid APIs through a tab without ever seeing a payment credential.
 *
 * Env: TAB_SERVICE_URL, TAB_ID, TAB_TOKEN
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createTabClient, TabDeniedError } from "@agent-tab/client";

const tabServiceUrl = process.env.TAB_SERVICE_URL ?? "http://localhost:4100";
const tabId = process.env.TAB_ID ?? "";
const tabToken = process.env.TAB_TOKEN ?? "";
if (!tabId || !tabToken) {
  console.error("[agent-tab-mcp] TAB_ID and TAB_TOKEN are required");
  process.exit(1);
}

const paidFetch = createTabClient({
  tabServiceUrl, tabId, tabToken,
  onApprovalNeeded: ({ approval_id, quote }) => console.error(`[agent-tab-mcp] waiting for human approval ${approval_id} ($${quote.price})`),
});

const server = new McpServer({ name: "agent-tab", version: "0.1.0" });

server.tool(
  "paid_fetch",
  "Fetch a URL that may require payment (HTTP 402). The tab service enforces the human's spending policy; denied calls return the reason instead of data.",
  { url: z.string().url(), method: z.enum(["GET", "POST"]).default("GET"), body: z.string().optional() },
  async ({ url, method, body }) => {
    try {
      const res = await paidFetch(url, { method, body, headers: body ? { "content-type": "application/json" } : undefined });
      const text = (await res.text()).slice(0, 20_000);
      return { content: [{ type: "text", text: `HTTP ${res.status}\n${text}` }] };
    } catch (err) {
      if (err instanceof TabDeniedError) {
        return { isError: true, content: [{ type: "text", text: `DENIED (${err.reason}): the spending policy does not allow this call. Do not retry; tell the user.` }] };
      }
      throw err;
    }
  },
);

server.tool(
  "tab_status",
  "Show the current tab: spent, outstanding, settlements, blocked attempts, and the policy limits.",
  {},
  async () => {
    const r = await fetch(`${tabServiceUrl}/tabs/${tabId}`, { headers: { authorization: `Bearer ${tabToken}` } });
    return { content: [{ type: "text", text: await r.text() }] };
  },
);

await server.connect(new StdioServerTransport());
