#!/usr/bin/env node
// Process entry point — separate from app.mjs so tests can build+inject
// without binding a socket. Fail-closed: any boot error exits nonzero with a
// clear message instead of starting a half-working server (S1/S9).
//
// The boot log: the settings, then one line as each step starts and ends,
// every line prefixed with the time since the process started. A boot that
// hangs (Redis · Keycloak · a huge store) shows its step as the last line; a
// boot that fails shows its step right above the failure line.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildApp } from "./app.mjs";
import { redactUrl } from "./auth.mjs";
import { authConfigFromEnv } from "./identity.mjs";

const HOME = process.env.AKG_HOME ?? "./.akg-data";
const STORE_DIR = process.env.AKG_STORE_DIR ?? join(HOME, "store");
const HOST = process.env.AKG_HOST ?? "127.0.0.1"; // S2: loopback only, reverse proxy handles external exposure
const PORT = Number(process.env.AKG_PORT ?? 8787);
const SIGNALS = ["SIGTERM", "SIGINT"];
const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const uptimeMs = () => Math.round(process.uptime() * 1000);
const log = (line) => console.log(`[+${uptimeMs()} ms] ${line}`);
// NAME=value as the server took it; "(기본)" when the variable is unset or empty and the default applies.
const setting = (name, value) => {
  if (value === "" || value == null) return `${name}=(없음)`;
  return process.env[name] ? `${name}=${value}` : `${name}=${value} (기본)`;
};

const auth = authConfigFromEnv(process.env);
log(`akg ${VERSION} 기동 — node ${process.version} · pid ${process.pid} · ${process.cwd()}`);
log(
  `설정: ${[
    setting("AKG_HOME", HOME),
    setting("AKG_STORE_DIR", STORE_DIR),
    setting("AKG_HOST", HOST),
    setting("AKG_PORT", PORT),
  ].join(" · ")}`,
);
log(
  `설정: ${[
    setting("AKG_FDC_URL", auth.fdcUrl),
    setting("FDC_AUTH_KEYCLOAK_ISSUER", auth.keycloakIssuer),
    setting("FDC_AUTH_KEYCLOAK_CLIENT_ID", auth.keycloakClientId),
    setting("FDC_AUTH_USERS_FILE", auth.usersFile),
    setting("FDC_AUTH_REDIS_URL", redactUrl(auth.redisUrl)),
    setting("FDC_AUTH_SESSION_NAMESPACE", auth.sessionNamespace),
  ].join(" · ")}`,
);

try {
  const app = await buildApp({ storeDir: STORE_DIR, auth, log });
  const start = performance.now();
  await app.listen({ host: HOST, port: PORT });
  log(
    `akg server listening on http://${HOST}:${PORT} (store=${STORE_DIR}) · listen ${Math.round(performance.now() - start)} ms · 기동 ${uptimeMs()} ms`,
  );
  // SIGTERM (systemd · kill) and SIGINT (Ctrl-C) close the app: the requests
  // in flight end, then the onClose hooks run (the rev table is saved). A
  // second signal ends the process at once.
  const close = (signal) => {
    for (const s of SIGNALS) process.removeListener(s, close);
    log(`${signal}: 닫는 중`);
    app.close().then(
      () => {
        log("닫힘");
        process.exit(0);
      },
      (err) => {
        console.error(`[+${uptimeMs()} ms] 닫기 실패: ${err.message}`);
        process.exit(1);
      },
    );
  };
  for (const s of SIGNALS) process.on(s, close);
} catch (err) {
  console.error(`[+${uptimeMs()} ms] akg server 기동 실패: ${err.message} (${err.constructor.name})`);
  process.exit(1);
}
