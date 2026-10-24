import { api } from "./api.mjs";
import { $, el, toast } from "./dom.mjs";
import { TIER_ABBR, TIER_LABEL } from "./state.mjs";

// ---------- slot address helpers (mirror server/slots.mjs) ----------
export function getSlot(body, address) {
  const tokens = address.match(/([^.[\]]+)|\[(\d+)\]/g) || [];
  let cur = body;
  for (const t of tokens) {
    if (cur == null) return undefined;
    cur = t.startsWith("[") ? cur[Number(t.slice(1, -1))] : cur[t];
  }
  return cur;
}
export function setSlot(body, address, value) {
  const tokens = address.match(/([^.[\]]+)|\[(\d+)\]/g) || [];
  let cur = body;
  for (let i = 0; i < tokens.length - 1; i++) {
    const t = tokens[i];
    cur = t.startsWith("[") ? cur[Number(t.slice(1, -1))] : cur[t];
  }
  const last = tokens[tokens.length - 1];
  if (last.startsWith("[")) cur[Number(last.slice(1, -1))] = value;
  else cur[last] = value;
}

// ---------- shared bits ----------
export function tierBadge(tier) {
  return el("span", {
    class: `b b-${TIER_ABBR[tier]}`,
    text: TIER_LABEL[tier],
  });
}
export function keywordChips(keywords) {
  return keywords.map((k) =>
    el("span", {
      class: `kw${k.inject === "pointer" ? " ptr" : ""}`,
      text: k.kw,
    }),
  );
}
export function tierMeter(tiers) {
  const order = ["scaffold", "inferred", "confirmed", "deprecated"];
  const meter = el("span", { class: "meter", "aria-hidden": "true" });
  const parts = [];
  for (const t of order) {
    if (!tiers[t]) continue;
    meter.appendChild(
      el("i", { class: `m-${TIER_ABBR[t]} f${Math.min(tiers[t], 7)}` }),
    );
    parts.push(`${TIER_LABEL[t]} ${tiers[t]}`);
  }
  if (!parts.length) parts.push("빈 문서");
  return el("span", {}, [
    meter,
    el("span", { class: "mtxt", text: parts.join(" · ") }),
  ]);
}
export function evidence(ev) {
  return (ev || []).map((e) => el("span", { class: "ev", text: e }));
}
export const shortRev = (r) => (r || "").slice(0, 7);

export function stat(value, label, klass) {
  return el("div", { class: `stat${klass ? " " + klass : ""}` }, [
    el("b", { text: value }),
    el("span", { text: label }),
  ]);
}

// The status in the reader's language: what it means for the document, not the
// enum value. "활성" alone says nothing about why anyone should care.
export const STATUS_LABEL = {
  active: "활성",
  inactive: "비활성",
  archived: "폐기",
};
export function statusBadge(status) {
  return el("span", {
    class: `chip st-${status}`,
    text: STATUS_LABEL[status] ?? status,
    title:
      status === "inactive"
        ? "주입이 꺼진 문서입니다 — 대시보드에서 열람·편집만 됩니다."
        : status === "active"
          ? "LLM 세션에 주입되는 문서입니다. 문서 단위 전역 스위치 — 모든 사용자에게 동일합니다."
          : "폐기된 문서입니다 — 기록으로만 남습니다.",
  });
}

// 단어 단위 LCS diff — 저장 전 미리보기(④)에서 무엇이 바뀌는지 보여준다.
// db-schema 슬롯과 domain-skill 필드 편집이 공유한다.
export function wordDiff(oldStr, newStr) {
  const a = oldStr.trim() ? oldStr.trim().split(/\s+/) : [];
  const b = newStr.trim() ? newStr.trim().split(/\s+/) : [];
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ t: "eq", w: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ t: "del", w: a[i] });
      i++;
    } else {
      out.push({ t: "add", w: b[j] });
      j++;
    }
  }
  while (i < n) out.push({ t: "del", w: a[i++] });
  while (j < m) out.push({ t: "add", w: b[j++] });
  return out;
}

// One chip does both jobs: shows the status (raw enum, uppercase) and — for
// an approver — toggles it on click. The tooltip carries what the state
// means AND what clicking will do, so no second button is needed.
export function statusChip(doc, onToggleStatus) {
  const meaning =
    {
      active: "LLM 세션에 주입되는 문서입니다. 문서 단위 전역 스위치 — 모든 사용자에게 동일합니다.",
      inactive: "주입이 꺼진 문서입니다 — 대시보드에서 열람·편집만 됩니다.",
      archived: "폐기된 문서입니다 — 기록으로만 남습니다.",
    }[doc.status] ?? "";
  const nextHint =
    doc.status === "active"
      ? " 클릭하면 주입을 끕니다(INACTIVE)."
      : doc.status === "inactive"
        ? " 클릭하면 주입을 켭니다(ACTIVE)."
        : "";
  const label = (doc.status || "").toUpperCase();
  if (!onToggleStatus)
    return el("span", { class: `chip st-${doc.status}`, text: label, title: meaning });
  return el("button", {
    type: "button",
    class: `chip st-${doc.status} st-toggle`,
    text: label,
    title: meaning + nextHint,
    onclick: onToggleStatus,
  });
}

// db-schema 뷰와 같은 배너 — 비활성이 실제로 무엇을 의미하는지 본문 자리에서 설명.
export function inactiveBar(doc) {
  if (doc.status !== "inactive") return null;
  return el("div", { class: "offbar" }, [
    el("b", { text: "비활성 문서입니다. " }),
    el("span", {
      text: "여기서는 그대로 읽을 수 있지만 미러로 나가지 않아 세션에 주입되지 않습니다. 주입 예산은 한 턴에 문서 2개뿐이므로, 상시 주입할 가치가 있을 때만 활성으로 바꾸세요.",
    }),
  ]);
}

// The section splitter the server's validator uses (src/skill-sections.mjs,
// served as a module). Null when it fails to load — the editor then falls
// back to the whole md.
export const skillSectionsLib = import("/lib/shared/skill-sections.mjs").catch(() => null);
// The verification-set reader (src/verify-set.mjs): template and counts.
export const verifyLib = import("/lib/shared/verify-set.mjs").catch(() => null);
// The consumer's bind rules (src/sql-bind.mjs): a picked query's SQL with the typed values.
export const sqlBindLib = import("/lib/shared/sql-bind.mjs").catch(() => null);
export const VERIFY_KEY = "답변 품질 검증 Set";
export const VERIFY_KIND_LABEL = { 1: "일반 지식", 2: "데이터 설명", 3: "데이터 연관", 4: "고도화 분석", 5: "신뢰성" };
// The score-record/v1 kind names, by the same numbers.
export const VERIFY_KIND_WIRE = { 1: "general", 2: "data", 3: "relation", 4: "advanced", 5: "reliability" };
// A record time 2026-10-14T20:08:48 as "10-14 20:08".
export const shortAt = (at) => (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(at ?? "") ? `${at.slice(5, 10)} ${at.slice(11, 16)}` : at ?? "");
// The Score band tint: 0 신뢰 불가 · 20 기본 · 40 문제 이해 · 60 쉬운 문제 · 80 탁월.
export const bandClass = (score) => `band-${Math.min(4, Math.max(0, Math.floor(Number(score) / 20)))}`;
export const VERIFY_LABEL_OF_WIRE = Object.fromEntries(Object.entries(VERIFY_KIND_WIRE).map(([k, w]) => [w, VERIFY_KIND_LABEL[k]]));

// A skill's role: main = an agent can be this skill, sub = knowledge a main
// points at. An editor's click flips it (PUT …/role); the server refuses a sub
// without ## 도메인 지식.
export const ROLE_MEANING = {
  main: "main 스킬 — 에이전트 목록에 오릅니다.",
  sub: "sub 스킬 — main 이 가리키는 지식 문서입니다. 에이전트 목록에는 오르지 않습니다.",
};
export function roleChip(doc, rev, canEdit, reload) {
  const role = doc.role ?? "main";
  const next = role === "main" ? "sub" : "main";
  if (!canEdit)
    return el("span", { class: `chip role-${role}`, text: role.toUpperCase(), title: ROLE_MEANING[role] });
  return el("button", {
    type: "button",
    class: `chip role-${role} st-toggle`,
    text: role.toUpperCase(),
    title: `${ROLE_MEANING[role]} 클릭하면 ${next} 로 바꿉니다.`,
    onclick: async () => {
      if (!confirm(`이 스킬을 ${next} 로 바꿀까요?`)) return;
      const r = await api(`/api/docs/domain-skill/${encodeURIComponent(doc.id)}/role`, {
        method: "PUT",
        headers: { "if-match": rev },
        body: { role: next },
      });
      if (r.ok) {
        toast(`${next} 로 바꿨습니다`, "ok");
        reload();
        return;
      }
      const d = r.data || {};
      toast(
        r.status === 409
          ? "다른 사람이 먼저 수정했습니다 — 문서를 다시 여세요."
          : `바꾸지 못했습니다 (${r.status})${d.details ? " — " + d.details.join(" · ") : ""}`,
        "error",
      );
    },
  });
}

// 409 data_id_conflict: the data ids another skill already has.
export function dataIdConflictText(d) {
  return (d.conflicts || []).map((c) => `데이터 id "${c.id}" 가 ${c.doc} 과 겹칩니다`).join(" · ");
}
