# Consuming akg from a local CC environment (A mode)

This is Phase 2 (design §8.1, §8.2): pull the server's `rendered/` bundle into
a local mirror with `akg sync`, then point claude-hooks' `keyword-docs`
provider at that mirror. claude-hooks itself is **not modified** — the
provider already supports a `params.index` override (D1), so switching to akg
is a 4-line `context.json` edit.

## 1. One-time setup

```sh
mkdir -p ~/.claude/akg
echo "<your-token>" > ~/.claude/akg/token
chmod 600 ~/.claude/akg/token
```

The token is a viewer-role (or higher) token issued by the akg server's user
admin CLI (`server/cli/akg-user.mjs`). `AKG_TOKEN` in the environment takes
precedence over the token file if both are set.

## 2. First sync

```sh
node bin/akg.mjs sync --server https://your-akg-server.internal
```

(Or, once `npm link` / a global install exposes the `akg` binary from
`package.json`'s `bin` field: `akg sync --server ...`.)

This writes:

```text
~/.claude/akg/
  meta.json                  # {serverUrl, rev, syncedAt}
  db-schema/  { index.json, docs/*.md }
  msg-format/ { index.json, docs/*.md }
```

`domain-skill/` is only installed with `--skills` (SKILL.md installation is
opt-in — most sessions only need the injectable docs). After the first sync,
`--server` can be omitted on later runs — it's remembered in `meta.json`.

## 3. Switch claude-hooks to read the mirror

Edit `~/.claude/context.json` (design §4 D1):

```jsonc
{
  "providers": {
    "db-schema": {
      "params": { "index": "~/.claude/akg/db-schema/index.json" },
    },
    "msg-format": {
      "params": { "index": "~/.claude/akg/msg-format/index.json" },
    },
  },
}
```

That's the entire integration surface. `keyword-docs`'s matching, dedup, and
injection-budget logic are unchanged — only the index file it reads moves
from claude-hooks' own `~/.claude/context-docs.*.json` to the akg mirror.

After editing, confirm the existing docs still inject: ask a question that
matches one of the migrated documents' keywords in a fresh CC session and
check the prompt got the injected context (or use claude-hooks' own
diagnostics for the `keyword-docs` provider, if available).

## 4. Keeping the mirror fresh

`akg sync` is a normal CLI command — trigger it however fits:

- **Manual**: run it whenever you know the corpus changed.
- **Cron**: e.g. every 15 minutes —
  `*/15 * * * * AKG_SERVER=https://your-akg-server.internal node /path/to/akg/bin/akg.mjs sync`
- **SessionStart hook (fire-and-forget)**: spawn detached with a hard
  timeout so a slow/unreachable server never delays session start (same
  pattern as claude-hooks' `obs-client.mjs` fire-and-forget POST):

  ```js
  import { spawn } from "node:child_process";
  const child = spawn("node", ["/path/to/akg/bin/akg.mjs", "sync"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  setTimeout(() => {
    try {
      child.kill();
    } catch {}
  }, 5000);
  ```

  This is illustrative only — wiring it into an actual claude-hooks
  `SessionStart` hook is out of Phase 2's scope (claude-hooks stays
  unmodified in this phase).

Regardless of trigger, `akg sync` is fail-open: if the server is down or the
network fails, it logs the reason to stderr and exits `0`. The existing
mirror is left exactly as it was — a broken/absent server never blocks a CC
session or removes previously-synced docs. The only exit codes that mean
"you need to fix something" are `1` for an auth failure (401 — your token is
wrong or revoked) or a config error (no token / no server URL resolvable).

## 5. Manual rehearsal procedure

To verify the full loop end-to-end against a real server before rolling this
out broadly:

1. Start (or confirm running) a rehearsal akg server, e.g.:

   ```sh
   AKG_HOME=<data-dir> AKG_PORT=8791 AKG_HOST=127.0.0.1 \
     node server/main.mjs &
   ```

2. Sync against it:

   ```sh
   AKG_TOKEN=<viewer-token> node bin/akg.mjs sync \
     --server http://127.0.0.1:8791 --mirror /tmp/akg-mirror-check
   ```

   Confirm it prints `synced rev <rev> (N docs)` and that
   `/tmp/akg-mirror-check/db-schema/index.json` (and `docs/*.md`) exist.

3. Point a scratch `context.json` at that mirror (§3 above, using the
   `--mirror` path) and start a CC session with `AKG_MIRROR` / a `--mirror`
   override wired into `context.json`'s `params.index` accordingly, then ask
   a question matching one of the rehearsal server's seeded documents'
   keywords and confirm the injected context shows up.
4. Stop the rehearsal server, re-run `akg sync` against the same
   `--mirror`, and confirm it fails (fail-open, exit 0, stderr explains why)
   **without deleting or corrupting the mirror** — the docs from step 2/3
   must still be readable.
