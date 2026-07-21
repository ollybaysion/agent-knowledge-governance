# Consuming and producing with akg from a local CC environment

Phase 2 (design §8.1, §8.2, sections 1-5 below): pull the server's
`rendered/` bundle into a local mirror with `akg sync`, then point
claude-hooks' `keyword-docs` provider at that mirror. claude-hooks itself is
**not modified** — the provider already supports a `params.index` override
(D1), so switching to akg is a 4-line `context.json` edit.

Phase 3 (design §8.1, section 6 below): push changes back to the hub with
`akg propose` and `akg catalog-push` — the CLI's write side.

**Only active documents are in the bundle.** A document can also be `inactive`
— present on the server and readable through the API and dashboard, but not
rendered, not indexed, and so never mirrored or injected (issue #7). That is
where bulk-loaded documents land: the injection budget is two documents per
turn, so a hundred skeletons landing straight into the corpus would crowd out
the ones somebody actually confirmed. An approver activates the few worth
carrying. If a document you expect is missing from the mirror, check its
status before suspecting the sync.

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

## 6. Producing: `akg propose` and `akg catalog-push`

Unlike `sync`, these are explicit writes a caller asked for — they **fail
closed**: any failure (network, auth, validation, a 404) prints the reason to
stderr and exits `1`, so a calling skill/script can tell the write did not
happen. Both need a token with at least the `agent` role.

### `akg propose <type>/<id> <proposal.json>`

Submits a slot-level proposal to the hub's review queue (`POST
/api/proposals`) — the exit for claude-hooks' `db-schema-propose-codebase`
skill: it hands its proposal here instead of applying it to a local file.

`<type>/<id>` is e.g. `db-schema/t.sensor`. `proposal.json` holds the slots to
propose, keyed by slot address:

```json
{
  "slots": {
    "purpose": {
      "text": "센서 원시값 로그 테이블.",
      "tier": "inferred",
      "evidence": ["ingest.py:12"]
    }
  }
}
```

```sh
node bin/akg.mjs propose db-schema/t.sensor proposal.json
```

Prints `proposed db-schema/t.sensor: <uuid>` (201) or `proposal already
pending: <uuid>` (200 — an identical resubmission dedups against the pending
queue, S8; safe to retry). A human reviews and adopts/rejects it from the
dashboard or `POST /api/proposals/:id/adopt|reject` — this CLI only submits,
it never adopts (adoption is an editor-role action).

### `akg catalog-push <owner.table> <describe.json>`

Pushes a fresh `describe_table` result (agent-db-plugin MCP output shape —
`columns`/`primaryKey`/`foreignKeys`/`indexes`/`numRows`/`lastAnalyzed`/
`tableComment`) into a db-schema doc's `catalog` field (`PUT
/api/docs/db-schema/:id/catalog`) — the exit for claude-hooks'
`db-schema-docs` skill: schema-doc generation moves from "write a local md
file" to "push the raw schema to the hub." This only ever replaces the
**auto/fact** half of the doc (`catalog`); every human-authored slot
(`purpose`, `columnDescs`, `queries`) is left alone, except that a column
which vanished from the new catalog has its `columnDescs` entry dropped (if
still `scaffold`, i.e. never annotated) or marked `deprecated` (if it carried
real text) — never silently deleted.

```sh
node bin/akg.mjs catalog-push t.sensor describe.json
```

Prints `catalog pushed: db-schema/t.sensor (rev <rev>)`. The target doc must
already exist — this route never creates one; a 404 means propose (or the
dashboard) needs to create it first.

## 7. Bulk intake: `POST .../batch` and `PUT .../facts`

These are HTTP routes, not CLI subcommands yet — the importer that will call
them (akg-collector) drives them directly.

### `POST /api/docs/:type/batch` (editor or agent)

N documents in **one commit**, for the case `POST /api/docs/:type` was never
meant to carry: a schema import of a few hundred tables.

```json
{ "runId": "import-2026-07-22", "docs": [/* full documents */] }
```

Everything it creates **lands `inactive`**, whatever the payload says. That is
the route's reason to exist: an import cannot reach a prompt, so the decision
to inject stays with an approver (issue #7). Nothing else about the corpus can
be changed here — an id that already exists is a 409 for the whole batch.

It is **all or nothing**. One invalid document rejects the batch with a
per-document reason, and nothing is written; a half-applied import would leave
the caller to work out which half landed.

Chunk it. The body limit is 512 KiB — measured, that is roughly **200
db-schema documents of a dozen columns**. Past it the route answers `413
payload_too_large` with the limit and a note to split, rather than Fastify's
bare "body too large".

`runId` is optional and goes into the commit message, so the audit view shows
which run produced a document. There is no per-document author field for
machine writes, because facts carry no tier and the slots a batch creates are
empty (issue #12, §7-3).

### `PUT /api/docs/:type/:id/facts` (editor or agent)

`catalog-push` for every type, and it **creates the document if absent**
(landing `inactive`, as above). Send a whole body; the route takes the facts
and **ignores the slot values in it entirely**:

- a slot address that survives keeps the value it already had — including
  `confirmed`
- a slot address the new facts introduce starts empty (`scaffold`). A machine
  replacing facts has no standing to assert an interpretation; that is what
  `propose` is for
- a slot address the new facts no longer have is an orphan, and follows the
  rule `catalog-push` set: dropped if never annotated, kept as `deprecated`
  if it carried real text. The response lists them under `orphans`

No per-type branching is involved: a slot is wherever the type schema says
`$ref: common/tiered-value.v1`, so this works the same for `db-schema` and
`msg-format`. `PUT /api/docs/db-schema/:id/catalog` still exists and is
unchanged.

Note that an `agent` token can write facts but cannot read documents back
(`GET` needs `viewer`, and `agent` sits outside that ladder — D6), and cannot
activate anything. That asymmetry is the safety argument for letting machines
write here at all.
