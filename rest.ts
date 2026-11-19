// REST v3 surface: the JSON shapes, status codes and headers the kit's
// rest-client expects, over the store. The one hot path — GET a single issue
// — is served from a per-issue serialized cache; everything else builds its
// JSON on demand (those routes are not timed).

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  commitPath,
  diffTrees,
  isAncestor,
  listDir,
  mergePull,
  readPath,
  walkCommits,
  type FileChange,
  type IssueItem,
  type PullItem,
  type Repo,
  type Store,
} from "./store.ts";
import { parseCommit, parseTree } from "./git.ts";
import { jsonError, parseJsonBody, sendBuffer, sendJson, splitPath } from "./http.ts";
import { trialNowIso, VIEWER, isSha40 } from "./util.ts";

export interface RestCtx {
  store: Store;
}

function userJson(): Record<string, unknown> {
  return {
    login: VIEWER.login,
    id: VIEWER.id,
    node_id: `U_${VIEWER.login}`,
    avatar_url: `https://github.com/${VIEWER.login}.png`,
    gravatar_id: "",
    url: `/api/v3/users/${VIEWER.login}`,
    html_url: `https://github.com/${VIEWER.login}`,
    type: "User",
    site_admin: false,
    name: VIEWER.name,
    email: VIEWER.email,
  };
}

function repoJson(repo: Repo): Record<string, unknown> {
  const base = `https://github.com/${repo.owner}/${repo.name}`;
  return {
    id: repo.id,
    node_id: repo.nodeId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(),
    private: repo.isPrivate,
    html_url: base,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: trialNowIso(),
    updated_at: trialNowIso(),
    pushed_at: trialNowIso(),
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: repo.issues.filter((i) => i.state === "open").length,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.isPrivate ? "private" : "public",
    forks: 0,
    open_issues: repo.issues.filter((i) => i.state === "open").length,
    watchers: 0,
    default_branch: repo.defaultBranch,
  };
}

function labelJson(
  repo: Repo,
  label: { name: string; color: string; description: string },
): Record<string, unknown> {
  return {
    id: repo.id * 1000 + label.name.length,
    node_id: `L_${repo.owner}_${repo.name}_${label.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
  };
}

function issueJson(repo: Repo, issue: IssueItem): Record<string, unknown> {
  const labels = issue.labels
    .map((name) => repo.labels.get(name))
    .filter((l): l is { name: string; color: string; description: string } => l !== undefined)
    .map((l) => labelJson(repo, l));
  return {
    id: issue.id,
    node_id: issue.nodeId,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    user: userJson(),
    labels,
    state: issue.state,
    locked: false,
    assignee: null,
    assignees: [],
    milestone: null,
    comments: issue.comments.length,
    created_at: trialNowIso(),
    updated_at: trialNowIso(),
    closed_at: issue.state === "closed" ? trialNowIso() : null,
    author_association: "OWNER",
    active_lock_reason: null,
  };
}

function commentJson(
  repo: Repo,
  issue: IssueItem,
  comment: { id: number; nodeId: string; body: string },
): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: comment.nodeId,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    issue_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    body: comment.body,
    user: userJson(),
    created_at: trialNowIso(),
    updated_at: trialNowIso(),
    author_association: "OWNER",
  };
}

function commitJson(
  repo: Repo,
  oid: string,
  commit: ReturnType<typeof parseCommit>,
): Record<string, unknown> {
  const author = {
    name: VIEWER.name,
    email: VIEWER.email,
    date: trialNowIso(),
  };
  return {
    sha: oid,
    node_id: `C_${oid}`,
    commit: {
      author,
      committer: author,
      message: commit.message,
      tree: { sha: commit.tree, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/trees/${commit.tree}` },
      url: `/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${oid}`,
      comment_count: 0,
      verification: { verified: false, reason: "unsigned", signature: null, payload: null },
    },
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${oid}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${oid}`,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${oid}/comments`,
    author: userJson(),
    committer: userJson(),
    parents: commit.parents.map((p) => ({
      sha: p,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${p}`,
      html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${p}`,
    })),
  };
}

function pullFilesOf(repo: Repo, pull: PullItem): FileChange[] {
  const headCommit = repo.objects.get(pull.headSha);
  const baseCommit = repo.objects.get(pull.baseSha);
  if (!headCommit || !baseCommit) return [];
  return diffTrees(repo, parseCommit(baseCommit.data).tree, parseCommit(headCommit.data).tree);
}

function pullJson(repo: Repo, pull: PullItem): Record<string, unknown> {
  const files = pullFilesOf(repo, pull);
  const additions = files.reduce((n, f) => n + f.additions, 0);
  const deletions = files.reduce((n, f) => n + f.deletions, 0);
  const merged = pull.merged;
  const mergeable = !merged && pull.state === "open" && mergeConflict(repo, pull) === false;
  return {
    id: pull.id,
    node_id: pull.nodeId,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    diff_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}.diff`,
    patch_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}.patch`,
    issue_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${pull.number}`,
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    user: userJson(),
    body: pull.body,
    created_at: trialNowIso(),
    updated_at: trialNowIso(),
    closed_at: pull.state === "closed" ? trialNowIso() : null,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    assignee: null,
    assignees: [],
    requested_reviewers: [],
    labels: [],
    milestone: null,
    draft: false,
    commits_url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}/commits`,
    review_comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}/comments`,
    review_comment_url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/comments{/number}`,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${pull.number}/comments`,
    statuses_url: `/api/v3/repos/${repo.owner}/${repo.name}/statuses/${pull.headSha}`,
    head: {
      label: `${repo.owner}:${pull.headRef}`,
      ref: pull.headRef,
      sha: pull.headSha,
      user: userJson(),
      repo: repoJson(repo),
    },
    base: {
      label: `${repo.owner}:${pull.baseRef}`,
      ref: pull.baseRef,
      sha: repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha,
      user: userJson(),
      repo: repoJson(repo),
    },
    author_association: "OWNER",
    auto_merge: null,
    active_lock_reason: null,
    merged,
    mergeable: pull.state === "open" ? mergeable : null,
    mergeable_state: pull.state === "open" ? (mergeable ? "clean" : "dirty") : "unknown",
    merged_by: merged ? userJson() : null,
    comments: 0,
    review_comments: 0,
    maintainer_can_modify: false,
    commits: 1,
    additions,
    deletions,
    changed_files: files.length,
  };
}

/** True when the PR cannot merge cleanly (same file changed both sides). */
export function mergeConflict(repo: Repo, pull: PullItem): boolean {
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headCommit = repo.objects.get(pull.headSha);
  const baseCommit = baseTip ? repo.objects.get(baseTip) : undefined;
  const mergeBaseCommit = repo.objects.get(pull.baseSha);
  if (!headCommit || !baseCommit || !mergeBaseCommit) return false;
  const headChanges = diffTrees(repo, parseCommit(mergeBaseCommit.data).tree, parseCommit(headCommit.data).tree);
  const baseChanges = diffTrees(repo, parseCommit(mergeBaseCommit.data).tree, parseCommit(baseCommit.data).tree);
  const baseMap = new Map(baseChanges.map((c) => [c.filename, c]));
  for (const hc of headChanges) {
    const bc = baseMap.get(hc.filename);
    if (bc && bc.blobSha !== hc.blobSha) return true;
  }
  return false;
}

function paginate<T>(
  req: IncomingMessage,
  items: T[],
  query: URLSearchParams,
): { page: T[]; link: string | null } {
  const perPage = Math.min(Math.max(Number(query.get("per_page") ?? "30") || 30, 1), 100);
  const page = Math.max(Number(query.get("page") ?? "1") || 1, 1);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  if (totalPages <= 1) return { page: slice, link: null };
  const host = req.headers.host ?? "localhost";
  const pathname = (req.url ?? "/").split("?")[0];
  const urlFor = (p: number): string =>
    `http://${host}${pathname}?per_page=${perPage}&page=${p}`;
  const links: string[] = [];
  if (page < totalPages) links.push(`<${urlFor(page + 1)}>; rel="next"`);
  if (page > 1) links.push(`<${urlFor(page - 1)}>; rel="prev"`);
  links.push(`<${urlFor(1)}>; rel="first"`);
  links.push(`<${urlFor(totalPages)}>; rel="last"`);
  return { page: slice, link: links.join(", ") };
}

function linkHeaders(link: string | null): Record<string, string> {
  return link ? { link } : {};
}

/** Fast path for GET /api/v3/repos/{o}/{r}/issues/{n}: cached serialized JSON. */
export function handleGetIssueFast(
  ctx: RestCtx,
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  name: string,
  number: number,
): boolean {
  const repo = ctx.store.getRepo(owner, name);
  if (!repo) {
    jsonError(res, 404, "Not Found");
    return true;
  }
  const issue = repo.issueByNumber.get(number);
  if (!issue) {
    jsonError(res, 404, "Not Found");
    return true;
  }
  let cached = repo.issueJsonCache.get(number);
  if (!cached) {
    cached = Buffer.from(JSON.stringify(issueJson(repo, issue)), "utf8");
    repo.issueJsonCache.set(number, cached);
  }
  sendBuffer(res, 200, cached, "application/json; charset=utf-8");
  return true;
}

export async function handleRest(
  ctx: RestCtx,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  segments: string[],
  query: URLSearchParams,
  body: Buffer | null,
): Promise<boolean> {
  const store = ctx.store;
  const json = parseJsonBody(body);

  // GET /api/v3
  if (segments.length === 0) {
    if (method !== "GET") return false;
    sendJson(
      res,
      200,
      {
        current_user_url: "/api/v3/user",
        current_user_authorizations_html_url: "https://github.com/settings/applications",
        authorizations_url: "/api/v3/authorizations",
        code_search_url: "/api/v3/search/code?q={query}{&page,per_page,sort,order}",
        commit_search_url: "/api/v3/search/commits?q={query}{&page,per_page,sort,order}",
        emails_url: "/api/v3/user/emails",
        emojis_url: "/api/v3/emojis",
        events_url: "/api/v3/events",
        feeds_url: "/api/v3/feeds",
        followers_url: "/api/v3/user/followers",
        following_url: "/api/v3/user/following{/target}",
        gists_url: "/api/v3/gists{/gist_id}",
        hub_url: "https://api.github.com/hub",
        issue_search_url: "/api/v3/search/issues?q={query}{&page,per_page,sort,order}",
        issues_url: "/api/v3/issues",
        keys_url: "/api/v3/user/keys",
        label_search_url: "/api/v3/search/labels?repository_id={repository_id}&q={query}{&page,per_page}",
        notifications_url: "/api/v3/notifications",
        organization_url: "/api/v3/orgs/{org}",
        organization_repositories_url: "/api/v3/orgs/{org}/repos{?type,page,per_page,sort}",
        organization_teams_url: "/api/v3/orgs/{org}/teams",
        public_gists_url: "/api/v3/gists/public",
        rate_limit_url: "/api/v3/rate_limit",
        repository_url: "/api/v3/repos/{owner}/{repo}",
        repository_search_url: "/api/v3/search/repositories?q={query}{&page,per_page,sort,order}",
        current_user_repositories_url: "/api/v3/user/repos{?type,page,per_page,sort}",
        starred_url: "/api/v3/user/starred{/owner}{/repo}",
        starred_gists_url: "/api/v3/gists/starred",
        user_url: "/api/v3/users/{user}",
        user_organizations_url: "/api/v3/user/orgs",
        user_repositories_url: "/api/v3/users/{user}/repos{?type,page,per_page,sort}",
        user_search_url: "/api/v3/search/users?q={query}{&page,per_page,sort,order}",
      },
      { "x-oauth-scopes": "repo, read:org" },
    );
    return true;
  }

  // GET /api/v3/meta
  if (segments[0] === "meta" && segments.length === 1) {
    if (method !== "GET") return false;
    sendJson(res, 200, { installed_version: "2.0.0" });
    return true;
  }

  // GET /api/v3/user
  if (segments[0] === "user" && segments.length === 1) {
    if (method !== "GET") return false;
    sendJson(res, 200, userJson());
    return true;
  }

  // POST /api/v3/user/repos  |  GET /api/v3/user/repos
  if (segments[0] === "user" && segments[1] === "repos" && segments.length === 2) {
    if (method === "POST") {
      const name = typeof json?.name === "string" ? json.name : "";
      if (!name || /[^A-Za-z0-9._-]/.test(name)) {
        jsonError(res, 422, "Validation Failed: name is invalid");
        return true;
      }
      const repo = store.createRepo(
        name,
        typeof json?.description === "string" ? json.description : "",
        json?.private === true,
      );
      if (!repo) {
        jsonError(res, 422, `Validation Failed: name already exists on this account`);
        return true;
      }
      sendJson(res, 201, repoJson(repo));
      return true;
    }
    if (method === "GET") {
      const { page, link } = paginate(req, store.listRepos(), query);
      sendJson(res, 200, page.map((r) => repoJson(r)), linkHeaders(link));
      return true;
    }
    return false;
  }

  if (segments[0] !== "repos") return false;
  const owner = segments[1];
  const name = segments[2];
  if (!owner || !name) return false;

  // /repos/{o}/{r}
  if (segments.length === 3) {
    if (method === "GET") {
      const repo = store.getRepo(owner, name);
      if (!repo) {
        jsonError(res, 404, "Not Found");
        return true;
      }
      sendJson(res, 200, repoJson(repo));
      return true;
    }
    if (method === "PATCH") {
      const repo = store.getRepo(owner, name);
      if (!repo) {
        jsonError(res, 404, "Not Found");
        return true;
      }
      if (typeof json?.description === "string") repo.description = json.description;
      store.bump(repo);
      sendJson(res, 200, repoJson(repo));
      return true;
    }
    if (method === "DELETE") {
      if (!store.deleteRepo(owner, name)) {
        jsonError(res, 404, "Not Found");
        return true;
      }
      res.writeHead(204, { "x-github-request-id": `req_${Date.now()}` });
      res.end();
      return true;
    }
    return false;
  }

  const sub = segments[3];
  const repo = store.getRepo(owner, name);
  if (!repo) {
    // Every sub-route under a missing repo is a 404.
    if (
      (method === "GET" || method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE") &&
      ["git", "branches", "commits", "contents", "labels", "issues", "pulls"].includes(sub)
    ) {
      jsonError(res, 404, "Not Found");
      return true;
    }
    return false;
  }

  // POST /repos/{o}/{r}/git/refs
  if (sub === "git" && segments[4] === "refs" && segments.length === 5) {
    if (method === "POST") {
      const ref = typeof json?.ref === "string" ? json.ref : "";
      const sha = typeof json?.sha === "string" ? json.sha : "";
      if (!ref.startsWith("refs/") || !isSha40(sha) || !store.lookup(repo, sha)) {
        jsonError(res, 422, "Validation Failed: ref or sha is invalid");
        return true;
      }
      if (repo.refs.has(ref)) {
        jsonError(res, 422, "Validation Failed: Reference already exists");
        return true;
      }
      repo.refs.set(ref, sha);
      store.bump(repo);
      sendJson(res, 201, {
        ref,
        node_id: `R_${ref}`,
        url: `/api/v3/repos/${owner}/${name}/git/refs/${ref.replace(/^refs\//, "")}`,
        object: { sha, type: "commit", url: `/api/v3/repos/${owner}/${name}/git/commits/${sha}` },
      });
      return true;
    }
    if (method === "GET") {
      const refs = [...repo.refs.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([ref, sha]) => ({
          ref,
          node_id: `R_${ref}`,
          url: `/api/v3/repos/${owner}/${name}/git/refs/${ref.replace(/^refs\//, "")}`,
          object: { sha, type: "commit", url: `/api/v3/repos/${owner}/${name}/git/commits/${sha}` },
        }));
      sendJson(res, 200, refs);
      return true;
    }
    return false;
  }

  // GET /repos/{o}/{r}/branches
  if (sub === "branches" && segments.length === 4) {
    if (method !== "GET") return false;
    const branches = [...repo.refs.keys()]
      .filter((r) => r.startsWith("refs/heads/"))
      .sort()
      .map((r) => {
        const branchName = r.slice("refs/heads/".length);
        const sha = repo.refs.get(r)!;
        return {
          name: branchName,
          commit: {
            sha,
            url: `/api/v3/repos/${owner}/${name}/commits/${sha}`,
          },
          protected: false,
          protection_url: `/api/v3/repos/${owner}/${name}/branches/${branchName}/protection`,
        };
      });
    sendJson(res, 200, branches);
    return true;
  }
  if (sub === "branches" && segments.length === 5) {
    if (method !== "GET") return false;
    const branchName = segments[4];
    const sha = repo.refs.get(`refs/heads/${branchName}`);
    if (!sha) {
      jsonError(res, 404, "Not Found");
      return true;
    }
    sendJson(res, 200, {
      name: branchName,
      commit: { sha, url: `/api/v3/repos/${owner}/${name}/commits/${sha}` },
      protected: false,
    });
    return true;
  }

  // GET /repos/{o}/{r}/commits
  if (sub === "commits" && segments.length === 4) {
    if (method !== "GET") return false;
    const shaParam = query.get("sha");
    const tip = shaParam
      ? repo.refs.get(`refs/heads/${shaParam}`) ?? (isSha40(shaParam) ? shaParam : undefined)
      : repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (!tip || !repo.objects.get(tip)) {
      sendJson(res, 200, []);
      return true;
    }
    const walked = walkCommits(repo, tip);
    const { page, link } = paginate(
      req,
      walked.map((w) => commitJson(repo, w.oid, w.commit)),
      query,
    );
    sendJson(res, 200, page, linkHeaders(link));
    return true;
  }
  if (sub === "commits" && segments.length === 5) {
    if (method !== "GET") return false;
    const oid = segments[4];
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== "commit") {
      jsonError(res, 404, "Not Found");
      return true;
    }
    sendJson(res, 200, commitJson(repo, oid, parseCommit(obj.data)));
    return true;
  }

  // Contents
  if (sub === "contents") {
    const path = segments.slice(4).join("/");
    const refParam = query.get("ref") ?? undefined;
    const branch = refParam ?? repo.defaultBranch;
    if (method === "GET") {
      if (!path) {
        const entries = listDir(repo, branch, "");
        if (!entries) {
          jsonError(res, 404, "Not Found");
          return true;
        }
        sendJson(res, 200, entries.map((e) => dirEntryJson(repo, "", e)));
        return true;
      }
      const hit = readPath(repo, branch, path);
      if (!hit) {
        // Maybe a directory.
        const entries = listDir(repo, branch, path);
        if (!entries) {
          jsonError(res, 404, "Not Found");
          return true;
        }
        sendJson(res, 200, entries.map((e) => dirEntryJson(repo, path, e)));
        return true;
      }
      if (hit.mode === "40000") {
        const entries = listDir(repo, branch, path);
        if (!entries) {
          jsonError(res, 404, "Not Found");
          return true;
        }
        sendJson(res, 200, entries.map((e) => dirEntryJson(repo, path, e)));
        return true;
      }
      const fileName = path.split("/").pop() ?? path;
      sendJson(res, 200, {
        type: "file",
        encoding: "base64",
        size: hit.data.length,
        name: fileName,
        path,
        content: hit.data.toString("base64"),
        sha: hit.oid,
        url: `/api/v3/repos/${owner}/${name}/contents/${path}`,
        html_url: `https://github.com/${owner}/${name}/blob/${branch}/${path}`,
        git_url: `/api/v3/repos/${owner}/${name}/git/blobs/${hit.oid}`,
        download_url: `https://raw.githubusercontent.com/${owner}/${name}/${branch}/${path}`,
        _links: {
          git: `/api/v3/repos/${owner}/${name}/git/blobs/${hit.oid}`,
          self: `/api/v3/repos/${owner}/${name}/contents/${path}`,
          html: `https://github.com/${owner}/${name}/blob/${branch}/${path}`,
        },
      });
      return true;
    }
    if (method === "PUT") {
      const message = typeof json?.message === "string" ? json.message : "Update file";
      const contentB64 = typeof json?.content === "string" ? json.content : "";
      const sha = typeof json?.sha === "string" ? json.sha : undefined;
      const putBranch = typeof json?.branch === "string" ? json.branch : branch;
      if (!contentB64) {
        jsonError(res, 422, "Validation Failed: content is required");
        return true;
      }
      let content: Buffer;
      try {
        content = Buffer.from(contentB64, "base64");
      } catch {
        jsonError(res, 422, "Validation Failed: content is not valid base64");
        return true;
      }
      const existing = readPath(repo, putBranch, path);
      if (existing) {
        if (!sha) {
          jsonError(res, 422, "Validation Failed: sha is required to update a file");
          return true;
        }
        if (sha !== existing.oid) {
          jsonError(res, 409, "Conflict: sha does not match the current file");
          return true;
        }
      }
      const { commitOid, blobOid } = commitPath(repo, putBranch, path, content, message);
      store.bump(repo);
      const fileName = path.split("/").pop() ?? path;
      sendJson(res, existing ? 200 : 201, {
        content: {
          name: fileName,
          path,
          sha: blobOid,
          size: content.length,
          url: `/api/v3/repos/${owner}/${name}/contents/${path}`,
          html_url: `https://github.com/${owner}/${name}/blob/${putBranch}/${path}`,
          git_url: `/api/v3/repos/${owner}/${name}/git/blobs/${blobOid}`,
          download_url: `https://raw.githubusercontent.com/${owner}/${name}/${putBranch}/${path}`,
          type: "file",
          encoding: "base64",
          _links: {
            git: `/api/v3/repos/${owner}/${name}/git/blobs/${blobOid}`,
            self: `/api/v3/repos/${owner}/${name}/contents/${path}`,
            html: `https://github.com/${owner}/${name}/blob/${putBranch}/${path}`,
          },
        },
        commit: {
          sha: commitOid,
          node_id: `C_${commitOid}`,
          message,
          author: { name: VIEWER.name, email: VIEWER.email, date: trialNowIso() },
          committer: { name: VIEWER.name, email: VIEWER.email, date: trialNowIso() },
          url: `/api/v3/repos/${owner}/${name}/commits/${commitOid}`,
          html_url: `https://github.com/${owner}/${name}/commit/${commitOid}`,
        },
      });
      return true;
    }
    if (method === "DELETE") {
      const message = typeof json?.message === "string" ? json.message : "Delete file";
      const sha = typeof json?.sha === "string" ? json.sha : undefined;
      const delBranch = typeof json?.branch === "string" ? json.branch : branch;
      const existing = readPath(repo, delBranch, path);
      if (!existing) {
        jsonError(res, 404, "Not Found");
        return true;
      }
      if (!sha || sha !== existing.oid) {
        jsonError(res, 409, "Conflict: sha does not match the current file");
        return true;
      }
      const { commitOid } = commitPath(repo, delBranch, path, null, message);
      store.bump(repo);
      sendJson(res, 200, {
        commit: {
          sha: commitOid,
          node_id: `C_${commitOid}`,
          message,
          author: { name: VIEWER.name, email: VIEWER.email, date: trialNowIso() },
          committer: { name: VIEWER.name, email: VIEWER.email, date: trialNowIso() },
          url: `/api/v3/repos/${owner}/${name}/commits/${commitOid}`,
          html_url: `https://github.com/${owner}/${name}/commit/${commitOid}`,
        },
      });
      return true;
    }
    return false;
  }

  // Labels
  if (sub === "labels" && segments.length === 4) {
    if (method === "GET") {
      sendJson(res, 200, [...repo.labels.values()].map((l) => labelJson(repo, l)));
      return true;
    }
    if (method === "POST") {
      const labelName = typeof json?.name === "string" ? json.name : "";
      if (!labelName) {
        jsonError(res, 422, "Validation Failed: name is required");
        return true;
      }
      if (repo.labels.has(labelName)) {
        jsonError(res, 422, "Validation Failed: label already exists");
        return true;
      }
      const label = {
        name: labelName,
        color: typeof json?.color === "string" ? json.color : "ededed",
        description: typeof json?.description === "string" ? json.description : "",
      };
      repo.labels.set(labelName, label);
      store.bump(repo);
      sendJson(res, 201, labelJson(repo, label));
      return true;
    }
    return false;
  }

  // Issues
  if (sub === "issues" && segments.length === 4) {
    if (method === "POST") {
      const title = typeof json?.title === "string" ? json.title : "";
      if (!title) {
        jsonError(res, 422, "Validation Failed: title is required");
        return true;
      }
      const labelNames = Array.isArray(json?.labels)
        ? (json.labels as unknown[]).filter((l): l is string => typeof l === "string")
        : [];
      for (const l of labelNames) {
        if (!repo.labels.has(l)) {
          jsonError(res, 422, `Validation Failed: label "${l}" does not exist`);
          return true;
        }
      }
      const issue = store.createIssue(
        repo,
        title,
        typeof json?.body === "string" ? json.body : "",
        labelNames,
      );
      store.bump(repo);
      sendJson(res, 201, issueJson(repo, issue));
      return true;
    }
    if (method === "GET") {
      const state = query.get("state") ?? "open";
      const sort = query.get("sort") ?? "created";
      const direction = query.get("direction") ?? "desc";
      let list = [...repo.issues];
      if (state !== "all") list = list.filter((i) => i.state === state);
      list.sort((a, b) =>
        sort === "created"
          ? direction === "asc"
            ? a.createdSeq - b.createdSeq
            : b.createdSeq - a.createdSeq
          : 0,
      );
      const { page, link } = paginate(req, list, query);
      sendJson(res, 200, page.map((i) => issueJson(repo, i)), linkHeaders(link));
      return true;
    }
    return false;
  }

  if (sub === "issues" && segments.length >= 5) {
    const number = Number(segments[4]);
    if (!Number.isInteger(number)) return false;
    const issue = repo.issueByNumber.get(number);
    if (segments.length === 5) {
      if (method === "GET") {
        return handleGetIssueFast(ctx, req, res, owner, name, number);
      }
      if (method === "PATCH") {
        if (!issue) {
          jsonError(res, 404, "Not Found");
          return true;
        }
        if (typeof json?.title === "string") issue.title = json.title;
        if (typeof json?.body === "string") issue.body = json.body;
        if (json?.state === "open" || json?.state === "closed") issue.state = json.state;
        store.seq += 1;
        issue.updatedSeq = store.seq;
        store.bump(repo);
        sendJson(res, 200, issueJson(repo, issue));
        return true;
      }
      return false;
    }
    if (segments[5] === "comments" && segments.length === 6) {
      if (method === "GET") {
        if (!issue) {
          jsonError(res, 404, "Not Found");
          return true;
        }
        sendJson(res, 200, issue.comments.map((c) => commentJson(repo, issue, c)));
        return true;
      }
      if (method === "POST") {
        if (!issue) {
          jsonError(res, 404, "Not Found");
          return true;
        }
        const commentBody = typeof json?.body === "string" ? json.body : "";
        if (!commentBody) {
          jsonError(res, 422, "Validation Failed: body is required");
          return true;
        }
        store.seq += 1;
        repo.commentCounter += 1;
        const comment = {
          id: repo.commentCounter,
          nodeId: `C_${repo.owner}_${repo.name}_${issue.number}_${repo.commentCounter}`,
          body: commentBody,
          createdSeq: store.seq,
        };
        issue.comments.push(comment);
        store.bump(repo);
        sendJson(res, 201, commentJson(repo, issue, comment));
        return true;
      }
      return false;
    }
    return false;
  }

  // Pulls
  if (sub === "pulls" && segments.length === 4) {
    if (method === "POST") {
      const title = typeof json?.title === "string" ? json.title : "";
      const head = typeof json?.head === "string" ? json.head : "";
      const base = typeof json?.base === "string" ? json.base : "";
      if (!title || !head || !base) {
        jsonError(res, 422, "Validation Failed: title, head and base are required");
        return true;
      }
      const headName = head.includes(":") ? head.split(":").pop()! : head;
      const baseName = base.includes(":") ? base.split(":").pop()! : base;
      if (!repo.refs.has(`refs/heads/${headName}`) || !repo.refs.has(`refs/heads/${baseName}`)) {
        jsonError(res, 422, "Validation Failed: head or base branch does not exist");
        return true;
      }
      const pull = store.createPull(
        repo,
        title,
        typeof json?.body === "string" ? json.body : "",
        headName,
        baseName,
      );
      if (!pull) {
        jsonError(res, 422, "Validation Failed: could not create pull request");
        return true;
      }
      store.bump(repo);
      sendJson(res, 201, pullJson(repo, pull));
      return true;
    }
    if (method === "GET") {
      const state = query.get("state") ?? "open";
      let list = [...repo.pulls];
      if (state !== "all") list = list.filter((p) => p.state === state);
      list.sort((a, b) => b.createdSeq - a.createdSeq);
      const { page, link } = paginate(req, list, query);
      sendJson(res, 200, page.map((p) => pullJson(repo, p)), linkHeaders(link));
      return true;
    }
    return false;
  }

  if (sub === "pulls" && segments.length >= 5) {
    const number = Number(segments[4]);
    if (!Number.isInteger(number)) return false;
    const pull = repo.pullByNumber.get(number);
    if (segments.length === 5) {
      if (method !== "GET") return false;
      if (!pull) {
        jsonError(res, 404, "Not Found");
        return true;
      }
      sendJson(res, 200, pullJson(repo, pull));
      return true;
    }
    if (segments[5] === "files" && segments.length === 6) {
      if (method !== "GET") return false;
      if (!pull) {
        jsonError(res, 404, "Not Found");
        return true;
      }
      const files = pullFilesOf(repo, pull).map((f) => ({
        sha: f.blobSha,
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        changes: f.changes,
        blob_url: `/api/v3/repos/${owner}/${name}/git/blobs/${f.blobSha}`,
        raw_url: `https://github.com/${owner}/${name}/raw/${pull.headSha}/${f.filename}`,
        contents_url: `/api/v3/repos/${owner}/${name}/contents/${f.filename}?ref=${pull.headRef}`,
      }));
      sendJson(res, 200, files);
      return true;
    }
    if (segments[5] === "merge" && segments.length === 6) {
      if (method !== "PUT") return false;
      if (!pull) {
        jsonError(res, 404, "Not Found");
        return true;
      }
      if (pull.state !== "open") {
        jsonError(res, 405, "Validation Failed: pull request is already closed");
        return true;
      }
      if (mergeConflict(repo, pull)) {
        jsonError(res, 405, "Merge conflict: the pull request cannot be merged cleanly");
        return true;
      }
      store.seq += 1;
      const outcome = mergePull(repo, pull, store.seq);
      if (!outcome.ok || !outcome.sha) {
        jsonError(res, 405, "Merge conflict: the pull request cannot be merged cleanly");
        return true;
      }
      store.bump(repo);
      sendJson(res, 200, {
        sha: outcome.sha,
        merged: true,
        message: `Pull Request #${pull.number} successfully merged`,
      });
      return true;
    }
    return false;
  }

  return false;
}

function dirEntryJson(
  repo: Repo,
  dirPath: string,
  entry: { mode: string; name: string; oid: string },
): Record<string, unknown> {
  const path = dirPath ? `${dirPath}/${entry.name}` : entry.name;
  const isDir = entry.mode === "40000";
  return {
    type: isDir ? "dir" : "file",
    size: isDir ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0),
    name: entry.name,
    path,
    sha: entry.oid,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/tree/${repo.defaultBranch}/${path}`,
    git_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/trees/${entry.oid}`,
    download_url: isDir ? null : `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${repo.defaultBranch}/${path}`,
    _links: {
      git: `/api/v3/repos/${repo.owner}/${repo.name}/git/trees/${entry.oid}`,
      self: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
      html: `https://github.com/${repo.owner}/${repo.name}/tree/${repo.defaultBranch}/${path}`,
    },
  };
}
