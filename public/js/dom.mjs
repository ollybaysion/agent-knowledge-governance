// ---------- DOM helper ----------
export function el(tag, attrs, children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on") && typeof v === "function")
      node.addEventListener(k.slice(2), v);
    else if (v !== false && v != null)
      node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of [].concat(children || [])) {
    if (c == null) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}
export const $ = (id) => document.getElementById(id);

// Save an in-memory string as a client-side download. No server round-trip: it
// reuses text api() already fetched. CSP-safe: a `download` anchor is not a
// fetch the `default-src 'self'` policy governs.
export function downloadTextFile(filename, text, mime) {
  const blob = new Blob([text], { type: mime || "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

// ---------- toast (prototype pattern — reused for notices/errors) ----------
export let toastTimer = null;
export function toast(message, klass) {
  const t = $("toast");
  t.replaceChildren(el("div", { class: klass || "", text: message }));
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 4200);
}

// ---------- JSON 보기 패널 (승인자 전용 — 문서를 좌우로 갈라 원본 store JSON) ----------
// 모달로 문서를 덮지 않고, 문서 뷰를 좌우로 갈라 오른쪽에 붙인다 — 렌더된 문서와
// 원본 JSON 을 나란히 대조하며 승격을 판단하게. renderInner 가 다시 그릴 때마다
// 최신 doc 으로 새로 만들어지므로 편집·승격 직후 JSON 도 즉시 갱신된다(상태는
// 여는 여부뿐). CSP(script-src 'self') 아래라 인라인 없이 el/addEventListener 로만.
export function jsonPane(title, obj, onClose) {
  const pretty = JSON.stringify(obj, null, 2);
  return el("aside", { class: "json-pane", "aria-label": "원본 JSON" }, [
    el("div", { class: "jm-head" }, [
      el("span", { class: "jm-title", text: title }),
      el("button", {
        type: "button",
        class: "btn ghost sm",
        text: "복사",
        onclick: async () => {
          try {
            await navigator.clipboard.writeText(pretty);
            toast("JSON 을 복사했습니다.");
          } catch {
            toast("복사할 수 없습니다 — 텍스트를 직접 선택해 복사하세요.", "error");
          }
        },
      }),
      el("button", {
        type: "button",
        class: "btn ghost sm",
        "aria-label": "JSON 패널 닫기",
        text: "✕",
        onclick: onClose,
      }),
    ]),
    el("pre", { class: "jm-body", text: pretty }),
  ]);
}
