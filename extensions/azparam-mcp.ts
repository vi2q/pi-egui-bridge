/**
 * AzParam MCP client for pi.
 *
 * Talks JSON-RPC over HTTP to the azparam core MCP server (the process
 * launched with `azparam --mcp-http=9315`, by default
 * http://127.0.0.1:9315/mcp). This lets the agent test engine/editor
 * commands (e.g. engine_set_entity_position) directly without driving the
 * harness GUI, while GUI-based verification (egui_* tools) still covers the
 * visual layer.
 *
 * Wire notes (azparam-mcp/src/mcp/http_transport.rs):
 * - every request must carry `mcp-method` matching body.method,
 * - `mcp-protocol-version` matching params._meta
 *   ["io.modelcontextprotocol/protocolVersion"],
 * - tools/call additionally requires `mcp-name` matching params.name,
 * - params._meta must include io.modelcontextprotocol/clientCapabilities
 *   (an empty object is accepted),
 * - protocol version pinned to MCP_PROTOCOL_VERSION ("2026-07-28").
 */
import { Type } from "typebox";

const MCP_PROTOCOL_VERSION = "2026-07-28";
const DEFAULT_URL = "http://127.0.0.1:9315/mcp";

let mcpUrl: string = process.env.AZPARAM_MCP_URL || DEFAULT_URL;
let nextRequestId = 1;

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: string;
  id: number;
  result?: unknown;
  error?: JsonRpcError;
}

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: unknown;
}

interface ToolContentText {
  type: string;
  text?: string;
}

function describeError(error: JsonRpcError): string {
  const data =
    error.data != null ? ` (data: ${JSON.stringify(error.data)})` : "";
  return `MCP error ${error.code}: ${error.message}${data}`;
}

async function mcpPost(
  method: string,
  params: Record<string, unknown>,
  toolName?: string,
): Promise<unknown> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
    "mcp-method": method,
    "mcp-protocol-version": MCP_PROTOCOL_VERSION,
  };
  if (toolName) headers["mcp-name"] = toolName;
  const body = {
    jsonrpc: "2.0",
    id: nextRequestId++,
    method,
    params: {
      ...params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
        "io.modelcontextprotocol/clientCapabilities": { tools: {} },
      },
    },
  };
  let response: Response;
  try {
    response = await fetch(mcpUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new Error(
      `azparam-mcp: request to ${mcpUrl} failed (${(error as Error).message}). Is the harness (core 'azparam --mcp-http=9315') running?`,
    );
  }
  const text = await response.text();
  let parsed: JsonRpcResponse;
  try {
    parsed = JSON.parse(text) as JsonRpcResponse;
  } catch {
    throw new Error(
      `azparam-mcp: non-JSON HTTP ${response.status} response: ${text.slice(0, 300)}`,
    );
  }
  if (parsed.error) throw new Error(describeError(parsed.error));
  return parsed.result;
}

function toolText(result: unknown): string {
  const content = (result as { content?: ToolContentText[] })?.content;
  if (!Array.isArray(content) || content.length === 0) {
    return JSON.stringify(result, null, 1);
  }
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
}

export default function register(pi: {
  registerTool: (tool: unknown) => void;
}) {
  pi.registerTool({
    name: "azparam_mcp_status",
    label: "AzParam MCP Status",
    description:
      "Report the azparam MCP server URL this extension will use and probe it with a tools/list call. Optionally set a new URL.",
    parameters: Type.Object({
      url: Type.Optional(
        Type.String({
          description:
            "Set the MCP endpoint (default http://127.0.0.1:9315/mcp; also overridable via AZPARAM_MCP_URL).",
        }),
      ),
    }),
    async execute(_id, params) {
      if (params.url) mcpUrl = params.url;
      try {
        const first = (await mcpPost("tools/list", {})) as {
          tools?: McpTool[];
          nextCursor?: string;
        };
        let count = first.tools?.length ?? 0;
        let cursor = first.nextCursor;
        while (cursor) {
          const page = (await mcpPost("tools/list", { cursor })) as {
            tools?: McpTool[];
            nextCursor?: string;
          };
          count += page.tools?.length ?? 0;
          cursor = page.nextCursor;
        }
        return {
          content: [
            {
              type: "text",
              text: `${mcpUrl}: reachable, ${count} tools available.`,
            },
          ],
          details: { url: mcpUrl, tools: count },
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `${mcpUrl}: unreachable (${(error as Error).message})`,
            },
          ],
          details: { url: mcpUrl },
        };
      }
    },
  });

  pi.registerTool({
    name: "azparam_mcp_list",
    label: "AzParam MCP Tools",
    description:
      "List the tool catalog exposed by the azparam core MCP server (auto-paginates all pages). Tool availability depends on the core's current app mode (editor / engine / editor2d / audio).",
    parameters: Type.Object({
      filter: Type.Optional(
        Type.String({
          description: "Substring filter on tool name (e.g. 'entity').",
        }),
      ),
    }),
    async execute(_id, params) {
      const tools: McpTool[] = [];
      let cursor: string | undefined;
      do {
        const page = (await mcpPost(
          "tools/list",
          cursor ? { cursor } : {},
        )) as {
          tools?: McpTool[];
          nextCursor?: string;
        };
        tools.push(...(page.tools ?? []));
        cursor = page.nextCursor;
      } while (cursor);
      const filtered = params.filter
        ? tools.filter((tool) => tool.name.includes(params.filter!))
        : tools;
      const text = filtered
        .map((tool) => `${tool.name}: ${tool.description ?? ""}`)
        .join("\n");
      return {
        content: [
          {
            type: "text",
            text:
              `${filtered.length}/${tools.length} tools:\n${text || "(no match)"}`,
          },
        ],
        details: { tools: filtered.map((tool) => tool.name) },
      };
    },
  });

  pi.registerTool({
    name: "azparam_mcp_call",
    label: "AzParam MCP Call",
    description:
      "Call a tool on the azparam core MCP server (e.g. engine_list_entities, engine_get_entity_info, engine_set_entity_position, get_object_detail). Returns the first text content block of the MCP result.",
    parameters: Type.Object({
      tool: Type.String({
        description: "Tool name as listed by azparam_mcp_list.",
      }),
      arguments: Type.Optional(
        Type.Unknown({
          description:
            "Tool arguments object. Note: entity_id must be a runtime entity UUID (from engine_list_entities), not an index.",
        }),
      ),
    }),
    async execute(_id, params) {
      // pi may deliver the `arguments` field as a JSON-encoded string
      // depending on the client serializer; accept both shapes.
      let args = params.arguments ?? {};
      if (typeof args === "string") {
        try {
          args = JSON.parse(args);
        } catch {
          throw new Error(`azparam_mcp_call: arguments is not valid JSON: ${args.slice(0, 100)}`);
        }
      }
      if (typeof args !== "object" || args === null || Array.isArray(args)) {
        throw new Error("azparam_mcp_call: arguments must be a JSON object");
      }
      const result = await mcpPost(
        "tools/call",
        {
          name: params.tool,
          arguments: args,
        },
        params.tool,
      );
      return {
        content: [{ type: "text", text: toolText(result) }],
        details: result as Record<string, unknown>,
      };
    },
  });
}
