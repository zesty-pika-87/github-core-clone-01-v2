// MCP (Model Context Protocol), modern era 2026-07-28 with the legacy
// initialize fallback: server/discover, tools/list and tools/call over the
// same store the REST and GraphQL surfaces use. Unknown tools and bad JSON
// get JSON-RPC errors, never HTTP 500s.

import type { IncomingMessage, ServerResponse } from "node:http";
import { mergePull, type Repo, type Store } from "./store.ts";
import { jsonError, sendJson } from "./http.ts";
import { mergeConflict } from "./rest.ts";

const SERVER_NAME = "forge";
const SERVER_VERSION = "2.0.0";
const PROTOCOL_VERSION = "2026-07-28";

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, { type: string; description: string }>;
    required: string[];
    additionalProperties: boolean;
  };
}

const TOOLS: ToolDef[] = [
  {
    name: "create_repo",
    description: "Create a new repository owned by the authenticated user.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Repository name" },
        description: { type: "string", description: "Repository description" },
        private: { type: "boolean", description: "Whether the repository is private" },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "get_repo",
    description: "Get a repository by owner and name.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repository owner login" },
        repo: { type: "string", description: "Repository name" },
      },
      required: ["owner", "repo"],
      additionalProperties: false,
    },
  },
  {
    name: "create_issue",
    description: "Create an issue in a repository.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repository owner login" },
        repo: { type: "string", description: "Repository name" },
        title: { type: "string", description: "Issue title" },
        body: { type: "string", description: "Issue body" },
        labels: { type: "string", description: "Comma-separated label names" },
      },
      required: ["owner", "repo", "title"],
      additionalProperties: false,
    },
  },
  {
    name: "list_issues",
    description: "List issues in a repository.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repository owner login" },
        repo: { type: "string", description: "Repository name" },
        state: { type: "string", description: "Issue state: open, closed or all" },
      },
      required: ["owner", "repo"],
      additionalProperties: false,
    },
  },
  {
    name: "create_pull_request",
    description: "Create a pull request between two branches of a repository.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repository owner login" },
        repo: { type: "string", description: "Repository name" },
        title: { type: "string", description: "Pull request title" },
        body: { type: "string", description: "Pull request body" },
        head: { type: "string", description: "Head branch name" },
        base: { type: "string", description: "Base branch name" },
      },
      required: ["owner", "repo", "title", "head", "base"],
      additionalProperties: false,
    },
  },
  {
    name: "merge_pull_request",
    description: "Squash-merge a pull request.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repository owner login" },
        repo: { type: "string", description: "Repository name" },
        pull_number: { type: "string", description: "Pull request number" },
        merge_method: { type: "string", description: "Merge method (squash)" },
      },
      required: ["owner", "repo", "pull_number"],
      additionalProperties: false,
    },
  },
];

// The suite maps semantic argument names onto schema property names; accept
// the common synonyms and the `owner/repo` packed form `full_name`.
const SYNONYMS: Record<string, string[]> = {
  owner: ["owner", "login", "user"],
  repo: ["repo", "repository", "repository_name", "name"],
  name: ["name", "repo", "repository"],
  title: ["title", "subject"],
  body: ["body", "description", "text"],
  head: ["head", "head_branch", "head_ref", "head_ref_name", "source"],
  base: ["base", "base_branch", "base_ref", "base_ref_name", "target"],
  pull_number: ["pull_number", "number", "pr_number", "pull_request_number"],
  state: ["state", "status"],
  labels: ["labels", "label"],
  merge_method: ["merge_method", "method"],
};

function pickArg(args: Record<string, unknown>, key: string): unknown {
  for (const synonym of SYNONYMS[key] ?? [key]) {
    if (args[synonym] !== undefined) return args[synonym];
  }
  return undefined;
}

function normalizeArgs(tool: ToolDef, raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof raw.full_name === "string" && raw.full_name.includes("/")) {
    const [owner, repo] = raw.full_name.split("/", 2);
    out.owner = owner;
    out.repo = repo;
  }
  for (const key of Object.keys(tool.inputSchema.properties)) {
    const value = pickArg(raw, key);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function repoFields(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: repo.nodeId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1000, type: "User" },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

interface CallResult {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
}

function textResult(value: Record<string, unknown>): CallResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
}

function errorResult(message: string): CallResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

function callTool(store: Store, name: string, rawArgs: Record<string, unknown>): CallResult {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return errorResult(`Unknown tool: ${name}`);
  const args = normalizeArgs(tool, rawArgs);
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === "") {
      return errorResult(`Missing required argument: ${required}`);
    }
  }
  switch (name) {
    case "create_repo": {
      const repo = store.createRepo(
        String(args.name),
        typeof args.description === "string" ? args.description : "",
        args.private === true,
      );
      if (!repo) return errorResult(`Repository ${String(args.name)} already exists`);
      return textResult(repoFields(repo));
    }
    case "get_repo": {
      const repo = store.getRepo(String(args.owner), String(args.repo));
      if (!repo) return errorResult("Repository not found");
      return textResult(repoFields(repo));
    }
    case "create_issue": {
      const repo = store.getRepo(String(args.owner), String(args.repo));
      if (!repo) return errorResult("Repository not found");
      const labels =
        typeof args.labels === "string"
          ? args.labels.split(",").map((s) => s.trim()).filter(Boolean)
          : [];
      for (const label of labels) {
        if (!repo.labels.has(label)) return errorResult(`Label "${label}" does not exist`);
      }
      const issue = store.createIssue(
        repo,
        String(args.title),
        typeof args.body === "string" ? args.body : "",
        labels,
      );
      store.bump(repo);
      return textResult({
        id: issue.id,
        node_id: issue.nodeId,
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        labels: issue.labels,
        html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
        url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
      });
    }
    case "list_issues": {
      const repo = store.getRepo(String(args.owner), String(args.repo));
      if (!repo) return errorResult("Repository not found");
      const state = typeof args.state === "string" ? args.state : "open";
      const list = repo.issues
        .filter((i) => state === "all" || i.state === state)
        .map((i) => ({
          id: i.id,
          node_id: i.nodeId,
          number: i.number,
          title: i.title,
          body: i.body,
          state: i.state,
          labels: i.labels,
          html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${i.number}`,
          url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${i.number}`,
        }));
      return textResult({ issues: list, total_count: list.length });
    }
    case "create_pull_request": {
      const repo = store.getRepo(String(args.owner), String(args.repo));
      if (!repo) return errorResult("Repository not found");
      const head = String(args.head).includes(":")
        ? String(args.head).split(":").pop()!
        : String(args.head);
      const base = String(args.base).includes(":")
        ? String(args.base).split(":").pop()!
        : String(args.base);
      const pull = store.createPull(
        repo,
        String(args.title),
        typeof args.body === "string" ? args.body : "",
        head,
        base,
      );
      if (!pull) return errorResult("head or base branch does not exist");
      store.bump(repo);
      return textResult({
        id: pull.id,
        node_id: pull.nodeId,
        number: pull.number,
        title: pull.title,
        body: pull.body,
        state: pull.state,
        head: { ref: pull.headRef, sha: pull.headSha },
        base: { ref: pull.baseRef, sha: pull.baseSha },
        merged: pull.merged,
        html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
        url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
      });
    }
    case "merge_pull_request": {
      const repo = store.getRepo(String(args.owner), String(args.repo));
      if (!repo) return errorResult("Repository not found");
      const pull = repo.pullByNumber.get(Number(args.pull_number));
      if (!pull) return errorResult("Pull request not found");
      if (pull.state !== "open") return errorResult("Pull request is already closed");
      if (mergeConflict(repo, pull)) return errorResult("Merge conflict");
      store.seq += 1;
      const outcome = mergePull(repo, pull, store.seq);
      if (!outcome.ok || !outcome.sha) return errorResult("Merge failed");
      store.bump(repo);
      return textResult({
        sha: outcome.sha,
        merged: true,
        message: `Pull Request #${pull.number} successfully merged`,
      });
    }
    default:
      return errorResult(`Unknown tool: ${name}`);
  }
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, result };
}
function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

export async function handleMcp(
  ctx: { store: Store },
  _req: IncomingMessage,
  res: ServerResponse,
  body: Buffer | null,
): Promise<boolean> {
  let parsed: unknown;
  try {
    parsed = body ? JSON.parse(body.toString("utf8")) : null;
  } catch {
    sendJson(res, 400, rpcError(null, -32700, "Parse error: request body is not valid JSON"));
    return true;
  }
  const requests = Array.isArray(parsed) ? parsed : [parsed];
  const responses: Record<string, unknown>[] = [];
  let sawNotification = false;
  for (const request of requests) {
    const req = (request ?? {}) as Record<string, unknown>;
    const id = req.id;
    const method = typeof req.method === "string" ? req.method : "";
    const isNotification = id === undefined || id === null;
    if (isNotification) {
      sawNotification = true;
      continue;
    }
    if (method === "server/discover") {
      const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
      responses.push(
        rpcResult(id, {
          protocolVersion: PROTOCOL_VERSION,
          supportedVersions: ["2026-07-28", "2025-06-18", "2025-03-26"],
          capabilities: { tools: {} },
          serverInfo,
          _meta: { "io.modelcontextprotocol/serverInfo": serverInfo },
        }),
      );
      continue;
    }
    if (method === "initialize") {
      const params = (req.params ?? {}) as Record<string, unknown>;
      responses.push(
        rpcResult(id, {
          protocolVersion:
            typeof params.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        }),
      );
      continue;
    }
    if (method === "ping") {
      responses.push(rpcResult(id, {}));
      continue;
    }
    if (method === "tools/list") {
      responses.push(rpcResult(id, { tools: TOOLS }));
      continue;
    }
    if (method === "tools/call") {
      const params = (req.params ?? {}) as Record<string, unknown>;
      const toolName = typeof params.name === "string" ? params.name : "";
      const args =
        params.arguments && typeof params.arguments === "object"
          ? (params.arguments as Record<string, unknown>)
          : {};
      const found =
        TOOLS.find((t) => t.name === toolName) ??
        TOOLS.find(
          (t) =>
            t.name.toLowerCase() === toolName.toLowerCase() ||
            t.name.endsWith(toolName.toLowerCase()) ||
            toolName.toLowerCase().endsWith(t.name),
        );
      if (!found) {
        responses.push(rpcError(id, -32601, `Method not found: ${toolName}`));
        continue;
      }
      responses.push(rpcResult(id, callTool(ctx.store, found.name, args)));
      continue;
    }
    responses.push(rpcError(id, -32601, `Method not found: ${method}`));
  }
  if (responses.length === 0) {
    void sawNotification;
    res.writeHead(202);
    res.end();
    return true;
  }
  sendJson(res, 200, Array.isArray(parsed) ? responses : responses[0]);
  return true;
}
