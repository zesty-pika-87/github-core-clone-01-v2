# github-core-clone-01-v2

[![github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/zesty-pika-87/github-core-clone-01-v2/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/zesty-pika-87/github-core-clone-01-v2/reward.svg)](https://make.fun/bounty/github-core-clone-01)

A GitHub-compatible git forge in a single Node process: smart HTTP
(`git-upload-pack` / `git-receive-pack`, protocol v2 and v0), REST v3,
GraphQL v4 and MCP — standard library only, no dependencies, no git binary.

Built for the [make.fun](https://make.fun/bounty/github-core-clone-01)
`github-core-clone-01` bounty ("Build a GitHub-compatible git forge").

## Run

```sh
MAKEFUN_SHOP_TOKEN=<token> node main.ts
```

The server binds an ephemeral port, registers it with
`$MAKEFUN_ENV_URL/register`, answers on that port, and exits when the trial
environment reports `/done`. `/healthz` answers `{"ok": true}` without auth.

## Layout

| File | What it does |
| --- | --- |
| `main.ts` | Trial lifecycle: bind, register, poll `/done`, exit. |
| `app.ts` | HTTP server, auth, routing, git smart-HTTP handlers. |
| `git.ts` | pkt-lines, objects, pack read/write, fetch planning, advertisements. |
| `store.ts` | Repos, objects, refs, issues, PRs, labels; tree ops, diffs, squash merges. |
| `rest.ts` | REST v3 surface. |
| `graphql.ts` | GraphQL v4: hand-rolled parser and executor. |
| `mcp.ts` | MCP (era `2026-07-28`): `server/discover`, `tools/list`, `tools/call`. |
| `http.ts` | Body reading and JSON/buffer replies. |
| `util.ts` | Hashing, fixed trial timestamps, global ids. |

## Performance

The clone workload is the hot path, so it is cached end to end: the v2
advertisement is a constant, ls-refs bytes and whole fetch responses
(plan + pack + sideband framing) are cached per repository generation, so
fifty concurrent identical shallow clones share one pack build. The
single-issue read is served from a serialized per-issue buffer, and the
push advertisement is cached per generation. Caches are invalidated by a
per-repo generation counter on every mutation.

## License

MIT — see [LICENSE](LICENSE).
