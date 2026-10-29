#!/usr/bin/env node
// Process entry point — separate from app.mjs so tests can build+inject
// without binding a socket. Fail-closed: any boot error exits nonzero with a
// clear message instead of starting a half-working server (S1/S9).
import { join } from "node:path";
import { buildApp } from "./app.mjs";
import { authConfigFromEnv } from "./identity.mjs";

const HOME = process.env.AKG_HOME ?? "./.akg-data";
const STORE_DIR = process.env.AKG_STORE_DIR ?? join(HOME, "store");
const HOST = process.env.AKG_HOST ?? "127.0.0.1"; // S2: loopback only, reverse proxy handles external exposure
const PORT = Number(process.env.AKG_PORT ?? 8787);

try {
  const app = await buildApp({
    storeDir: STORE_DIR,
    auth: authConfigFromEnv(process.env),
  });
  await app.listen({ host: HOST, port: PORT });
  console.log(
    `akg server listening on http://${HOST}:${PORT} (store=${STORE_DIR})`,
  );
  console.log(`로그인 길: ${app.akg.auth.path}`);
  const { revs, catalog } = app.akg.boot;
  console.log(`카탈로그: 문서 ${catalog.docs} · ${catalog.ms} ms · heap +${catalog.heapMB} MB`);
  console.log(
    revs
      ? `rev 표: 커밋 ${revs.commits} · 경로 ${revs.paths} · ${revs.ms} ms`
      : "rev 표: git 이력을 읽지 못했습니다 — rev 는 경로마다 처음 읽을 때 셉니다",
  );
} catch (err) {
  console.error(`akg server 기동 실패: ${err.message}`);
  process.exit(1);
}
