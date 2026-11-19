// Minimal HTTP plumbing shared by the API modules: body reading, JSON and
// buffer replies, and the per-reply request id. No framework, no deps.

import type { IncomingMessage, ServerResponse } from "node:http";
import { nextRequestId } from "./util.ts";

export function readBody(req: IncomingMessage, maxBytes = 64 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function sendJson(
  res: ServerResponse,
  status: number,
  value: unknown,
  extraHeaders?: Record<string, string>,
): void {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "x-github-request-id": nextRequestId(),
    "content-length": body.length,
    ...extraHeaders,
  });
  res.end(body);
}

export function sendBuffer(
  res: ServerResponse,
  status: number,
  body: Buffer,
  contentType: string,
  extraHeaders?: Record<string, string>,
): void {
  res.writeHead(status, {
    "content-type": contentType,
    "x-github-request-id": nextRequestId(),
    "content-length": body.length,
    ...extraHeaders,
  });
  res.end(body);
}

export function jsonError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message, documentation_url: "https://docs.github.com/rest" });
}

export function splitPath(pathname: string): string[] {
  return pathname
    .split("/")
    .filter((s) => s.length > 0)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
}

export function parseQuery(rawUrl: string): { pathname: string; query: URLSearchParams } {
  const q = rawUrl.indexOf("?");
  const pathname = q >= 0 ? rawUrl.slice(0, q) : rawUrl;
  const query = new URLSearchParams(q >= 0 ? rawUrl.slice(q + 1) : "");
  return { pathname, query };
}

export function parseJsonBody(buf: Buffer | null): Record<string, unknown> | null {
  if (!buf || buf.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(buf.toString("utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}
