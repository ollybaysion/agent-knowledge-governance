#!/usr/bin/env node
// Process entry point — separate from app.mjs so tests can build+inject
// without binding a socket. Fail-closed: any boot error exits nonzero with a
// clear message instead of starting a half-working server (S1/S9).
import { join } from "node:path";
import { buildApp } from "./app.mjs";
import { acquireStoreLock } from "./lock.mjs";

const HOME = process.env.AKG_HOME ?? "./.akg-data";
const STORE_DIR = process.env.AKG_STORE_DIR ?? join(HOME, "store");
const USERS_PATH = process.env.AKG_USERS_PATH ?? join(HOME, "users.json");
const HOST = process.env.AKG_HOST ?? "127.0.0.1"; // S2: loopback only, reverse proxy handles external exposure
const PORT = Number(process.env.AKG_PORT ?? 8787);

// The lock belongs to the process, not to an app object, which is why it is
// taken here rather than in buildApp() — tests build many apps in one process
// and have no business contending for it.
let lock = null;

// Release on every ordinary way this process ends. 'exit' covers a normal
// return and an explicit process.exit; the signals are how a service manager
// or a terminal stops it, and none of them fires 'exit' by itself. SIGKILL and
// power loss leave the file behind — that is what lock.mjs's stale-holder
// recovery is for.
process.on("exit", () => lock?.release());
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    lock?.release();
    process.exit(0);
  });
}

try {
  lock = await acquireStoreLock(STORE_DIR);
  const app = await buildApp({ storeDir: STORE_DIR, usersPath: USERS_PATH });
  await app.listen({ host: HOST, port: PORT });
  console.log(
    `akg server listening on http://${HOST}:${PORT} (store=${STORE_DIR})`,
  );
} catch (err) {
  console.error(`akg server 기동 실패: ${err.message}`);
  process.exit(1);
}
