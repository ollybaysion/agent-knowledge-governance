// 미리보기 카드: 문서 링크(a[data-key])를 가리키거나 키보드 초점이 오면
// 제목 · 타입 · 상태 · 수정 · 첫 줄들을 띄운다. 카드는 화면 위에 뜨는 층이라
// 본문의 자리를 밀지 않는다. Esc 가 닫는다. 카드 위로 포인터를 옮기면 그대로 남는다.
import { allDocs, api } from "./api.mjs";
import { freshBadge, typeTag } from "./doc-bits.mjs";
import { el } from "./dom.mjs";
import { firstLines } from "/lib/health.mjs";

const SHOW_MS = 350;
const HIDE_MS = 140;
const GAP = 8;
const CARD_ID = "hovercard";

let card = null; // 떠 있는 카드
let anchor = null; // 카드가 붙은 링크
let pending = null; // 띄우기를 기다리는 링크
let showTimer = 0;
let hideTimer = 0;
const bodies = new Map(); // "type/id" → {rev, lines}

const linkOf = (target) => (target instanceof Element ? target.closest("a[data-key]") : null);

function place(node, at) {
  const r = at.getBoundingClientRect();
  const w = node.offsetWidth;
  const h = node.offsetHeight;
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const below = r.bottom + GAP + h <= vh || r.top - GAP - h < 0;
  const left = Math.max(8, Math.min(r.left, vw - w - 8));
  const top = below ? Math.min(r.bottom + GAP, Math.max(8, vh - h - 8)) : r.top - GAP - h;
  node.style.left = `${Math.round(left)}px`;
  node.style.top = `${Math.round(top)}px`;
}

function hide() {
  clearTimeout(showTimer);
  clearTimeout(hideTimer);
  pending = null;
  if (anchor?.getAttribute("aria-describedby") === CARD_ID) anchor.removeAttribute("aria-describedby");
  card?.remove();
  card = null;
  anchor = null;
}

async function linesOf(doc) {
  const key = `${doc.type}/${doc.id}`;
  const hit = bodies.get(key);
  if (hit && hit.rev === doc.rev) return hit.lines;
  const r = await api(`/api/docs/${doc.type}/${encodeURIComponent(doc.id)}`);
  const lines = r.ok ? firstLines(r.data?.md) : null;
  if (lines) bodies.set(key, { rev: r.data.rev ?? doc.rev, lines });
  return lines;
}

async function show(link) {
  const key = link.getAttribute("data-key");
  const docs = await allDocs();
  if (pending !== link || !link.isConnected) return;
  pending = null;
  const doc = docs.find((d) => `${d.type}/${d.id}` === key);
  if (!doc) return;
  hide();
  const title = String(doc.title ?? "").trim();
  // 첫 줄 자리는 세 줄 높이를 미리 잡는다: 글이 와도 카드 크기가 그대로다.
  const body = el("div", { class: "hcard-body" }, el("span", { class: "dim", text: "불러오는 중…" }));
  const kws = (doc.keywords ?? []).map((k) => k.kw).filter((k) => k !== doc.id).slice(0, 4);
  card = el("div", { class: "hcard", id: CARD_ID, role: "tooltip" }, [
    el("div", { class: "hcard-meta" }, [
      typeTag(doc.type),
      doc.status === "inactive" ? el("span", { class: "mini-off", text: "비활성" }) : null,
      el("span", { class: "sp" }),
      freshBadge(doc.updatedAt),
    ]),
    el("div", { class: "hcard-title", text: title || doc.id }),
    title && title !== doc.id ? el("div", { class: "hcard-id mono dim", text: doc.id }) : null,
    body,
    kws.length ? el("div", { class: "hcard-kw dim", text: kws.join(" · ") }) : null,
  ]);
  card.addEventListener("pointerenter", () => clearTimeout(hideTimer));
  card.addEventListener("pointerleave", () => (hideTimer = setTimeout(hide, HIDE_MS)));
  anchor = link;
  document.body.appendChild(card);
  place(card, link);
  link.setAttribute("aria-describedby", CARD_ID);
  const mine = card;
  const lines = await linesOf(doc);
  if (card !== mine) return;
  body.replaceChildren(
    ...(lines == null
      ? [el("span", { class: "dim", text: "본문을 불러오지 못했습니다" })]
      : lines.length
        ? lines.map((t) => el("p", { text: t }))
        : [el("span", { class: "dim", text: "본문에 글 줄이 없습니다" })]),
  );
}

function queue(link) {
  if (link === anchor) return clearTimeout(hideTimer);
  clearTimeout(showTimer);
  pending = link;
  showTimer = setTimeout(() => show(link), SHOW_MS);
}

function leave(link) {
  if (pending === link) {
    clearTimeout(showTimer);
    pending = null;
  }
  if (anchor === link) {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, HIDE_MS);
  }
}

/** 문서 링크의 미리보기 카드를 켠다. 부팅 때 한 번 부른다. */
export function bindHoverCards() {
  document.addEventListener("pointerover", (e) => {
    if (e.pointerType === "touch") return;
    const link = linkOf(e.target);
    if (link) queue(link);
  });
  document.addEventListener("pointerout", (e) => {
    const link = linkOf(e.target);
    if (link && !link.contains(e.relatedTarget)) leave(link);
  });
  // 키보드: Tab 으로 링크에 오면 같은 카드가 뜬다.
  document.addEventListener("focusin", (e) => {
    const link = linkOf(e.target);
    if (link && link.matches(":focus-visible")) queue(link);
  });
  document.addEventListener("focusout", (e) => {
    const link = linkOf(e.target);
    if (link) leave(link);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && (card || pending)) hide();
  });
  document.addEventListener("pointerdown", hide);
  window.addEventListener("hashchange", hide);
  window.addEventListener("scroll", hide, { passive: true, capture: true });
  window.addEventListener("resize", hide);
}
