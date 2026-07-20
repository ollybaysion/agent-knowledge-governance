// Shared error type for the write-side akg CLI actions (propose,
// catalog-push — design §8.1). Distinct from src/mirror/sync.mjs's
// AkgSyncError: sync is a background pull that fails OPEN (a down server
// just means "try again next time"); propose/catalog-push are explicit
// writes a caller asked for, so bin/akg.mjs treats any AkgApiError as a
// reason to fail CLOSED (non-zero exit) — the caller needs to know the
// write did not happen.
export class AkgApiError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = "AkgApiError";
    this.status = status;
    this.body = body;
  }
}
