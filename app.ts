// The server: one HTTP listener, auth, routing, and the git smart-HTTP
// handlers (info/refs, upload-pack, receive-pack). REST, GraphQL and MCP
// live in their own modules; this file only wires them together.
//
// Hot paths and their caches (all invalidated by the store's generation):
// - clone: v2 advertisement (constant), ls-refs bytes, full fetch response
//   bytes per (wants, haves, shallow, depth) — 50 concurrent identical
//   clones share one pack build.
// - push: v0 receive-pack advertisement per generation.
// - read: single-issue JSON buffer per issue (see rest.ts).
// - write: no cache needed; issue creation is a map insert.

import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Store, isAncestor, type Repo } from "./store.ts";
import {
  buildFetchV0Response,
  buildFetchV2Response,
  buildLsRefsResponse,
  buildReceivePackResult,
  buildV0ReceiveAd,
  buildV0UploadAd,
  buildV2UploadAd,
  decodePktLines,
  parseReceivePackBody,
  planFetch,
  readPack,
  type AdRef,
  type PushCommand,
} from "./git.ts";
import { handleRest } from "./rest.ts";
import { handleGraphql } from "./graphql.ts";
import { handleMcp } from "./mcp.ts";
import { jsonError, parseQuery, readBody, sendBuffer, sendJson, splitPath } from "./http.ts";
import { VIEWER, ZERO_OID } from "./util.ts";

const V2_UPLOAD_AD = buildV2UploadAd();

function isAuthorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? "";
  if (token) return header === `Bearer ${token}`;
  return header.startsWith("Bearer ") && header.length > 7;
}

function repoFromPath(store: Store, owner: string, repoName: string): Repo | null {
  if (owner !== VIEWER.login) return null;
  return store.getRepo(owner, repoName) ?? null;
}

function adRefsOf(store: Store, repo: Repo): AdRef[] {
  return store.adRefs(repo);
}

function parseV2Command(body: Buffer): {
  command: string;
  args: Record<string, string[]>;
} | null {
  try {
    const { frames } = decodePktLines(body);
    let command = "";
    const args: Record<string, string[]> = {};
    let afterDelim = false;
    for (const frame of frames) {
      if (frame.kind === "flush") break;
      if (frame.kind === "delim") {
        afterDelim = true;
        continue;
      }
      if (frame.kind !== "data") continue;
      const text = frame.data.toString("utf8").replace(/\n$/, "");
      if (!afterDelim && text.startsWith("command=")) {
        command = text.slice("command=".length);
        continue;
      }
      const [key, ...rest] = text.split(" ");
      const value = rest.join(" ");
      (args[key] ??= []).push(value);
    }
    if (!command) return null;
    return { command, args };
  } catch {
    return null;
  }
}

function parseV0Fetch(body: Buffer): {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
} | null {
  try {
    const { frames } = decodePktLines(body);
    const wants: string[] = [];
    const haves: string[] = [];
    const shallow: string[] = [];
    let depth: number | null = null;
    for (const frame of frames) {
      // v0 sends a flush after the want lines and another after `done`;
      // neither ends the request, so keep collecting across them.
      if (frame.kind !== "data") continue;
      const text = frame.data.toString("utf8").replace(/\n$/, "");
      if (text.startsWith("want ")) wants.push(text.split(" ")[1] ?? "");
      else if (text.startsWith("have ")) haves.push(text.split(" ")[1] ?? "");
      else if (text.startsWith("shallow ")) shallow.push(text.slice(8).trim());
      else if (text.startsWith("deepen ")) {
        const n = Number(text.slice(7).trim());
        if (Number.isFinite(n)) depth = n;
      }
    }
    return { wants, haves, shallow, depth };
  } catch {
    return null;
  }
}

async function handleInfoRefs(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  repoName: string,
  service: string,
): Promise<boolean> {
  const repo = repoFromPath(store, owner, repoName);
  if (!repo) {
    jsonError(res, 404, "Not Found");
    return true;
  }
  if (service === "git-upload-pack") {
    const v2 = (req.headers["git-protocol"] ?? "") === "version=2";
    if (v2) {
      sendBuffer(res, 200, V2_UPLOAD_AD, "application/x-git-upload-pack-advertisement");
      return true;
    }
    if (!repo.v0UploadAd) repo.v0UploadAd = buildV0UploadAd(adRefsOf(store, repo));
    sendBuffer(res, 200, repo.v0UploadAd, "application/x-git-upload-pack-advertisement");
    return true;
  }
  if (service === "git-receive-pack") {
    if (!repo.v0ReceiveAd) repo.v0ReceiveAd = buildV0ReceiveAd(adRefsOf(store, repo));
    sendBuffer(res, 200, repo.v0ReceiveAd, "application/x-git-receive-pack-advertisement");
    return true;
  }
  jsonError(res, 400, `Unknown service ${service}`);
  return true;
}

async function handleUploadPack(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  repoName: string,
  body: Buffer,
): Promise<boolean> {
  const repo = repoFromPath(store, owner, repoName);
  if (!repo) {
    jsonError(res, 404, "Not Found");
    return true;
  }
  const v2 = (req.headers["git-protocol"] ?? "") === "version=2";
  const lookup = (oid: string) => repo.objects.get(oid);

  if (v2) {
    const parsed = parseV2Command(body);
    if (!parsed) {
      jsonError(res, 400, "Malformed upload-pack request");
      return true;
    }
    if (parsed.command === "ls-refs") {
      const peel = (parsed.args.peel ?? []).length > 0;
      const symrefs = (parsed.args.symrefs ?? []).length > 0;
      const unborn = (parsed.args.unborn ?? []).length > 0;
      const prefixes = parsed.args["ref-prefix"] ?? [];
      const cacheKey = `${repo.generation}|${peel}|${symrefs}|${unborn}|${prefixes.join(",")}`;
      let cached = repo.lsRefsCache.get(cacheKey);
      if (!cached) {
        const isEmpty = repo.refs.size === 0;
        cached = buildLsRefsResponse(
          adRefsOf(store, repo),
          { peel, symrefs, unborn, prefixes },
          `refs/heads/${repo.defaultBranch}`,
          isEmpty,
        );
        repo.lsRefsCache.set(cacheKey, cached);
      }
      sendBuffer(res, 200, cached, "application/x-git-upload-pack-result");
      return true;
    }
    if (parsed.command === "fetch") {
      const wants = parsed.args.want ?? [];
      const haves = parsed.args.have ?? [];
      const shallowList = parsed.args.shallow ?? [];
      const deepenRaw = parsed.args.deepen?.[0];
      const depth = deepenRaw != null ? Number(deepenRaw) : null;
      const cacheKey = `v2|${repo.generation}|${wants.join(",")}|${haves.join(",")}|${shallowList.join(",")}|${depth ?? ""}`;
      let cached = repo.fetchCache.get(cacheKey);
      if (!cached) {
        const plan = planFetch(lookup, wants, haves, new Set(shallowList), depth);
        const ack = haves.find((h) => repo.objects.has(h)) ?? null;
        cached = buildFetchV2Response(plan, ack, haves.length > 0);
        repo.fetchCache.set(cacheKey, cached);
      }
      sendBuffer(res, 200, cached, "application/x-git-upload-pack-result");
      return true;
    }
    jsonError(res, 400, `Unknown upload-pack command ${parsed.command}`);
    return true;
  }

  const parsed = parseV0Fetch(body);
  if (!parsed) {
    jsonError(res, 400, "Malformed upload-pack request");
    return true;
  }
  const cacheKey = `v0|${repo.generation}|${parsed.wants.join(",")}|${parsed.haves.join(",")}|${parsed.shallow.join(",")}|${parsed.depth ?? ""}`;
  let cached = repo.fetchCache.get(cacheKey);
  if (!cached) {
    const plan = planFetch(lookup, parsed.wants, parsed.haves, new Set(parsed.shallow), parsed.depth);
    const ack = parsed.haves.find((h) => repo.objects.has(h)) ?? null;
    cached = buildFetchV0Response(plan, ack);
    repo.fetchCache.set(cacheKey, cached);
  }
  sendBuffer(res, 200, cached, "application/x-git-upload-pack-result");
  return true;
}

async function handleReceivePack(
  store: Store,
  _req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  repoName: string,
  body: Buffer,
): Promise<boolean> {
  const repo = repoFromPath(store, owner, repoName);
  if (!repo) {
    jsonError(res, 404, "Not Found");
    return true;
  }
  let parsed: { commands: PushCommand[]; pack: Buffer | null };
  try {
    parsed = parseReceivePackBody(body);
  } catch {
    jsonError(res, 400, "Malformed receive-pack request");
    return true;
  }
  const { commands, pack } = parsed;
  if (pack) {
    try {
      // Thin packs delta against objects the server already holds; resolve
      // those bases from the repo, not just from the pack itself.
      const read = readPack(pack, { resolveBase: (oid) => repo.objects.get(oid) });
      for (const [oid, obj] of read.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
      }
    } catch {
      jsonError(res, 400, "Malformed packfile");
      return true;
    }
  }
  const results: Array<{ ref: string; ok: boolean; reason?: string }> = [];
  let changed = false;
  for (const cmd of commands) {
    const current = repo.refs.get(cmd.ref);
    if (cmd.newOid === ZERO_OID) {
      // Delete.
      if (!current) {
        results.push({ ref: cmd.ref, ok: false, reason: "remote ref does not exist" });
        continue;
      }
      if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) {
        results.push({ ref: cmd.ref, ok: false, reason: "non-fast-forward" });
        continue;
      }
      repo.refs.delete(cmd.ref);
      changed = true;
      results.push({ ref: cmd.ref, ok: true });
      continue;
    }
    if (!current) {
      // Create.
      if (cmd.oldOid !== ZERO_OID) {
        results.push({ ref: cmd.ref, ok: false, reason: "non-fast-forward" });
        continue;
      }
      if (!repo.objects.has(cmd.newOid)) {
        results.push({ ref: cmd.ref, ok: false, reason: "object not found" });
        continue;
      }
      repo.refs.set(cmd.ref, cmd.newOid);
      changed = true;
      results.push({ ref: cmd.ref, ok: true });
      continue;
    }
    // Update.
    if (cmd.oldOid !== current) {
      results.push({ ref: cmd.ref, ok: false, reason: "non-fast-forward" });
      continue;
    }
    if (!repo.objects.has(cmd.newOid)) {
      results.push({ ref: cmd.ref, ok: false, reason: "object not found" });
      continue;
    }
    if (!isAncestor(repo, current, cmd.newOid)) {
      results.push({ ref: cmd.ref, ok: false, reason: "non-fast-forward" });
      continue;
    }
    repo.refs.set(cmd.ref, cmd.newOid);
    changed = true;
    results.push({ ref: cmd.ref, ok: true });
  }
  if (changed) store.bump(repo);
  sendBuffer(res, 200, buildReceivePackResult(results), "application/x-git-receive-pack-result");
  return true;
}

async function dispatch(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  token: string,
): Promise<void> {
  const { pathname, query } = parseQuery(req.url ?? "/");
  const method = req.method ?? "GET";
  const segments = splitPath(pathname);

  if (pathname === "/healthz") {
    sendJson(res, 200, { ok: true });
    return;
  }
  if (!isAuthorized(req, token)) {
    jsonError(res, 401, "Bad credentials");
    return;
  }

  const needsBody = method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
  let body: Buffer | null = null;
  if (needsBody) {
    try {
      body = await readBody(req);
    } catch {
      jsonError(res, 400, "Could not read request body");
      return;
    }
  }

  // Git smart HTTP: /{owner}/{repo}.git/...
  if (
    segments.length >= 3 &&
    segments[1].endsWith(".git") &&
    (segments[2] === "info" || segments[2] === "git-upload-pack" || segments[2] === "git-receive-pack")
  ) {
    const owner = segments[0];
    const repoName = segments[1].slice(0, -".git".length);
    if (segments[2] === "info" && segments[3] === "refs" && method === "GET") {
      const service = query.get("service") ?? "";
      await handleInfoRefs(store, req, res, owner, repoName, service);
      return;
    }
    if (segments[2] === "git-upload-pack" && method === "POST") {
      await handleUploadPack(store, req, res, owner, repoName, body ?? Buffer.alloc(0));
      return;
    }
    if (segments[2] === "git-receive-pack" && method === "POST") {
      await handleReceivePack(store, req, res, owner, repoName, body ?? Buffer.alloc(0));
      return;
    }
    jsonError(res, 404, "Not Found");
    return;
  }

  // GraphQL v4.
  if (segments[0] === "api" && segments[1] === "graphql" && segments.length === 2) {
    if (method !== "POST") {
      jsonError(res, 405, "Method Not Allowed");
      return;
    }
    await handleGraphql({ store }, req, res, body);
    return;
  }

  // MCP.
  if (segments[0] === "mcp" && segments.length === 1) {
    if (method !== "POST") {
      jsonError(res, 405, "Method Not Allowed");
      return;
    }
    await handleMcp({ store }, req, res, body);
    return;
  }

  // REST v3 (fast path for the read workload first).
  if (segments[0] === "api" && segments[1] === "v3") {
    const restSegments = segments.slice(2);
    if (
      method === "GET" &&
      restSegments[0] === "repos" &&
      restSegments.length === 5 &&
      restSegments[3] === "issues" &&
      /^\d+$/.test(restSegments[4])
    ) {
      const { handleGetIssueFast } = await import("./rest.ts");
      handleGetIssueFast(
        { store },
        req,
        res,
        restSegments[1],
        restSegments[2],
        Number(restSegments[4]),
      );
      return;
    }
    const handled = await handleRest({ store }, req, res, method, restSegments, query, body);
    if (!handled) jsonError(res, 404, "Not Found");
    return;
  }

  jsonError(res, 404, "Not Found");
}

export function createServer(): Server {
  const store = new Store();
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? "";
  return createHttpServer((req, res) => {
    dispatch(req, res, store, token).catch((e: unknown) => {
      if (!res.headersSent) {
        jsonError(res, 500, e instanceof Error ? e.message : "Internal Server Error");
      } else {
        res.end();
      }
    });
  });
}
