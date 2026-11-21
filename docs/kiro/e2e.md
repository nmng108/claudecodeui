# Browser end-to-end tests

`npm run test:e2e` drives the real UI in a browser against the real API server.
Only `kiro-cli` is replaced by a fake that speaks the v3 ACP protocol
(`server/modules/providers/tests/fixtures/kiro-fake-agent.ts`), so no Kiro
account or credits are needed and runs are repeatable.

## How it runs

- `playwright.config.ts` starts two servers: `e2e/run-server.mjs` (the API, port
  3101) and Vite (port 5174). Both ports can be changed with `E2E_SERVER_PORT`
  and `E2E_CLIENT_PORT`.
- `e2e/run-server.mjs` wipes and rebuilds `.e2e-run/` (git-ignored) on every
  start: a private `HOME`/`USERPROFILE`, an empty database, a workspace folder and
  a `kiro-cli` wrapper (`KIRO_CLI_PATH`). Nothing outside `.e2e-run/` is touched,
  so your real `~/.kiro`, `~/.cloudcli` and database are not used. An empty
  database file is pre-created so the server does not copy the legacy
  install-directory database into the sandbox.
- The fake agent runs in "home sessions" mode (`KIRO_FAKE_AGENT_HOME_SESSIONS=1`):
  it writes `session.json` and `messages.jsonl` under the sandbox `~/.kiro/sessions`
  like the real CLI, so the sidebar, history and fork paths read real files. A
  prompt can pick a scenario with a marker such as `[scenario:permission]`.
- The browser is your installed Chrome (`E2E_BROWSER_CHANNEL=chrome`, the
  default). Set `E2E_BROWSER_CHANNEL=` (empty) to use the Chromium that
  `npx playwright install chromium` downloads, or `msedge` for Edge.
- In the dev and standard Docker images the system libraries Chromium needs are
  installed and `E2E_BROWSER_CHANNEL` is empty, so the tests use the downloaded
  Chromium. Run `npx playwright install chromium` once, after rebuilding the
  image if it predates these libraries. Agents have no root, so a missing
  library (`libnss3`, `libglib-2.0`, ...) cannot be fixed at run time; add it to
  the `apt-get install` block in `docker/dev/Dockerfile` and
  `docker/standard/Dockerfile`.

## What is covered (`e2e/kiro.spec.ts`)

New session streams text and shows the tool card and the credit counter with no
uncaught error (this is the test that would have caught the `trim` crash);
the session appears in the sidebar and reopens with history; a permission request
is shown and allowing it finishes the turn; the default medium effort and /effort;
the Kiro slash-command set; /plan; Accept Edits and Bypass permission modes;
/context and /compact; the Shell tab launching kiro-cli --v3; model catalog with
per-model reasoning levels; capabilities; fork plus credit token usage; MCP add and list.

## Not covered

Anything that needs the real Kiro service (real model output, real credits,
login). Check those by hand, or with a throwaway script against `kiro-cli`
and a real key, as was done while writing the v3 upgrade.
