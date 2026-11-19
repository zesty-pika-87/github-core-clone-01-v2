// Git on the wire: pkt-lines, object hashing and parsing, pack read/write,
// fetch planning (reachability, depth limits, shallow boundaries) and the
// upload-pack / receive-pack advertisements. Written from the kit's client
// parsers as the contract; nothing here copies another forge's code.

import { deflateSync, inflateSync } from "node:zlib";
import { sha1Hex, sha1Raw, VIEWER, ZERO_OID } from "./util.ts";

export type ObjType = "commit" | "tree" | "blob" | "tag";

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export interface CommitData {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export interface TagData {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

// ---------------------------------------------------------------- pkt-lines

export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  const len = body.length + 4;
  const head = Buffer.alloc(4);
  head.write(len.toString(16).padStart(4, "0"), "ascii");
  return Buffer.concat([head, body]);
}

export function pktFlush(): Buffer {
  return Buffer.from("0000", "ascii");
}

export function pktDelim(): Buffer {
  return Buffer.from("0001", "ascii");
}

export type PktFrame =
  | { kind: "flush" }
  | { kind: "delim" }
  | { kind: "data"; data: Buffer };

/** Decode a whole buffer of pkt-lines. Returns frames and the offset where
 *  the pkt-line stream ended (bytes after it, if any, are raw pack data). */
export function decodePktLines(buf: Buffer): { frames: PktFrame[]; endOffset: number } {
  const frames: PktFrame[] = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error("truncated pkt-line length");
    const head = buf.toString("ascii", off, off + 4);
    if (head === "0000") {
      frames.push({ kind: "flush" });
      off += 4;
      continue;
    }
    if (head === "0001") {
      frames.push({ kind: "delim" });
      off += 4;
      continue;
    }
    const len = parseInt(head, 16);
    if (!Number.isFinite(len) || len < 4 || off + len > buf.length) {
      throw new Error(`bad pkt-line length ${head}`);
    }
    frames.push({ kind: "data", data: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return { frames, endOffset: off };
}

// ------------------------------------------------------------------- objects

export function hashObject(type: ObjType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, "utf8");
  return sha1Hex(Buffer.concat([head, data]));
}

export function parseCommit(data: Buffer): CommitData {
  const text = data.toString("utf8");
  const split = text.indexOf("\n\n");
  const headerPart = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : "";
  const out: CommitData = { tree: "", parents: [], author: "", committer: "", message };
  for (const line of headerPart.split("\n")) {
    if (line.startsWith("tree ")) out.tree = line.slice(5).trim();
    else if (line.startsWith("parent ")) out.parents.push(line.slice(7).trim());
    else if (line.startsWith("author ")) out.author = line.slice(7);
    else if (line.startsWith("committer ")) out.committer = line.slice(10);
  }
  return out;
}

export function buildCommit(opts: {
  tree: string;
  parents: string[];
  message: string;
  epoch: number;
}): Buffer {
  const ident = `${VIEWER.name} <${VIEWER.email}> ${opts.epoch} +0000`;
  const lines: string[] = [`tree ${opts.tree}`];
  for (const p of opts.parents) lines.push(`parent ${p}`);
  lines.push(`author ${ident}`);
  lines.push(`committer ${ident}`);
  return Buffer.from(`${lines.join("\n")}\n\n${opts.message}`, "utf8");
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const space = data.indexOf(0x20, off);
    if (space < 0) break;
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    const mode = data.toString("ascii", off, space);
    const name = data.toString("utf8", space + 1, nul);
    const oid = data.subarray(nul + 1, nul + 21).toString("hex");
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = a.mode === "40000" ? `${a.name}/` : a.name;
    const kb = b.mode === "40000" ? `${b.name}/` : b.name;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, "utf8"));
    parts.push(Buffer.from(e.oid, "hex"));
  }
  return Buffer.concat(parts);
}

export function parseTag(data: Buffer): TagData {
  const text = data.toString("utf8");
  const split = text.indexOf("\n\n");
  const headerPart = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : "";
  const out: TagData = { object: "", type: "", tag: "", tagger: "", message };
  for (const line of headerPart.split("\n")) {
    if (line.startsWith("object ")) out.object = line.slice(7).trim();
    else if (line.startsWith("type ")) out.type = line.slice(5).trim();
    else if (line.startsWith("tag ")) out.tag = line.slice(4).trim();
    else if (line.startsWith("tagger ")) out.tagger = line.slice(7);
  }
  return out;
}

export function buildTag(opts: {
  object: string;
  type: string;
  tag: string;
  epoch: number;
}): Buffer {
  const ident = `${VIEWER.name} <${VIEWER.email}> ${opts.epoch} +0000`;
  return Buffer.from(
    `object ${opts.object}\ntype ${opts.type}\ntag ${opts.tag}\ntagger ${ident}\n\n${opts.tag}\n`,
    "utf8",
  );
}

// ---------------------------------------------------------------------- pack

const PACK_TYPE: Record<number, ObjType> = {
  1: "commit",
  2: "tree",
  3: "blob",
  4: "tag",
};

function readVarint(buf: Buffer, off: number): { value: number; next: number } {
  let value = buf[off] & 0x7f;
  let shift = 7;
  let i = off + 1;
  while (buf[off] & 0x80) {
    value |= (buf[i] & 0x7f) << shift;
    shift += 7;
    i += 1;
    if (!(buf[i - 1] & 0x80)) break;
    if (i - off > 10) throw new Error("varint too long");
  }
  return { value, next: i };
}

function readPackObjectHeader(buf: Buffer, off: number): {
  typeNum: number;
  size: number;
  next: number;
} {
  const first = buf[off];
  const typeNum = (first >> 4) & 0x07;
  let size = first & 0x0f;
  let shift = 4;
  let i = off + 1;
  while (first & 0x80 || (i > off + 1 && buf[i - 1] & 0x80)) {
    if (i >= buf.length) throw new Error("truncated pack object header");
    size |= (buf[i] & 0x7f) << shift;
    shift += 7;
    const cont = buf[i] & 0x80;
    i += 1;
    if (!cont) break;
  }
  return { typeNum, size, next: i };
}

function readOfsDeltaBase(buf: Buffer, off: number): { offset: number; next: number } {
  let byte = buf[off];
  let offset = byte & 0x7f;
  let i = off + 1;
  while (byte & 0x80) {
    byte = buf[i];
    offset = ((offset + 1) << 7) | (byte & 0x7f);
    i += 1;
  }
  return { offset, next: i };
}

function inflateWithLength(buf: Buffer, off: number): { data: Buffer; next: number } {
  const view = buf.subarray(off);
  const out = inflateSync(view, { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  // Node's zlib info mode reports bytesWritten on the engine; fall back to
  // re-inflating without info if the shape differs.
  const consumed = (out as { engine?: { bytesWritten?: number } }).engine?.bytesWritten;
  if (typeof consumed === "number" && consumed > 0) {
    return { data: out.buffer, next: off + consumed };
  }
  // Fallback: binary-search the consumed length by trying prefixes.
  let lo = 1;
  let hi = view.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    try {
      inflateSync(view.subarray(0, mid));
      hi = mid;
    } catch {
      lo = mid + 1;
    }
  }
  return { data: inflateSync(view.subarray(0, lo)), next: off + lo };
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readDeltaVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const b = delta[off++];
      value |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) return value;
    }
  };
  readDeltaVarint(); // source size
  const targetSize = readDeltaVarint();
  const parts: Buffer[] = [];
  let produced = 0;
  while (off < delta.length) {
    const op = delta[off++];
    if (op & 0x80) {
      let cpOff = 0;
      let cpSize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) cpOff |= delta[off++] << (bit * 8);
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (op & (0x10 << bit)) cpSize |= delta[off++] << (bit * 8);
      }
      if (cpSize === 0) cpSize = 0x10000;
      parts.push(base.subarray(cpOff, cpOff + cpSize));
      produced += cpSize;
    } else if (op !== 0) {
      parts.push(delta.subarray(off, off + op));
      produced += op;
      off += op;
    } else {
      throw new Error("delta opcode 0");
    }
  }
  const out = Buffer.concat(parts);
  if (out.length !== targetSize || produced !== targetSize) {
    throw new Error("delta target size mismatch");
  }
  return out;
}

export interface ReadPackResult {
  objects: Map<string, GitObject>;
  deltaCount: number;
}

export function readPack(
  buf: Buffer,
  opts?: { resolveBase?: (oid: string) => GitObject | undefined },
): ReadPackResult {
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "PACK") {
    throw new Error("not a packfile");
  }
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const trailer = buf.subarray(buf.length - 20);
  const expect = sha1Raw(buf.subarray(0, buf.length - 20));
  if (!expect.equals(trailer)) throw new Error("pack trailer checksum mismatch");

  interface Pending {
    oid: string;
    type: ObjType | null;
    data: Buffer;
    baseOid: string | null;
    baseOffset: number | null;
    isDelta: boolean;
  }
  const byOffset = new Map<number, Pending>();
  const objects = new Map<string, GitObject>();
  let deltaCount = 0;
  let off = 12;
  for (let i = 0; i < count; i += 1) {
    const start = off;
    const { typeNum, next } = readPackObjectHeader(buf, off);
    off = next;
    let baseOid: string | null = null;
    let baseOffset: number | null = null;
    if (typeNum === 6) {
      const r = readOfsDeltaBase(buf, off);
      baseOffset = start - r.offset;
      off = r.next;
    } else if (typeNum === 7) {
      baseOid = buf.subarray(off, off + 20).toString("hex");
      off += 20;
    }
    const inflated = inflateWithLength(buf, off);
    off = inflated.next;
    const isDelta = typeNum === 6 || typeNum === 7;
    if (isDelta) deltaCount += 1;
    const type = PACK_TYPE[typeNum] ?? null;
    const pending: Pending = {
      oid: "",
      type,
      data: inflated.data,
      baseOid,
      baseOffset,
      isDelta,
    };
    if (!isDelta && type) {
      pending.oid = hashObject(type, inflated.data);
      objects.set(pending.oid, { type, data: inflated.data });
    }
    byOffset.set(start, pending);
  }

  const resolve = (pending: Pending, seen: Set<number>): GitObject => {
    if (!pending.isDelta) return { type: pending.type!, data: pending.data };
    let base: GitObject | undefined;
    if (pending.baseOid) {
      base = objects.get(pending.baseOid) ?? opts?.resolveBase?.(pending.baseOid);
      if (!base) throw new Error(`delta base ${pending.baseOid} not found`);
    } else if (pending.baseOffset != null) {
      const basePending = byOffset.get(pending.baseOffset);
      if (!basePending) throw new Error("ofs-delta base offset not found");
      const key = pending.baseOffset;
      if (seen.has(key)) throw new Error("delta cycle");
      seen.add(key);
      base = resolve(basePending, seen);
    }
    if (!base) throw new Error("delta without base");
    const data = applyDelta(base.data, pending.data);
    return { type: base.type, data };
  };

  for (const [offset, pending] of byOffset) {
    if (pending.isDelta) {
      const resolved = resolve(pending, new Set([offset]));
      pending.oid = hashObject(resolved.type, resolved.data);
      objects.set(pending.oid, resolved);
    }
  }
  return { objects, deltaCount };
}

export function writePack(objects: Array<{ oid: string; type: ObjType; data: Buffer }>): Buffer {
  const sorted = [...objects].sort((a, b) => (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0));
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write("PACK", 0, "ascii");
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(sorted.length, 8);
  parts.push(header);
  const typeNum: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
  for (const obj of sorted) {
    const compressed = deflateSync(obj.data, { level: 1 });
    const size = obj.data.length;
    const headBytes: number[] = [];
    let remaining = size >> 4;
    let first = (size & 0x0f) | (typeNum[obj.type] << 4);
    if (remaining > 0) first |= 0x80;
    headBytes.push(first);
    while (remaining > 0) {
      let b = remaining & 0x7f;
      remaining >>= 7;
      if (remaining > 0) b |= 0x80;
      headBytes.push(b);
    }
    parts.push(Buffer.from(headBytes));
    parts.push(compressed);
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, sha1Raw(body)]);
}

// ------------------------------------------------------------ fetch planning

export interface FetchPlan {
  objects: Map<string, GitObject>;
  shallow: string[];
  unshallow: string[];
}

function treeClosure(
  lookup: (oid: string) => GitObject | undefined,
  rootTreeOid: string,
  out: Map<string, GitObject>,
): void {
  const stack = [rootTreeOid];
  while (stack.length) {
    const treeOid = stack.pop()!;
    if (out.has(treeOid)) continue;
    const tree = lookup(treeOid);
    if (!tree || tree.type !== "tree") continue;
    out.set(treeOid, tree);
    for (const entry of parseTree(tree.data)) {
      if (entry.mode === "40000") {
        stack.push(entry.oid);
      } else {
        const blob = lookup(entry.oid);
        if (blob && !out.has(entry.oid)) out.set(entry.oid, blob);
      }
    }
  }
}

function commitClosure(
  lookup: (oid: string) => GitObject | undefined,
  roots: string[],
  maxDepth: number | null,
): Map<string, number> {
  const depthOf = new Map<string, number>();
  const queue: Array<{ oid: string; depth: number }> = [];
  for (const root of roots) {
    let target = root;
    const obj = lookup(root);
    if (obj?.type === "tag") {
      target = parseTag(obj.data).object;
    }
    if (!depthOf.has(target)) {
      depthOf.set(target, 1);
      queue.push({ oid: target, depth: 1 });
    }
  }
  for (let i = 0; i < queue.length; i += 1) {
    const { oid, depth } = queue[i];
    if (maxDepth != null && depth >= maxDepth) continue;
    const obj = lookup(oid);
    if (!obj || obj.type !== "commit") continue;
    for (const parent of parseCommit(obj.data).parents) {
      if (!depthOf.has(parent)) {
        depthOf.set(parent, depth + 1);
        queue.push({ oid: parent, depth: depth + 1 });
      }
    }
  }
  return depthOf;
}

/**
 * Plan a fetch. Rules (from the kit checks):
 * - send = reachable(wants, depth-limited) minus held(haves).
 * - A non-shallow have contributes its full closure; a shallow have
 *   contributes only itself plus its tree and blobs.
 * - Depth 1 = wants only; depth 2 = wants + parents.
 * - `shallow` = sent commits whose parents were cut by the depth limit.
 * - `unshallow` = shallow haves that are now fully included.
 */
export function planFetch(
  lookup: (oid: string) => GitObject | undefined,
  wants: string[],
  haves: string[],
  shallowHaves: Set<string>,
  depth: number | null,
): FetchPlan {
  const reachable = commitClosure(lookup, wants, depth);
  const heldCommits = new Set<string>();
  const heldObjects = new Map<string, GitObject>();
  for (const have of haves) {
    const obj = lookup(have);
    if (!obj || obj.type !== "commit") continue;
    if (shallowHaves.has(have)) {
      heldCommits.add(have);
      heldObjects.set(have, obj);
      treeClosure(lookup, parseCommit(obj.data).tree, heldObjects);
    } else {
      for (const oid of commitClosure(lookup, [have], null).keys()) {
        heldCommits.add(oid);
        const commit = lookup(oid);
        if (commit) heldObjects.set(oid, commit);
      }
      for (const oid of heldCommits) {
        const commit = lookup(oid);
        if (commit?.type === "commit") {
          treeClosure(lookup, parseCommit(commit.data).tree, heldObjects);
        }
      }
    }
  }

  const send = new Map<string, GitObject>();
  for (const oid of reachable.keys()) {
    if (heldCommits.has(oid)) continue;
    const commit = lookup(oid);
    if (!commit) continue;
    send.set(oid, commit);
    treeClosure(lookup, parseCommit(commit.data).tree, send);
  }
  // Tag wants travel with their target.
  for (const want of wants) {
    const obj = lookup(want);
    if (obj?.type === "tag" && !heldObjects.has(want)) {
      send.set(want, obj);
    }
  }
  for (const oid of heldObjects.keys()) send.delete(oid);

  const shallow: string[] = [];
  for (const oid of reachable.keys()) {
    if (heldCommits.has(oid) || !send.has(oid)) continue;
    const commit = lookup(oid);
    if (!commit || commit.type !== "commit") continue;
    const cut = parseCommit(commit.data).parents.some((p) => !reachable.has(p));
    if (cut) shallow.push(oid);
  }
  const unshallow: string[] = [];
  for (const have of shallowHaves) {
    if (!reachable.has(have)) continue;
    const commit = lookup(have);
    if (!commit || commit.type !== "commit") continue;
    const parents = parseCommit(commit.data).parents;
    if (parents.every((p) => reachable.has(p) || heldCommits.has(p))) {
      unshallow.push(have);
    }
  }
  return { objects: send, shallow, unshallow };
}

// ----------------------------------------------------------- advertisements

export interface AdRef {
  oid: string;
  name: string;
  peeled?: string;
}

const UPLOAD_CAPS = "symref=HEAD:refs/heads/main side-band-64k ofs-delta thin-pack";
const RECEIVE_CAPS = "report-status side-band-64k delete-refs";

export function buildV2UploadAd(): Buffer {
  return Buffer.concat([
    pktLine("version 2\n"),
    pktLine("agent=forge/2.0.0\n"),
    pktLine("ls-refs=unborn\n"),
    pktLine("fetch=shallow\n"),
    pktLine("object-format=sha1\n"),
    pktFlush(),
  ]);
}

function v0RefLines(refs: AdRef[], caps: string, headSymref: string): Buffer[] {
  const lines: Buffer[] = [];
  const capSuffix = `\0${caps}\n`;
  if (refs.length === 0) {
    lines.push(pktLine(`${ZERO_OID} capabilities^{}${capSuffix}`));
    return lines;
  }
  const head = refs.find((r) => r.name === "HEAD");
  const rest = refs.filter((r) => r.name !== "HEAD");
  const ordered = head ? [head, ...rest] : rest;
  ordered.forEach((ref, index) => {
    const suffix = index === 0 ? capSuffix : "\n";
    lines.push(pktLine(`${ref.oid} ${ref.name}${suffix}`));
    if (ref.peeled) lines.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
  });
  return lines;
}

export function buildV0UploadAd(refs: AdRef[]): Buffer {
  const chunks: Buffer[] = [
    pktLine("# service=git-upload-pack\n"),
    pktFlush(),
    ...v0RefLines(refs, UPLOAD_CAPS, "refs/heads/main"),
    pktFlush(),
  ];
  return Buffer.concat(chunks);
}

export function buildV0ReceiveAd(refs: AdRef[]): Buffer {
  const chunks: Buffer[] = [
    pktLine("# service=git-receive-pack\n"),
    pktFlush(),
    ...v0RefLines(refs, RECEIVE_CAPS, "refs/heads/main"),
    pktFlush(),
  ];
  return Buffer.concat(chunks);
}

export function buildLsRefsResponse(
  refs: AdRef[],
  args: { peel: boolean; symrefs: boolean; unborn: boolean; prefixes: string[] },
  headSymref: string,
  isEmpty: boolean,
): Buffer {
  const chunks: Buffer[] = [];
  const keep = (name: string): boolean => {
    if (args.prefixes.length === 0) return true;
    return args.prefixes.some((p) => name.startsWith(p));
  };
  if (isEmpty && args.unborn && keep("HEAD")) {
    chunks.push(pktLine(`unborn HEAD symref-target:${headSymref}\n`));
  }
  for (const ref of refs) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (ref.name === "HEAD" && args.symrefs) line += ` symref-target:${headSymref}`;
    if (ref.peeled && args.peel) line += ` peeled:${ref.peeled}`;
    chunks.push(pktLine(`${line}\n`));
  }
  chunks.push(pktFlush());
  return Buffer.concat(chunks);
}

// ------------------------------------------------------------ fetch responses

const SIDEBAND_MAX = 65515;

function sidebandPackets(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let off = 0; off < pack.length; off += SIDEBAND_MAX) {
    const chunk = pack.subarray(off, Math.min(off + SIDEBAND_MAX, pack.length));
    const payload = Buffer.alloc(chunk.length + 1);
    payload[0] = 1;
    chunk.copy(payload, 1);
    out.push(pktLine(payload));
  }
  return out;
}

/**
 * Build a v2 fetch response. Per the protocol, the acknowledgments section
 * is only sent when the client sent haves; a fresh clone (no haves) goes
 * straight to shallow-info / packfile, and a client that expects the
 * packfile section first fails if it sees acknowledgments instead.
 */
export function buildFetchV2Response(
  plan: FetchPlan,
  ackOid: string | null,
  sendAcks: boolean,
): Buffer {
  const chunks: Buffer[] = [];
  if (sendAcks) {
    chunks.push(pktLine("acknowledgments\n"));
    if (ackOid) {
      chunks.push(pktLine(`ACK ${ackOid}\n`));
      chunks.push(pktLine("ready\n"));
    } else {
      chunks.push(pktLine("NAK\n"));
    }
    chunks.push(pktDelim());
  }
  if (plan.shallow.length || plan.unshallow.length) {
    chunks.push(pktLine("shallow-info\n"));
    for (const oid of plan.shallow) chunks.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) chunks.push(pktLine(`unshallow ${oid}\n`));
    chunks.push(pktDelim());
  }
  const pack = writePack(
    [...plan.objects.entries()].map(([oid, obj]) => ({ oid, type: obj.type, data: obj.data })),
  );
  chunks.push(pktLine("packfile\n"));
  chunks.push(...sidebandPackets(pack));
  chunks.push(pktFlush());
  return Buffer.concat(chunks);
}

export function buildFetchV0Response(plan: FetchPlan, ackOid: string | null): Buffer {
  const chunks: Buffer[] = [];
  chunks.push(pktLine(ackOid ? `ACK ${ackOid}\n` : "NAK\n"));
  for (const oid of plan.shallow) chunks.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) chunks.push(pktLine(`unshallow ${oid}\n`));
  const pack = writePack(
    [...plan.objects.entries()].map(([oid, obj]) => ({ oid, type: obj.type, data: obj.data })),
  );
  chunks.push(...sidebandPackets(pack));
  chunks.push(pktFlush());
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------- receive-pack I/O

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function parseReceivePackBody(
  buf: Buffer,
): { commands: PushCommand[]; pack: Buffer | null } {
  // The body is pkt-lines up to the first flush, then RAW pack bytes. The
  // pack is not pkt-line framed, so it must never be fed to the pkt-line
  // decoder: stop at the flush and take the remainder as the pack.
  const commands: PushCommand[] = [];
  let off = 0;
  let sawFlush = false;
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error("truncated pkt-line length");
    const head = buf.toString("ascii", off, off + 4);
    if (head === "0000") {
      sawFlush = true;
      off += 4;
      break;
    }
    if (head === "0001") {
      off += 4;
      continue;
    }
    const len = parseInt(head, 16);
    if (!Number.isFinite(len) || len < 4 || off + len > buf.length) {
      throw new Error(`bad pkt-line length ${head}`);
    }
    const text = buf.toString("utf8", off + 4, off + len);
    off += len;
    const nul = text.indexOf("\0");
    const line = (nul >= 0 ? text.slice(0, nul) : text).replace(/\n$/, "");
    const parts = line.split(" ");
    if (parts.length >= 3) {
      commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
    }
  }
  if (!sawFlush) throw new Error("receive-pack body has no flush");
  const rest = buf.subarray(off);
  const pack = rest.length >= 12 && rest.toString("ascii", 0, 4) === "PACK" ? rest : null;
  return { commands, pack };
}

export function buildReceivePackResult(
  results: Array<{ ref: string; ok: boolean; reason?: string }>,
): Buffer {
  const chunks: Buffer[] = [];
  // With side-band-64k the report-status stream is itself pkt-lined inside
  // band 1: each report line is a pkt-line, and that pkt-line is the payload
  // of a band-1 sideband packet. Sending raw text inside band 1 makes the
  // client read "unpa" as a pkt-line length and fail.
  const band1 = (text: string): Buffer => {
    const inner = pktLine(text);
    const payload = Buffer.concat([Buffer.from([1]), inner]);
    return pktLine(payload);
  };
  chunks.push(band1("unpack ok\n"));
  for (const r of results) {
    chunks.push(band1(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason ?? "failed"}\n`));
  }
  chunks.push(pktFlush());
  return Buffer.concat(chunks);
}
