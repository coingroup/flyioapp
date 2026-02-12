import { applyPatch } from "fast-json-patch";

/**
 * NOTE: The MCP SDK has evolved quickly. The key idea here is:
 * - implement MCP over Streamable HTTP at /mcp
 * - provide tools: list_tools + call_tool
 *
 * If your installed @modelcontextprotocol/sdk exposes different transport helpers,
 * keep the tool logic exactly the same and swap the transport wiring.
 */

const N8N_BASE_URL = process.env.N8N_BASE_URL;              // e.g. https://coingroup.app.n8n.cloud
const N8N_API_KEY = process.env.N8N_API_KEY;                // n8n API key
const ALLOWED_WORKFLOW_IDS = (process.env.ALLOWED_WORKFLOW_IDS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || "";    // optional bearer auth for your MCP server

function assertEnv() {
  if (!N8N_BASE_URL) throw new Error("Missing N8N_BASE_URL");
  if (!N8N_API_KEY) throw new Error("Missing N8N_API_KEY");
  if (!ALLOWED_WORKFLOW_IDS.length) throw new Error("Missing ALLOWED_WORKFLOW_IDS");
}
assertEnv();

function isAllowed(workflowId) {
  return ALLOWED_WORKFLOW_IDS.includes(workflowId);
}

async function n8nFetch(path, { method = "GET", body } = {}) {
  const res = await fetch(`${N8N_BASE_URL}${path}`, {
    method,
    headers: {
      "X-N8N-API-KEY": N8N_API_KEY,
      "Content-Type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }

  if (!res.ok) {
    throw new Error(`n8n ${res.status}: ${typeof json === "string" ? json : JSON.stringify(json)}`);
  }
  return json;
}

// ----- Tool schema (what Claude sees) -----
const editWorkflowTool = {
  name: "edit_workflow",
  description: "Get and edit an allowlisted n8n workflow using JSON Patch (RFC6902). dry_run returns the full workflow JSON without writing; apply writes and returns updated JSON.",
  inputSchema: {
    type: "object",
    properties: {
      workflowId: { type: "string", description: "n8n workflow ID (must be allowlisted)" },
      mode: { type: "string", enum: ["dry_run", "apply"] },
      patch: {
        type: "array",
        description: "JSON Patch ops (RFC6902). Use [] for dry_run.",
        items: {
          type: "object",
          properties: {
            op: { type: "string", enum: ["add", "remove", "replace", "move", "copy", "test"] },
            path: { type: "string" },
            from: { type: "string" },
            value: {}
          },
          required: ["op", "path"],
          additionalProperties: true
        }
      }
    },
    required: ["workflowId", "mode", "patch"],
    additionalProperties: false
  }
};

async function handleEditWorkflow({ workflowId, mode, patch }) {
  if (!isAllowed(workflowId)) {
    return {
      ok: false,
      error: "NOT_ALLOWED",
      details: { workflowId }
    };
  }

  // 1) GET full workflow
  const workflow = await n8nFetch(`/api/v1/workflows/${workflowId}`, { method: "GET" });

  if (mode === "dry_run") {
    return {
      ok: true,
      workflowId,
      applied: false,
      workflow
    };
  }

  // 2) Apply patch
  const patched = applyPatch(structuredClone(workflow), patch, true, false).newDocument;

  // 3) PUT workflow
  await n8nFetch(`/api/v1/workflows/${workflowId}`, { method: "PUT", body: patched });

  return {
    ok: true,
    workflowId,
    applied: true,
    workflow: patched
  };
}

/**
 * Minimal Streamable HTTP MCP implementation:
 * - POST /mcp expects JSON-RPC messages
 * - Responds JSON-RPC
 *
 * Claude Desktop + mcp-remote can work with this shape.
 * If your MCP SDK provides a ready-made HTTP transport, swap this handler out.
 */
import http from "node:http";

function authOk(req) {
  if (!MCP_AUTH_TOKEN) return true;
  const h = req.headers["authorization"] || "";
  return h === `Bearer ${MCP_AUTH_TOKEN}`;
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url !== "/mcp") {
      res.writeHead(404); res.end("Not found"); return;
    }
    if (req.method !== "POST") {
      res.writeHead(405); res.end("Use POST"); return;
    }
    if (!authOk(req)) {
      res.writeHead(401); res.end("Unauthorized"); return;
    }

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    const msg = JSON.parse(raw);

    // MCP/JSON-RPC methods commonly used:
    // - initialize
    // - tools/list
    // - tools/call

    let result = null;

    if (msg.method === "initialize") {
      result = {
        protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
        serverInfo: { name: "n8n-mcp-server", version: "1.0.0" },
        capabilities: { tools: {} }
      };
    } else if (msg.method === "tools/list") {
      result = { tools: [editWorkflowTool] };
    } else if (msg.method === "tools/call") {
      const { name, arguments: args } = msg.params || {};
      if (name !== "edit_workflow") throw new Error(`Unknown tool: ${name}`);
      result = await handleEditWorkflow(args);
      // MCP expects content blocks sometimes; keep it simple but structured:
      result = {
        content: [
          { type: "text", text: JSON.stringify(result) }
        ]
      };
    } else {
      throw new Error(`Unsupported method: ${msg.method}`);
    }

    const reply = { jsonrpc: "2.0", id: msg.id ?? null, result };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(reply));

  } catch (e) {
    const err = {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32000, message: e?.message || String(e) }
    };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(err));
  }
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`MCP server listening on :${PORT} (POST /mcp)`);
});