// The 검토 tab's badge: inferred slots across the corpus, plus pending
// proposals for admin (the only group that reads them).
import { api } from "./api.mjs";
import { setReviewCount } from "./shell.mjs";
import { isAdmin } from "./state.mjs";

export async function refreshReviewCount() {
  const [docs, props] = await Promise.all([
    api("/api/docs?tier=inferred"),
    isAdmin() ? api("/api/proposals?state=pending") : null,
  ]);
  const slots = docs.ok ? docs.data.docs.reduce((n, d) => n + (d.tiers?.inferred || 0), 0) : 0;
  setReviewCount(slots + (props?.ok ? props.data.proposals.length : 0));
}
