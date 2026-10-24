// manual: steps on one screen, each a line of text and a capture. Read as
// one boxless section 단계; 편집 opens the step editor (text · capture upload
// · order) in its place. The screen is the doc's rel:"screen" link.
import { api } from "../api.mjs";
import { el, toast } from "../dom.mjs";
import { inline } from "../md.mjs";
import { sec } from "../sec.mjs";

const CAPTURE_TYPES = ["image/png", "image/jpeg", "image/webp"];
const CAPTURE_LIMIT = 2 * 1024 * 1024;

function captureImg(step, cls) {
  return el("img", {
    class: cls,
    src: `/api/assets/${step.asset}`,
    width: step.width,
    height: step.height,
    alt: step.text || "캡처",
    loading: "lazy",
    onerror: (e) => e.currentTarget.replaceWith(el("p", { class: "mn-nocap dim", text: `캡처를 불러오지 못했습니다 (${step.asset.slice(0, 8)})` })),
  });
}

async function uploadCapture(file) {
  if (!CAPTURE_TYPES.includes(file.type)) return { error: "PNG · JPEG · WebP 그림만 올립니다." };
  if (file.size > CAPTURE_LIMIT) return { error: "캡처는 2MB 까지 올립니다." };
  const r = await api("/api/assets", { method: "POST", headers: { "content-type": file.type }, raw: file });
  if (r.ok) return { step: { asset: r.data.sha256, width: r.data.width, height: r.data.height } };
  if (r.status === 403) return { error: "admin 만 할 수 있습니다." };
  if (r.status === 413) return { error: "캡처는 2MB 까지 올립니다." };
  if (r.status === 400 || r.status === 415) return { error: "그림을 읽지 못했습니다 — PNG · JPEG · WebP 인지 보세요." };
  return { error: `올리기 실패 (${r.status || "네트워크"})` };
}

export function manualBody(ctx, host) {
  const { doc, canEdit, reload, wiki } = ctx;
  const b = doc.body;
  const steps = b.steps || [];
  const screen = (doc.links || []).find((l) => l.rel === "screen");
  const intro = screen
    ? el("p", { class: "doc-intro" }, ["화면 ", el("a", { href: `#/doc/${screen.type}/${encodeURIComponent(screen.id)}`, text: screen.id })])
    : el("p", { class: "doc-intro warn", text: "화면 연결이 없습니다 — 연결 고치기에서 관계 screen 으로 screen-map 문서를 고르세요. 활성화하려면 하나 있어야 합니다." });

  function read() {
    host.replaceChildren(
      intro,
      sec({
        key: "단계",
        title: `단계 ${steps.length}`,
        onEdit: canEdit ? edit : null,
        children: steps.length
          ? [
              el("ol", { class: "mn-steps" }, steps.map((s, i) =>
                el("li", { class: "mn-step" }, [
                  el("p", { class: "mn-text" }, [el("b", { class: "mono", text: `${i + 1}.` }), " ", ...inline(s.text || "", { wiki })]),
                  s.asset ? captureImg(s, "mn-cap") : el("p", { class: "mn-nocap dim", text: "캡처 없음" }),
                ]),
              )),
            ]
          : [el("p", { class: "dim", text: "아직 단계가 없습니다 — 편집을 눌러 단계와 캡처를 넣으세요." })],
      }),
    );
  }

  function edit() {
    const draft = { title: b.title || "", steps: steps.map((s) => ({ ...s })) };
    const titleInp = el("input", { class: "fld", type: "text", "aria-label": "제목", placeholder: "제목 (예: SPC 관리 한계 설정)" });
    titleInp.value = draft.title;
    titleInp.addEventListener("input", () => (draft.title = titleInp.value));
    const rowsEl = el("div", { class: "mn-rows" });
    function move(i, d) {
      const j = i + d;
      if (j < 0 || j >= draft.steps.length) return;
      [draft.steps[i], draft.steps[j]] = [draft.steps[j], draft.steps[i]];
      paint();
    }
    function row(s, i) {
      const text = el("textarea", { class: "fld", rows: 2, "aria-label": `${i + 1}단계 설명`, placeholder: "한 동작을 한 줄로 (예: 위 메뉴 [설정]을 누른다.)" });
      text.value = s.text || "";
      text.addEventListener("input", () => (s.text = text.value));
      const file = el("input", { type: "file", accept: CAPTURE_TYPES.join(","), hidden: true });
      const upBtn = el("button", { type: "button", class: "btn ghost sm", text: s.asset ? "캡처 바꾸기" : "캡처 올리기", onclick: () => file.click() });
      file.addEventListener("change", async () => {
        const f = file.files[0];
        if (!f) return;
        upBtn.disabled = true;
        upBtn.textContent = "올리는 중…";
        const res = await uploadCapture(f);
        if (res.error) toast(res.error, "error");
        else Object.assign(s, res.step);
        paint();
      });
      return el("div", { class: "mn-row" }, [
        el("b", { class: "mono mn-n", text: `${i + 1}` }),
        el("div", { class: "mn-row-main" }, [
          text,
          el("div", { class: "mn-row-cap" }, [
            s.asset ? captureImg(s, "mn-thumb") : el("span", { class: "dim", text: "캡처 없음" }),
            s.asset ? el("span", { class: "dim mono", text: `${s.width}×${s.height} · ${s.asset.slice(0, 8)}` }) : null,
            upBtn,
            file,
          ]),
        ]),
        el("div", { class: "mn-row-acts" }, [
          el("button", { type: "button", class: "btn ghost sm", text: "↑", "aria-label": `${i + 1}단계 위로`, disabled: i === 0, onclick: () => move(i, -1) }),
          el("button", { type: "button", class: "btn ghost sm", text: "↓", "aria-label": `${i + 1}단계 아래로`, disabled: i === draft.steps.length - 1, onclick: () => move(i, 1) }),
          el("button", { type: "button", class: "btn ghost sm", text: "삭제", onclick: () => { draft.steps.splice(i, 1); paint(); } }),
        ]),
      ]);
    }
    function paint() {
      rowsEl.replaceChildren(...(draft.steps.length ? draft.steps.map(row) : [el("p", { class: "dim", text: "단계가 없습니다 — [+ 단계 추가] 로 시작하세요." })]));
    }
    const save = el("button", { type: "button", class: "btn primary sm", text: "저장" });
    save.addEventListener("click", async () => {
      save.disabled = true;
      const body = {
        title: draft.title.trim(),
        steps: draft.steps.map((s) => ({
          text: (s.text || "").replace(/\s*\n\s*/g, " ").trim(),
          ...(s.asset ? { asset: s.asset, width: s.width, height: s.height } : {}),
        })),
      };
      const r = await api(`/api/docs/manual/${encodeURIComponent(doc.id)}`, { method: "PUT", headers: { "if-match": ctx.rev }, body });
      save.disabled = false;
      if (r.ok) {
        toast("저장했습니다");
        reload();
        return;
      }
      const d = r.data || {};
      if (r.status === 409) toast("다른 사람이 먼저 저장했습니다 — 문서를 다시 여세요.", "error");
      else if (r.status === 403) toast("admin 만 할 수 있습니다.", "error");
      else toast(`저장 실패 (${r.status})${d.details ? ` — ${d.details.join(" · ")}` : ""}`, "error");
    });
    host.replaceChildren(
      intro,
      sec({
        key: "단계",
        title: "단계 편집",
        children: [
          el("div", { class: "slot-edit" }, [
            titleInp,
            rowsEl,
            el("div", { class: "editacts" }, [
              el("button", { type: "button", class: "btn ghost sm", text: "+ 단계 추가", onclick: () => { draft.steps.push({ text: "" }); paint(); } }),
              save,
              el("button", { type: "button", class: "btn ghost sm", onclick: read, text: "취소" }),
            ]),
          ]),
        ],
      }),
    );
    paint();
    titleInp.focus();
  }
  read();
  return { sections: [{ key: "단계", title: `단계 ${steps.length}` }], edit };
}
