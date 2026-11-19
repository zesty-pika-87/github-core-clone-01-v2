// Entry point for the forge (v2: rebuilt for the clone hot path — the whole
// fetch response is cached per repository generation, so the entry itself
// stays thin). Runs one process on an ephemeral port, tells the trial
// environment which port to reach it on, then waits until the environment
// says the trial is finished. Nothing else lives here: the server itself is
// built in app.ts, so this file stays small and easy to reason about.

import { createServer } from "./app.ts";

const envUrl = process.env.MAKEFUN_ENV_URL ?? "";
const port = Number(process.env.PORT ?? "0");
const timeoutMs = Number(process.env.MAKEFUN_ENTRY_TIMEOUT_MS ?? "1200000");

async function json(url: string, init: RequestInit): Promise<Record<string, unknown>> {
  const res = await fetch(url, init);
  const text = await res.text();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { __raw: text, __status: res.status };
  }
}

async function run(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => resolve());
  });
  const bound = (server.address() as { port: number }).port;

  if (!envUrl) {
    console.log(`forge listening on port ${bound} (no MAKEFUN_ENV_URL set; serving until killed)`);
    await new Promise<void>(() => {
      // Stay up: no trial environment to report to.
    });
    return 0;
  }

  const deadline = Date.now() + timeoutMs;
  try {
    // Register with the trial environment; the environment may take a moment
    // to come up, so retry until the deadline instead of dying on one refusal.
    for (;;) {
      try {
        await json(`${envUrl}/register`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ port: bound }),
        });
        break;
      } catch {
        if (Date.now() > deadline) return 1;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    for (;;) {
      if (Date.now() > deadline) return 1;
      await new Promise((resolve) => setTimeout(resolve, 50));
      let done = false;
      try {
        const status = await json(`${envUrl}/done`, { method: "GET" });
        done = status.done === true;
      } catch {
        done = false;
      }
      if (done) break;
    }
    return 0;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

process.exitCode = await run();
