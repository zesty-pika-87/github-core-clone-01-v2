// The forge's state: repositories, objects, refs, issues, pull requests and
// labels, plus the git operations that run on top of them (tree edits, diffs,
// ancestry, squash merges). All timestamps come from the trial clock and all
// ids are opaque base64url strings, so replayed trials export identical state.

import {
  buildCommit,
  buildTree,
  hashObject,
  parseCommit,
  parseTag,
  parseTree,
  type GitObject,
  type TreeEntry,
} from "./git.ts";
import { b64urlEncode, trialEpochSec, trialNowIso, VIEWER, ZERO_OID } from "./util.ts";

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface CommentItem {
  id: number;
  nodeId: string;
  body: string;
  createdSeq: number;
}

export interface IssueItem {
  id: number;
  nodeId: string;
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: string[];
  comments: CommentItem[];
  createdSeq: number;
  updatedSeq: number;
}

export interface PullItem {
  id: number;
  nodeId: string;
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdSeq: number;
  updatedSeq: number;
}

export interface Repo {
  id: number;
  nodeId: string;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdSeq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: IssueItem[];
  issueByNumber: Map<number, IssueItem>;
  issueCounter: number;
  labels: Map<string, Label>;
  pulls: PullItem[];
  pullByNumber: Map<number, PullItem>;
  pullCounter: number;
  commentCounter: number;
  generation: number;
  // Caches, all keyed or invalidated by `generation`.
  v0UploadAd: Buffer | null;
  v0ReceiveAd: Buffer | null;
  lsRefsCache: Map<string, Buffer>;
  fetchCache: Map<string, Buffer>;
  fetchInflight: Map<string, Promise<Buffer>>;
  issueJsonCache: Map<number, Buffer>;
}

export function repoGlobalId(owner: string, name: string): string {
  return b64urlEncode(`R:${owner}/${name}`);
}
export function issueGlobalId(owner: string, name: string, number: number): string {
  return b64urlEncode(`I:${owner}/${name}/${number}`);
}
export function pullGlobalId(owner: string, name: string, number: number): string {
  return b64urlEncode(`P:${owner}/${name}/${number}`);
}
export function commentGlobalId(
  owner: string,
  name: string,
  issueNumber: number,
  commentId: number,
): string {
  return b64urlEncode(`C:${owner}/${name}/${issueNumber}/${commentId}`);
}
export function userGlobalId(login: string): string {
  return b64urlEncode(`U:${login}`);
}

export class Store {
  repos = new Map<string, Repo>();
  nextRepoId = 1;
  seq = 0;

  createRepo(name: string, description: string, isPrivate: boolean): Repo | null {
    const key = `${VIEWER.login}/${name}`;
    if (this.repos.has(key)) return null;
    this.seq += 1;
    const repo: Repo = {
      id: this.nextRepoId++,
      nodeId: repoGlobalId(VIEWER.login, name),
      owner: VIEWER.login,
      name,
      description,
      isPrivate,
      defaultBranch: "main",
      createdSeq: this.seq,
      objects: new Map(),
      refs: new Map(),
      issues: [],
      issueByNumber: new Map(),
      issueCounter: 0,
      labels: new Map(),
      pulls: [],
      pullByNumber: new Map(),
      pullCounter: 0,
      commentCounter: 0,
      generation: 0,
      v0UploadAd: null,
      v0ReceiveAd: null,
      lsRefsCache: new Map(),
      fetchCache: new Map(),
      fetchInflight: new Map(),
      issueJsonCache: new Map(),
    };
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(`${owner}/${name}`);
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(`${owner}/${name}`);
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.createdSeq - b.createdSeq);
  }

  bump(repo: Repo): void {
    repo.generation += 1;
    repo.v0UploadAd = null;
    repo.v0ReceiveAd = null;
    repo.lsRefsCache.clear();
    repo.fetchCache.clear();
    repo.issueJsonCache.clear();
  }

  lookup(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  putObject(repo: Repo, type: GitObject["type"], data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  refTip(repo: Repo, refName: string): string | undefined {
    return repo.refs.get(`refs/heads/${refName}`);
  }

  /** All refs as advertisement entries, HEAD first. */
  adRefs(repo: Repo): Array<{ oid: string; name: string; peeled?: string }> {
    const out: Array<{ oid: string; name: string; peeled?: string }> = [];
    const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (headTip) out.push({ oid: headTip, name: "HEAD" });
    const names = [...repo.refs.keys()].sort();
    for (const name of names) {
      const oid = repo.refs.get(name)!;
      const entry: { oid: string; name: string; peeled?: string } = { oid, name };
      const obj = repo.objects.get(oid);
      if (name.startsWith("refs/tags/") && obj?.type === "tag") {
        entry.peeled = parseTag(obj.data).object;
      }
      out.push(entry);
    }
    return out;
  }

  createIssue(repo: Repo, title: string, body: string, labels: string[]): IssueItem {
    this.seq += 1;
    repo.issueCounter += 1;
    const number = repo.issueCounter;
    const issue: IssueItem = {
      id: repo.id * 100000 + number,
      nodeId: issueGlobalId(repo.owner, repo.name, number),
      number,
      title,
      body,
      state: "open",
      labels: [...labels],
      comments: [],
      createdSeq: this.seq,
      updatedSeq: this.seq,
    };
    repo.issues.push(issue);
    repo.issueByNumber.set(number, issue);
    return issue;
  }

  createPull(
    repo: Repo,
    title: string,
    body: string,
    headRef: string,
    baseRef: string,
  ): PullItem | null {
    const headSha = this.refTip(repo, headRef);
    const baseSha = this.refTip(repo, baseRef);
    if (!headSha || !baseSha) return null;
    this.seq += 1;
    repo.pullCounter += 1;
    const number = repo.pullCounter;
    const pull: PullItem = {
      id: repo.id * 100000 + 50000 + number,
      nodeId: pullGlobalId(repo.owner, repo.name, number),
      number,
      title,
      body,
      state: "open",
      headRef,
      headSha,
      baseRef,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      createdSeq: this.seq,
      updatedSeq: this.seq,
    };
    repo.pulls.push(pull);
    repo.pullByNumber.set(number, pull);
    return pull;
  }
}

// ------------------------------------------------------------------ tree ops

export interface PathHit {
  oid: string;
  mode: string;
  data: Buffer;
}

/** Resolve a path inside the tree at a ref tip. Returns null when absent. */
export function readPath(
  repo: Repo,
  refName: string,
  path: string,
): PathHit | null {
  const tip = repo.refs.get(`refs/heads/${refName}`);
  if (!tip) return null;
  const commit = repo.objects.get(tip);
  if (!commit || commit.type !== "commit") return null;
  let treeOid = parseCommit(commit.data).tree;
  const segments = path.split("/").filter((s) => s.length > 0);
  for (let i = 0; i < segments.length; i += 1) {
    const tree = repo.objects.get(treeOid);
    if (!tree || tree.type !== "tree") return null;
    const entry = parseTree(tree.data).find((e) => e.name === segments[i]);
    if (!entry) return null;
    if (i === segments.length - 1) {
      const obj = repo.objects.get(entry.oid);
      if (!obj) return null;
      return { oid: entry.oid, mode: entry.mode, data: obj.data };
    }
    if (entry.mode !== "40000") return null;
    treeOid = entry.oid;
  }
  return null;
}

/** List the entries of a directory inside the tree at a ref tip. */
export function listDir(repo: Repo, refName: string, dirPath: string): TreeEntry[] | null {
  const tip = repo.refs.get(`refs/heads/${refName}`);
  if (!tip) return null;
  const commit = repo.objects.get(tip);
  if (!commit || commit.type !== "commit") return null;
  let treeOid = parseCommit(commit.data).tree;
  const segments = dirPath.split("/").filter((s) => s.length > 0);
  for (const seg of segments) {
    const tree = repo.objects.get(treeOid);
    if (!tree || tree.type !== "tree") return null;
    const entry = parseTree(tree.data).find((e) => e.name === seg);
    if (!entry || entry.mode !== "40000") return null;
    treeOid = entry.oid;
  }
  const tree = repo.objects.get(treeOid);
  if (!tree || tree.type !== "tree") return null;
  return parseTree(tree.data);
}

function setPathInTree(
  repo: Repo,
  treeOid: string | null,
  segments: string[],
  blobOid: string | null,
): string | null {
  const entries: TreeEntry[] =
    treeOid != null ? parseTree(repo.objects.get(treeOid)?.data ?? Buffer.alloc(0)) : [];
  const [head, ...rest] = segments;
  const idx = entries.findIndex((e) => e.name === head);
  if (rest.length === 0) {
    if (blobOid === null) {
      if (idx >= 0) entries.splice(idx, 1);
    } else if (idx >= 0) {
      entries[idx] = { mode: "100644", name: head, oid: blobOid };
    } else {
      entries.push({ mode: "100644", name: head, oid: blobOid });
    }
  } else {
    const childTreeOid = idx >= 0 && entries[idx].mode === "40000" ? entries[idx].oid : null;
    const next = setPathInTree(repo, childTreeOid, rest, blobOid);
    if (next === null) {
      if (idx >= 0) entries.splice(idx, 1);
    } else if (idx >= 0) {
      entries[idx] = { mode: "40000", name: head, oid: next };
    } else {
      entries.push({ mode: "40000", name: head, oid: next });
    }
  }
  if (entries.length === 0) return null;
  const data = buildTree(entries);
  const oid = hashObject("tree", data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type: "tree", data });
  return oid;
}

/** Create a commit on a ref that sets (or deletes) one path. Works on an
 *  unborn ref too: the new commit has no parents. */
export function commitPath(
  repo: Repo,
  refName: string,
  path: string,
  content: Buffer | null,
  message: string,
): { commitOid: string; blobOid: string | null } {
  const tip = repo.refs.get(`refs/heads/${refName}`);
  let rootTreeOid: string | null = null;
  const parents: string[] = [];
  if (tip) {
    const commit = repo.objects.get(tip);
    if (commit?.type === "commit") {
      rootTreeOid = parseCommit(commit.data).tree;
      parents.push(tip);
    }
  }
  let blobOid: string | null = null;
  if (content !== null) {
    blobOid = hashObject("blob", content);
    if (!repo.objects.has(blobOid)) repo.objects.set(blobOid, { type: "blob", data: content });
  }
  const segments = path.split("/").filter((s) => s.length > 0);
  const newRoot = setPathInTree(repo, rootTreeOid, segments, blobOid);
  const treeOid = newRoot ?? hashObject("tree", buildTree([]));
  if (!repo.objects.has(treeOid)) {
    repo.objects.set(treeOid, { type: "tree", data: buildTree([]) });
  }
  const commitData = buildCommit({
    tree: treeOid,
    parents,
    message,
    epoch: trialEpochSec(),
  });
  const commitOid = hashObject("commit", commitData);
  repo.objects.set(commitOid, { type: "commit", data: commitData });
  repo.refs.set(`refs/heads/${refName}`, commitOid);
  return { commitOid, blobOid };
}

// ---------------------------------------------------------------------- diff

export interface FileChange {
  filename: string;
  status: "added" | "modified" | "removed";
  additions: number;
  deletions: number;
  changes: number;
  blobSha: string;
}

export function flattenTree(repo: Repo, treeOid: string): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const stack: Array<{ treeOid: string; prefix: string }> = [{ treeOid, prefix: "" }];
  while (stack.length) {
    const { treeOid: current, prefix } = stack.pop()!;
    const tree = repo.objects.get(current);
    if (!tree || tree.type !== "tree") continue;
    for (const entry of parseTree(tree.data)) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.mode === "40000") {
        stack.push({ treeOid: entry.oid, prefix: path });
      } else {
        out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    }
  }
  return out;
}

function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  const text = data.toString("utf8");
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

export function diffTrees(repo: Repo, baseTreeOid: string, headTreeOid: string): FileChange[] {
  const base = flattenTree(repo, baseTreeOid);
  const head = flattenTree(repo, headTreeOid);
  const changes: FileChange[] = [];
  for (const [path, h] of head) {
    const b = base.get(path);
    if (!b) {
      const lines = countLines(repo.objects.get(h.oid)?.data ?? Buffer.alloc(0));
      changes.push({
        filename: path,
        status: "added",
        additions: lines,
        deletions: 0,
        changes: lines,
        blobSha: h.oid,
      });
    } else if (b.oid !== h.oid) {
      const oldLines = countLines(repo.objects.get(b.oid)?.data ?? Buffer.alloc(0));
      const newLines = countLines(repo.objects.get(h.oid)?.data ?? Buffer.alloc(0));
      const additions = Math.max(0, newLines - oldLines);
      const deletions = Math.max(0, oldLines - newLines);
      changes.push({
        filename: path,
        status: "modified",
        additions,
        deletions,
        changes: additions + deletions,
        blobSha: h.oid,
      });
    }
  }
  for (const [path, b] of base) {
    if (!head.has(path)) {
      const lines = countLines(repo.objects.get(b.oid)?.data ?? Buffer.alloc(0));
      changes.push({
        filename: path,
        status: "removed",
        additions: 0,
        deletions: lines,
        changes: lines,
        blobSha: ZERO_OID,
      });
    }
  }
  changes.sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));
  return changes;
}

// ------------------------------------------------------------------ ancestry

export function isAncestor(repo: Repo, ancestorOid: string, descendantOid: string): boolean {
  if (ancestorOid === descendantOid) return true;
  const seen = new Set<string>();
  const stack = [descendantOid];
  while (stack.length) {
    const oid = stack.pop()!;
    if (oid === ancestorOid) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== "commit") continue;
    for (const parent of parseCommit(obj.data).parents) stack.push(parent);
  }
  return false;
}

export function walkCommits(
  repo: Repo,
  tipOid: string,
  limit = 1000,
): Array<{ oid: string; commit: ReturnType<typeof parseCommit> }> {
  const out: Array<{ oid: string; commit: ReturnType<typeof parseCommit> }> = [];
  const seen = new Set<string>();
  const stack = [tipOid];
  while (stack.length && out.length < limit) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== "commit") continue;
    const commit = parseCommit(obj.data);
    out.push({ oid, commit });
    for (const parent of commit.parents) stack.push(parent);
  }
  return out;
}

// --------------------------------------------------------------------- merge

export interface MergeOutcome {
  ok: boolean;
  conflict?: boolean;
  sha?: string;
  files?: FileChange[];
}

/** Squash-merge a pull request onto its base branch. */
export function mergePull(repo: Repo, pull: PullItem, seq: number): MergeOutcome {
  if (pull.state !== "open") return { ok: false };
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (!baseTip) return { ok: false };
  const headCommit = repo.objects.get(pull.headSha);
  const baseCommit = repo.objects.get(baseTip);
  const mergeBaseCommit = repo.objects.get(pull.baseSha);
  if (!headCommit || !baseCommit || !mergeBaseCommit) return { ok: false };
  const headTree = parseCommit(headCommit.data).tree;
  const baseTree = parseCommit(baseCommit.data).tree;
  const mergeBaseTree = parseCommit(mergeBaseCommit.data).tree;

  const headChanges = diffTrees(repo, mergeBaseTree, headTree);
  const baseChanges = diffTrees(repo, mergeBaseTree, baseTree);
  const baseChanged = new Map(baseChanges.map((c) => [c.filename, c]));
  const headChanged = new Map(headChanges.map((c) => [c.filename, c]));
  for (const [path, hc] of headChanged) {
    const bc = baseChanged.get(path);
    if (bc && bc.blobSha !== hc.blobSha) {
      return { ok: false, conflict: true };
    }
  }

  // Apply the head's changes onto the current base tree.
  let currentTree = baseTree;
  const flat = flattenTree(repo, currentTree);
  for (const change of headChanges) {
    if (change.status === "removed") {
      flat.delete(change.filename);
    } else {
      flat.set(change.filename, { oid: change.blobSha, mode: "100644" });
    }
  }
  const rebuild = (entries: Map<string, { oid: string; mode: string }>): string => {
    // Rebuild nested trees bottom-up from the flat path map.
    const byDir = new Map<string, TreeEntry[]>();
    for (const [path, info] of entries) {
      const parts = path.split("/");
      const name = parts.pop()!;
      const dir = parts.join("/");
      const list = byDir.get(dir) ?? [];
      list.push({ mode: info.mode, name, oid: info.oid });
      byDir.set(dir, list);
    }
    const buildDir = (dir: string): string => {
      const direct = byDir.get(dir) ?? [];
      const subdirs = new Set<string>();
      for (const [path] of entries) {
        if (dir === "" || path.startsWith(`${dir}/`)) {
          const rest = dir === "" ? path : path.slice(dir.length + 1);
          const slash = rest.indexOf("/");
          if (slash >= 0) subdirs.add(rest.slice(0, slash));
        }
      }
      const all = [...direct];
      for (const sub of subdirs) {
        all.push({ mode: "40000", name: sub, oid: buildDir(dir === "" ? sub : `${dir}/${sub}`) });
      }
      const data = buildTree(all);
      const oid = hashObject("tree", data);
      if (!repo.objects.has(oid)) repo.objects.set(oid, { type: "tree", data });
      return oid;
    };
    return buildDir("");
  };
  currentTree = rebuild(flat);

  const message = `Merge pull request #${pull.number}: ${pull.title}`;
  const commitData = buildCommit({
    tree: currentTree,
    parents: [baseTip],
    message,
    epoch: trialEpochSec(),
  });
  const sha = hashObject("commit", commitData);
  repo.objects.set(sha, { type: "commit", data: commitData });
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.merged = true;
  pull.mergedAt = trialNowIso();
  pull.mergeCommitSha = sha;
  pull.state = "closed";
  pull.updatedSeq = seq;
  return { ok: true, sha, files: headChanges };
}
