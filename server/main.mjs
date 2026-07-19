#!/usr/bin/env node
// Process entry point — separate from app.mjs so tests can build+inject
// without binding a socket. Fail-closed: any boot error exits nonzero with a
// clear message instead of starting a half-working server (S1/S9).
import { join } from "node:path";
import { buildApp } from "./app.mjs";

const HOME = process.env.AKG_HOME ?? "./.akg-data";
const STORE_DIR = process.env.AKG_STORE_DIR ?? join(HOME, "store");
const USERS_PATH = process.env.AKG_USERS_PATH ?? join(HOME, "users.json");
const HOST = process.env.AKG_HOST ?? "127.0.0.1"; // S2: loopback only, reverse proxy handles external exposure
const PORT = Number(process.env.AKG_PORT ?? 8787);

try {
  const app = await buildApp({ storeDir: STORE_DIR, usersPath: USERS_PATH });
  await app.listen({ host: HOST, port: PORT });
  console.log(
    `akg server listening on http://${HOST}:${PORT} (store=${STORE_DIR})`,
  );
} catch (err) {
  console.error(`akg server 기동 실패: ${err.message}`);
  process.exit(1);
}
