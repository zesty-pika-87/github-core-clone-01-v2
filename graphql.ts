// GraphQL v4: a small hand-rolled parser and executor for the eighteen
// documents the kit sends. No spec-complete engine — just the queries,
// mutations, variables, inline fragments and introspection the checks use,
// with unknown fields reported as errors instead of crashing.

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  commentGlobalId,
  diffTrees,
  issueGlobalId,
  mergePull,
  pullGlobalId,
  repoGlobalId,
  userGlobalId,
  type IssueItem,
  type PullItem,
  type Repo,
  type Store,
} from "./store.ts";
import { parseCommit } from "./git.ts";
import { jsonError, sendJson } from "./http.ts";
import { b64urlDecode, b64urlEncode, VIEWER } from "./util.ts";
import { mergeConflict } from "./rest.ts";

// -------------------------------------------------------------- tokeniser

type Token =
  | { kind: "name"; value: string }
  | { kind: "string"; value: string }
  | { kind: "number"; value: string }
  | { kind: "punct"; value: string }
  | { kind: "spread" }
  | { kind: "eof" };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === ",") {
      i += 1;
      continue;
    }
    if (ch === "#") {
      while (i < src.length && src[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "." && src.slice(i, i + 3) === "...") {
      tokens.push({ kind: "spread" });
      i += 3;
      continue;
    }
    if ("{}()[]:!=$@".includes(ch)) {
      tokens.push({ kind: "punct", value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let out = "";
      i += 1;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === "\\" && i + 1 < src.length) {
          const esc = src[i + 1];
          const map: Record<string, string> = {
            n: "\n",
            r: "\r",
            t: "\t",
            b: "\b",
            f: "\f",
            '"': '"',
            "\\": "\\",
            "/": "/",
          };
          if (esc === "u" && i + 5 < src.length) {
            out += String.fromCharCode(parseInt(src.slice(i + 2, i + 6), 16));
            i += 6;
          } else {
            out += map[esc] ?? esc;
            i += 2;
          }
        } else {
          out += src[i];
          i += 1;
        }
      }
      i += 1;
      tokens.push({ kind: "string", value: out });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (src[j] === "-") j += 1;
      while (j < src.length && /[0-9.]/.test(src[j])) j += 1;
      if (j < src.length && (src[j] === "e" || src[j] === "E")) {
        j += 1;
        if (src[j] === "+" || src[j] === "-") j += 1;
        while (j < src.length && /[0-9]/.test(src[j])) j += 1;
      }
      tokens.push({ kind: "number", value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < src.length && /[_0-9A-Za-z]/.test(src[j])) j += 1;
      tokens.push({ kind: "name", value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)}`);
  }
  tokens.push({ kind: "eof" });
  return tokens;
}

// --------------------------------------------------------------- AST + parse

type Value =
  | { kind: "variable"; name: string }
  | { kind: "string"; value: string }
  | { kind: "number"; value: number }
  | { kind: "boolean"; value: boolean }
  | { kind: "null" }
  | { kind: "enum"; value: string }
  | { kind: "list"; items: Value[] }
  | { kind: "object"; fields: Record<string, Value> };

interface FieldNode {
  kind: "field";
  alias: string | null;
  name: string;
  args: Record<string, Value>;
  selection: Selection[] | null;
}
interface FragmentNode {
  kind: "fragment";
  typeCondition: string | null;
  name: string | null;
  selection: Selection[];
}
type Selection = FieldNode | FragmentNode;

interface Operation {
  op: "query" | "mutation";
  name: string | null;
  varDefs: Record<string, Value | null>;
  selection: Selection[];
}
interface Document {
  operations: Operation[];
  fragments: Map<string, Selection[]>;
}

class Parser {
  private pos = 0;
  private tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }
  private next(): Token {
    return this.tokens[this.pos++];
  }
  private expectPunct(value: string): void {
    const t = this.next();
    if (t.kind !== "punct" || t.value !== value) throw new Error(`expected ${value}`);
  }
  private expectName(): string {
    const t = this.next();
    if (t.kind !== "name") throw new Error("expected name");
    return t.value;
  }

  parseDocument(): Document {
    const doc: Document = { operations: [], fragments: new Map() };
    while (this.peek().kind !== "eof") {
      const t = this.peek();
      if (t.kind === "name" && t.value === "fragment") {
        this.next();
        const name = this.expectName();
        let typeCondition: string | null = null;
        const on = this.next();
        if (on.kind === "name" && on.value === "on") typeCondition = this.expectName();
        void typeCondition;
        const selection = this.parseSelectionSet();
        doc.fragments.set(name, selection);
        continue;
      }
      doc.operations.push(this.parseOperation());
    }
    return doc;
  }

  private parseOperation(): Operation {
    let op: "query" | "mutation" = "query";
    let name: string | null = null;
    const t = this.peek();
    if (t.kind === "name" && (t.value === "query" || t.value === "mutation")) {
      this.next();
      op = t.value as "query" | "mutation";
      const maybeName = this.peek();
      if (maybeName.kind === "name") {
        const nameTok = this.next();
        name = nameTok.kind === "name" ? nameTok.value : null;
      }
    }
    const varDefs: Record<string, Value | null> = {};
    if (this.peek().kind === "punct" && (this.peek() as { value: string }).value === "(") {
      this.parseVariableDefinitions(varDefs);
    }
    const selection = this.parseSelectionSet();
    return { op, name, varDefs, selection };
  }

  private parseVariableDefinitions(varDefs: Record<string, Value | null>): void {
    this.expectPunct("(");
    while (!(this.peek().kind === "punct" && (this.peek() as { value: string }).value === ")")) {
      this.expectPunct("$");
      const name = this.expectName();
      this.expectPunct(":");
      this.parseType();
      let def: Value | null = null;
      if (this.peek().kind === "punct" && (this.peek() as { value: string }).value === "=") {
        this.next();
        def = this.parseValue();
      }
      varDefs[name] = def;
    }
    this.expectPunct(")");
  }

  private parseType(): void {
    const t = this.peek();
    if (t.kind === "punct" && t.value === "[") {
      this.next();
      this.parseType();
      this.expectPunct("]");
    } else {
      this.expectName();
    }
    if (this.peek().kind === "punct" && (this.peek() as { value: string }).value === "!") this.next();
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct("{");
    const selections: Selection[] = [];
    while (!(this.peek().kind === "punct" && (this.peek() as { value: string }).value === "}")) {
      selections.push(this.parseSelection());
    }
    this.expectPunct("}");
    return selections;
  }

  private parseSelection(): Selection {
    const t = this.peek();
    if (t.kind === "spread") {
      this.next();
      const next = this.peek();
      if (next.kind === "name" && next.value === "on") {
        this.next();
        const typeCondition = this.expectName();
        return { kind: "fragment", typeCondition, name: null, selection: this.parseSelectionSet() };
      }
      if (next.kind === "name") {
        const nameTok = this.next();
        const name = nameTok.kind === "name" ? nameTok.value : "";
        return { kind: "fragment", typeCondition: null, name, selection: [] };
      }
      return { kind: "fragment", typeCondition: null, name: null, selection: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.peek().kind === "punct" && (this.peek() as { value: string }).value === ":") {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args: Record<string, Value> = {};
    if (this.peek().kind === "punct" && (this.peek() as { value: string }).value === "(") {
      this.next();
      while (!(this.peek().kind === "punct" && (this.peek() as { value: string }).value === ")")) {
        const argName = this.expectName();
        this.expectPunct(":");
        args[argName] = this.parseValue();
      }
      this.expectPunct(")");
    }
    let selection: Selection[] | null = null;
    if (this.peek().kind === "punct" && (this.peek() as { value: string }).value === "{") {
      selection = this.parseSelectionSet();
    }
    return { kind: "field", alias, name, args, selection };
  }

  private parseValue(): Value {
    const t = this.next();
    if (t.kind === "punct" && t.value === "$") {
      return { kind: "variable", name: this.expectName() };
    }
    if (t.kind === "punct" && t.value === "[") {
      const items: Value[] = [];
      while (!(this.peek().kind === "punct" && (this.peek() as { value: string }).value === "]")) {
        items.push(this.parseValue());
      }
      this.expectPunct("]");
      return { kind: "list", items };
    }
    if (t.kind === "punct" && t.value === "{") {
      const fields: Record<string, Value> = {};
      while (!(this.peek().kind === "punct" && (this.peek() as { value: string }).value === "}")) {
        const name = this.expectName();
        this.expectPunct(":");
        fields[name] = this.parseValue();
      }
      this.expectPunct("}");
      return { kind: "object", fields };
    }
    if (t.kind === "string") return { kind: "string", value: t.value };
    if (t.kind === "number") return { kind: "number", value: Number(t.value) };
    if (t.kind === "name") {
      if (t.value === "true") return { kind: "boolean", value: true };
      if (t.value === "false") return { kind: "boolean", value: false };
      if (t.value === "null") return { kind: "null" };
      return { kind: "enum", value: t.value };
    }
    throw new Error("unexpected value token");
  }
}

function resolveValue(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case "variable":
      return variables[value.name];
    case "string":
    case "number":
    case "boolean":
      return value.value;
    case "null":
      return null;
    case "enum":
      return value.value;
    case "list":
      return value.items.map((item) => resolveValue(item, variables));
    case "object": {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value.fields)) out[k] = resolveValue(v, variables);
      return out;
    }
  }
}

// -------------------------------------------------------------- execution

interface GqlCtx {
  store: Store;
}

type AnyObj = Record<string, unknown> & { __typename: string };
type Resolver = (obj: AnyObj, args: Record<string, unknown>, ctx: GqlCtx) => unknown;

class GqlError extends Error {}

function asRepo(obj: AnyObj): Repo {
  return obj.__repo as Repo;
}
function asIssue(obj: AnyObj): IssueItem {
  return obj.__issue as IssueItem;
}
function asPull(obj: AnyObj): PullItem {
  return obj.__pull as PullItem;
}

function repoObj(repo: Repo): AnyObj {
  return { __typename: "Repository", __repo: repo };
}
function issueObj(repo: Repo, issue: IssueItem): AnyObj {
  return { __typename: "Issue", __repo: repo, __issue: issue };
}
function pullObj(repo: Repo, pull: PullItem): AnyObj {
  return { __typename: "PullRequest", __repo: repo, __pull: pull };
}
function userObj(): AnyObj {
  return { __typename: "User" };
}

function cursorFor(index: number): string {
  return b64urlEncode(`cursor:${index}`);
}
function indexFromCursor(cursor: string | undefined): number {
  if (!cursor) return -1;
  const decoded = b64urlDecode(cursor);
  if (!decoded) return -1;
  const match = /^cursor:(\d+)$/.exec(decoded);
  return match ? Number(match[1]) : -1;
}

function connection<T>(
  items: T[],
  first: number | undefined,
  after: string | undefined,
  toNode: (item: T) => AnyObj,
): AnyObj {
  const start = indexFromCursor(after) + 1;
  const page = items.slice(start, first != null ? start + first : undefined);
  const edges = page.map((item, i) => ({
    __typename: "IssueEdge",
    node: toNode(item),
    cursor: cursorFor(start + i),
  }));
  const endIndex = start + page.length - 1;
  return {
    __typename: "Connection",
    nodes: page.map(toNode),
    edges,
    totalCount: items.length,
    pageInfo: {
      __typename: "PageInfo",
      hasNextPage: endIndex < items.length - 1,
      hasPreviousPage: start > 0,
      startCursor: page.length ? cursorFor(start) : null,
      endCursor: page.length ? cursorFor(endIndex) : null,
    },
  };
}

function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  const decoded = b64urlDecode(id);
  if (!decoded) return null;
  const [kind, ...rest] = decoded.split(":");
  if (!kind || rest.length === 0) return null;
  return { kind, parts: rest.join(":").split("/") };
}

const REPO_FIELDS: Record<string, string> = {
  id: "ID",
  databaseId: "Int",
  name: "String",
  nameWithOwner: "String",
  owner: "User",
  defaultBranchRef: "Ref",
  viewerPermission: "RepositoryPermission",
  hasIssuesEnabled: "Boolean",
  issue: "Issue",
  issues: "IssueConnection",
  pullRequest: "PullRequest",
  pullRequests: "PullRequestConnection",
  url: "URI",
  description: "String",
  visibility: "RepositoryVisibility",
};

const FIELDS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => userObj(),
    repository: (_obj, args, ctx) => {
      const repo = ctx.store.getRepo(String(args.owner), String(args.name));
      return repo ? repoObj(repo) : null;
    },
    node: (_obj, args, ctx) => {
      const decoded = decodeGlobalId(String(args.id));
      if (!decoded) return null;
      if (decoded.kind === "R") {
        const [owner, name] = decoded.parts;
        const repo = ctx.store.getRepo(owner, name);
        return repo ? repoObj(repo) : null;
      }
      if (decoded.kind === "I") {
        const [owner, name, num] = decoded.parts;
        const repo = ctx.store.getRepo(owner, name);
        const issue = repo?.issueByNumber.get(Number(num));
        return repo && issue ? issueObj(repo, issue) : null;
      }
      if (decoded.kind === "P") {
        const [owner, name, num] = decoded.parts;
        const repo = ctx.store.getRepo(owner, name);
        const pull = repo?.pullByNumber.get(Number(num));
        return repo && pull ? pullObj(repo, pull) : null;
      }
      if (decoded.kind === "U") return userObj();
      return null;
    },
    __type: (_obj, args) => {
      const name = String(args.name);
      if (name === "SearchType") {
        return {
          __typename: "__Type",
          name,
          kind: "ENUM",
          enumValues: ["ISSUE", "PULL_REQUEST", "REPOSITORY", "USER", "DISCUSSION", "COMMIT"].map(
            (n) => ({ __typename: "__EnumValue", name: n }),
          ),
          fields: null,
        };
      }
      if (name === "Repository") {
        return {
          __typename: "__Type",
          name,
          kind: "OBJECT",
          fields: Object.keys(REPO_FIELDS).map((n) => ({ __typename: "__Field", name: n })),
          enumValues: null,
        };
      }
      return null;
    },
  },
  User: {
    login: () => VIEWER.login,
    id: () => userGlobalId(VIEWER.login),
    name: () => VIEWER.name,
    email: () => VIEWER.email,
    node_id: () => userGlobalId(VIEWER.login),
  },
  Repository: {
    id: (obj) => repoGlobalId(asRepo(obj).owner, asRepo(obj).name),
    databaseId: (obj) => asRepo(obj).id,
    name: (obj) => asRepo(obj).name,
    nameWithOwner: (obj) => `${asRepo(obj).owner}/${asRepo(obj).name}`,
    owner: () => userObj(),
    url: (obj) => `https://github.com/${asRepo(obj).owner}/${asRepo(obj).name}`,
    description: (obj) => asRepo(obj).description,
    visibility: (obj) => (asRepo(obj).isPrivate ? "PRIVATE" : "PUBLIC"),
    defaultBranchRef: (obj) => {
      const repo = asRepo(obj);
      const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      return tip ? { __typename: "Ref", name: repo.defaultBranch } : null;
    },
    viewerPermission: () => "ADMIN",
    hasIssuesEnabled: () => true,
    issue: (obj, args) => {
      const repo = asRepo(obj);
      const issue = repo.issueByNumber.get(Number(args.number));
      return issue ? issueObj(repo, issue) : null;
    },
    issues: (obj, args) => {
      const repo = asRepo(obj);
      let list = [...repo.issues];
      const states = args.states as string[] | undefined;
      if (states && states.length) {
        const wanted = new Set(states.map((s) => s.toLowerCase()));
        list = list.filter((i) => wanted.has(i.state));
      }
      const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
      const direction = orderBy?.direction ?? "DESC";
      list.sort((a, b) =>
        direction === "ASC" ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq,
      );
      const first = typeof args.first === "number" ? args.first : undefined;
      const after = typeof args.after === "string" ? args.after : undefined;
      return connection(list, first, after, (issue) => issueObj(repo, issue));
    },
    pullRequest: (obj, args) => {
      const repo = asRepo(obj);
      const pull = repo.pullByNumber.get(Number(args.number));
      return pull ? pullObj(repo, pull) : null;
    },
    pullRequests: (obj, args) => {
      const repo = asRepo(obj);
      const list = [...repo.pulls].sort((a, b) => b.createdSeq - a.createdSeq);
      const first = typeof args.first === "number" ? args.first : undefined;
      const after = typeof args.after === "string" ? args.after : undefined;
      return connection(list, first, after, (pull) => pullObj(repo, pull));
    },
  },
  Ref: {
    name: (obj) => obj.name as string,
  },
  Issue: {
    id: (obj) => issueGlobalId(asRepo(obj).owner, asRepo(obj).name, asIssue(obj).number),
    number: (obj) => asIssue(obj).number,
    title: (obj) => asIssue(obj).title,
    body: (obj) => asIssue(obj).body,
    state: (obj) => asIssue(obj).state.toUpperCase(),
    url: (obj) =>
      `https://github.com/${asRepo(obj).owner}/${asRepo(obj).name}/issues/${asIssue(obj).number}`,
  },
  PullRequest: {
    id: (obj) => pullGlobalId(asRepo(obj).owner, asRepo(obj).name, asPull(obj).number),
    number: (obj) => asPull(obj).number,
    title: (obj) => asPull(obj).title,
    body: (obj) => asPull(obj).body,
    state: (obj) => {
      const pull = asPull(obj);
      if (pull.merged) return "MERGED";
      return pull.state.toUpperCase();
    },
    headRefName: (obj) => asPull(obj).headRef,
    baseRefName: (obj) => asPull(obj).baseRef,
    merged: (obj) => asPull(obj).merged,
    mergeable: (obj) => {
      const pull = asPull(obj);
      if (pull.state !== "open") return "UNKNOWN";
      return mergeConflict(asRepo(obj), pull) ? "CONFLICTING" : "MERGEABLE";
    },
    url: (obj) =>
      `https://github.com/${asRepo(obj).owner}/${asRepo(obj).name}/pull/${asPull(obj).number}`,
    files: (obj, args) => {
      const repo = asRepo(obj);
      const pull = asPull(obj);
      const headCommit = repo.objects.get(pull.headSha);
      const baseCommit = repo.objects.get(pull.baseSha);
      if (!headCommit || !baseCommit) return connection([], undefined, undefined, (x) => x);
      const changes = diffTrees(repo, parseCommit(baseCommit.data).tree, parseCommit(headCommit.data).tree);
      const first = typeof args.first === "number" ? args.first : undefined;
      const after = typeof args.after === "string" ? args.after : undefined;
      return connection(
        changes,
        first,
        after,
        (c) => ({ __typename: "PullRequestChangedFile", path: c.filename }),
      );
    },
  },
  PullRequestChangedFile: {
    path: (obj) => obj.path as string,
  },
  Connection: {
    nodes: (obj) => obj.nodes as unknown[],
    edges: (obj) => obj.edges as unknown[],
    totalCount: (obj) => obj.totalCount as number,
    pageInfo: (obj) => obj.pageInfo as AnyObj,
  },
  IssueEdge: {
    node: (obj) => obj.node as AnyObj,
    cursor: (obj) => obj.cursor as string,
  },
  PageInfo: {
    hasNextPage: (obj) => obj.hasNextPage as boolean,
    hasPreviousPage: (obj) => obj.hasPreviousPage as boolean,
    startCursor: (obj) => (obj.startCursor as string | null) ?? null,
    endCursor: (obj) => (obj.endCursor as string | null) ?? null,
  },
  __Type: {
    name: (obj) => obj.name as string,
    kind: (obj) => obj.kind as string,
    fields: (obj) => (obj.fields as unknown[] | null) ?? null,
    enumValues: (obj) => (obj.enumValues as unknown[] | null) ?? null,
  },
  __Field: {
    name: (obj) => obj.name as string,
  },
  __EnumValue: {
    name: (obj) => obj.name as string,
  },
  Mutation: {
    createIssue: (_obj, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.repositoryId));
      if (!decoded || decoded.kind !== "R") throw new GqlError("repository not found");
      const [owner, name] = decoded.parts;
      const repo = ctx.store.getRepo(owner, name);
      if (!repo) throw new GqlError("repository not found");
      const issue = ctx.store.createIssue(
        repo,
        String(input.title ?? ""),
        typeof input.body === "string" ? input.body : "",
        [],
      );
      ctx.store.bump(repo);
      return { __typename: "CreateIssuePayload", issue: issueObj(repo, issue) };
    },
    closeIssue: (_obj, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.issueId));
      if (!decoded || decoded.kind !== "I") throw new GqlError("issue not found");
      const [owner, name, num] = decoded.parts;
      const repo = ctx.store.getRepo(owner, name);
      const issue = repo?.issueByNumber.get(Number(num));
      if (!repo || !issue) throw new GqlError("issue not found");
      issue.state = "closed";
      ctx.store.bump(repo);
      return { __typename: "CloseIssuePayload", issue: issueObj(repo, issue) };
    },
    createPullRequest: (_obj, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.repositoryId));
      if (!decoded || decoded.kind !== "R") throw new GqlError("repository not found");
      const [owner, name] = decoded.parts;
      const repo = ctx.store.getRepo(owner, name);
      if (!repo) throw new GqlError("repository not found");
      const pull = ctx.store.createPull(
        repo,
        String(input.title ?? ""),
        typeof input.body === "string" ? input.body : "",
        String(input.headRefName ?? ""),
        String(input.baseRefName ?? ""),
      );
      if (!pull) throw new GqlError("head or base branch does not exist");
      ctx.store.bump(repo);
      return { __typename: "CreatePullRequestPayload", pullRequest: pullObj(repo, pull) };
    },
    mergePullRequest: (_obj, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.pullRequestId));
      if (!decoded || decoded.kind !== "P") throw new GqlError("pull request not found");
      const [owner, name, num] = decoded.parts;
      const repo = ctx.store.getRepo(owner, name);
      const pull = repo?.pullByNumber.get(Number(num));
      if (!repo || !pull) throw new GqlError("pull request not found");
      if (pull.state !== "open") throw new GqlError("pull request is already closed");
      if (mergeConflict(repo, pull)) throw new GqlError("merge conflict");
      ctx.store.seq += 1;
      const outcome = mergePull(repo, pull, ctx.store.seq);
      if (!outcome.ok) throw new GqlError("merge failed");
      ctx.store.bump(repo);
      return { __typename: "MergePullRequestPayload", pullRequest: pullObj(repo, pull) };
    },
    addComment: (_obj, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.subjectId));
      if (!decoded || decoded.kind !== "I") throw new GqlError("issue not found");
      const [owner, name, num] = decoded.parts;
      const repo = ctx.store.getRepo(owner, name);
      const issue = repo?.issueByNumber.get(Number(num));
      if (!repo || !issue) throw new GqlError("issue not found");
      ctx.store.seq += 1;
      repo.commentCounter += 1;
      const comment = {
        id: repo.commentCounter,
        nodeId: commentGlobalId(owner, name, issue.number, repo.commentCounter),
        body: String(input.body ?? ""),
        createdSeq: ctx.store.seq,
      };
      issue.comments.push(comment);
      ctx.store.bump(repo);
      return {
        __typename: "AddCommentPayload",
        commentEdge: {
          __typename: "CommentEdge",
          node: { __typename: "Comment", id: comment.nodeId, body: comment.body },
        },
      };
    },
  },
  CreateIssuePayload: {
    issue: (obj) => obj.issue as AnyObj,
    clientMutationId: () => null,
  },
  CloseIssuePayload: {
    issue: (obj) => obj.issue as AnyObj,
    clientMutationId: () => null,
  },
  CreatePullRequestPayload: {
    pullRequest: (obj) => obj.pullRequest as AnyObj,
    clientMutationId: () => null,
  },
  MergePullRequestPayload: {
    pullRequest: (obj) => obj.pullRequest as AnyObj,
    clientMutationId: () => null,
  },
  AddCommentPayload: {
    commentEdge: (obj) => obj.commentEdge as AnyObj,
    clientMutationId: () => null,
  },
  CommentEdge: {
    node: (obj) => obj.node as AnyObj,
  },
  Comment: {
    id: (obj) => obj.id as string,
    body: (obj) => obj.body as string,
  },
};

function executeSelection(
  obj: AnyObj,
  selections: Selection[],
  variables: Record<string, unknown>,
  doc: Document,
  ctx: GqlCtx,
  errors: Array<{ message: string; path: string[] }>,
  path: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const typename = obj.__typename;
  for (const sel of selections) {
    if (sel.kind === "fragment") {
      if (sel.name) {
        const frag = doc.fragments.get(sel.name);
        if (frag) {
          Object.assign(out, executeSelection(obj, frag, variables, doc, ctx, errors, path));
        }
        continue;
      }
      if (!sel.typeCondition || sel.typeCondition === typename) {
        Object.assign(out, executeSelection(obj, sel.selection, variables, doc, ctx, errors, path));
      }
      continue;
    }
    const responseKey = sel.alias ?? sel.name;
    const table = FIELDS[typename];
    const resolver = table?.[sel.name];
    if (!resolver) {
      errors.push({
        message: `Cannot query field "${sel.name}" on type "${typename}".`,
        path: [...path, responseKey],
      });
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(sel.args)) args[k] = resolveValue(v, variables);
    let value: unknown;
    try {
      value = resolver(obj, args, ctx);
    } catch (e) {
      errors.push({
        message: e instanceof Error ? e.message : "field error",
        path: [...path, responseKey],
      });
      continue;
    }
    if (value == null) {
      out[responseKey] = null;
      continue;
    }
    if (sel.selection) {
      if (Array.isArray(value)) {
        out[responseKey] = value.map((item) =>
          item && typeof item === "object"
            ? executeSelection(item as AnyObj, sel.selection!, variables, doc, ctx, errors, [
                ...path,
                responseKey,
              ])
            : item,
        );
      } else if (typeof value === "object") {
        out[responseKey] = executeSelection(value as AnyObj, sel.selection, variables, doc, ctx, errors, [
          ...path,
          responseKey,
        ]);
      } else {
        out[responseKey] = value;
      }
    } else {
      out[responseKey] = value;
    }
  }
  return out;
}

function executeOperation(
  store: Store,
  doc: Document,
  op: Operation,
  variables: Record<string, unknown>,
): Record<string, unknown> {
  const errors: Array<{ message: string; path: string[] }> = [];
  const rootType = op.op === "mutation" ? "Mutation" : "Query";
  const root: AnyObj = { __typename: rootType };
  const ctx: GqlCtx = { store };
  const data = executeSelection(root, op.selection, variables, doc, ctx, errors, []);
  if (errors.length) return { data: null, errors };
  return { data };
}

export async function handleGraphql(
  ctx: { store: Store },
  _req: IncomingMessage,
  res: ServerResponse,
  body: Buffer | null,
): Promise<boolean> {
  let requests: unknown[];
  let batched = false;
  try {
    const raw: unknown = body ? JSON.parse(body.toString("utf8")) : null;
    batched = Array.isArray(raw);
    requests = batched ? (raw as unknown[]) : [raw];
  } catch {
    jsonError(res, 400, "Request body is not valid JSON");
    return true;
  }
  const results = requests.map((request) => {
    const req = (request ?? {}) as Record<string, unknown>;
    const query = typeof req.query === "string" ? req.query : "";
    const variables =
      req.variables && typeof req.variables === "object"
        ? (req.variables as Record<string, unknown>)
        : {};
    if (!query) return { data: null, errors: [{ message: "Must provide query string." }] };
    let doc: Document;
    try {
      doc = new Parser(tokenize(query)).parseDocument();
    } catch (e) {
      return {
        data: null,
        errors: [{ message: e instanceof Error ? `Syntax Error: ${e.message}` : "Syntax Error" }],
      };
    }
    if (!doc.operations.length) {
      return { data: null, errors: [{ message: "Must provide an operation." }] };
    }
    const opName = typeof req.operationName === "string" ? req.operationName : null;
    const op =
      doc.operations.find((o) => o.name === opName) ??
      doc.operations[0];
    return executeOperation(ctx.store, doc, op, variables);
  });
  sendJson(res, 200, batched ? results : results[0]);
  return true;
}
