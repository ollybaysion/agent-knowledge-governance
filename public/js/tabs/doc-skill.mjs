// domain-skill and domain reading body: the md's `##` sections drawn as md
// (no box), each with 편집 → the section editor; a main's ## 답변 품질 검증 Set
// as the one card (질문 줄 · 정답 조각 · ✓/✗ · 사람 점수 · 질문 추가); 설치 at
// the end.
import { api, lastScore } from "../api.mjs";
import { downloadTextFile, el, icon, toast } from "../dom.mjs";
import { mdNodes } from "../md.mjs";
import { isAnswerSection, markAnswerHeading, sec } from "../sec.mjs";
import { sqlCode } from "../sql.mjs";
import {
  VERIFY_KEY,
  VERIFY_KIND_LABEL,
  VERIFY_KIND_WIRE,
  VERIFY_LABEL_OF_WIRE,
  shortAt,
  skillSectionsLib,
  sqlBindLib,
  verifyLib,
} from "../shared.mjs";

const VERIFY_HINT =
  "### 설정(- 라인 · - 설비 · - 기간: 시작 ~ 끝) 아래 ### 일반 지식 · ### 데이터 설명 · ### 데이터 연관 · ### 고도화 분석 · ### 신뢰성, #### 하나가 질문 하나다. 일반 지식은 - 정답: ## 도메인 지식 소제목 경로, 데이터 설명은 ```sql 하나(값이 다 들어간 SQL), 데이터 연관은 ```sql 여럿 + - 채점표, 고도화 분석은 - 보류, 신뢰성은 \"모른다\" 가 맞는 답.";

/** The first paragraph under ## 한 줄 설명 — the SKILL.md description rule. */
export function summaryOf(markdown) {
  let inSummary = false;
  for (const line of String(markdown || "").split(/\r?\n/)) {
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      inSummary = h[1].length === 2 && /^한 줄 설명[?？:：\s]*$/.test(h[2].trim());
      continue;
    }
    if (inSummary && line.trim() !== "") return line.trim();
  }
  return "";
}

/** The md's `# title` line, or null. */
export const titleOf = (markdown) => /^#\s+(.+?)\s*#*\s*$/m.exec(String(markdown ?? ""))?.[1] ?? null;

const questionKey = (kind, text) => `${kind}\n${text}`;
/** The last machine and human line of each question, by kind + text. */
export function lastLines(lines) {
  const machine = new Map();
  const human = new Map();
  for (const l of lines || []) {
    const key = questionKey(l.kind, l.text);
    if (l.machine) machine.set(key, l);
    if (l.human) human.set(key, l);
  }
  return { machine, human, of: (q) => ({ m: machine.get(questionKey(VERIFY_KIND_WIRE[q.kind], q.text)), h: human.get(questionKey(VERIFY_KIND_WIRE[q.kind], q.text)) }) };
}

/**
 * @returns {Promise<{nodes: Node[], sections: {key: string, title: string}[],
 *   answerHeading: Node|null,
 *   info: {main: boolean, questions: object[], last: ReturnType<typeof lastLines>, run: object|null}}>}
 */
export async function skillBody(ctx) {
  const { type, doc, rev, md, data, canEdit, reload, wiki, editSection } = ctx;
  const s = doc.body;
  const main = type === "domain-skill" && (doc.role ?? "main") === "main";
  const url = `/api/docs/domain-skill/${encodeURIComponent(doc.id)}`;
  const [lib, vlib, blib, score, choices] = await Promise.all([
    skillSectionsLib,
    verifyLib,
    sqlBindLib,
    main ? lastScore(doc.id) : null,
    main ? api(`${url}/verification-choices`) : null,
  ]);
  const order = lib ? (main ? lib.SKILL_SECTIONS : lib.SKILL_SECTIONS.filter((x) => x.key !== VERIFY_KEY)) : null;
  const scoreLines = score?.lines ?? [];
  const last = lastLines(scoreLines);
  const verifyQueries = choices?.ok ? choices.data.queries : [];
  let answerGroups = (choices?.ok ? choices.data.pieces : [])
    .filter((g) => g.paths.length)
    .map((g) => ({ ...g, values: g.paths.map((p) => (g.tier === "own" ? p : `${g.skill}/${p}`)) }));
  const parsed = vlib ? vlib.parseVerifySet(s.markdown || "") : null;
  if (vlib && !answerGroups.length) {
    const own = vlib.knowledgePaths(s.markdown || "");
    answerGroups = own.length ? [{ skill: doc.id, tier: "own", paths: own, values: own }] : [];
  }
  const sections = [];
  const nodes = [];
  const mdCtx = { wiki, assets: doc.assets };
  let knowledge = null; // the ## 도메인 지식 node and its body

  let split = null;
  let note = null;
  if (lib) {
    try {
      split = lib.splitSkill(s.markdown || "", order);
    } catch (e) {
      if (!(e instanceof lib.SkillSplitError)) throw e;
      note = `절 단위로 나눌 수 없어 전체 md 로 보입니다 — ${e.message}`;
    }
  } else note = "절 나누기를 불러오지 못해 전체 md 로 보입니다.";

  if (!split) {
    sections.push({ key: "본문", title: "본문" });
    nodes.push(
      sec({
        key: "본문",
        title: "본문",
        onEdit: canEdit ? () => editSection(null) : null,
        children: [el("p", { class: "dim", text: note }), ...mdNodes(s.markdown || "", mdCtx)],
      }),
    );
  } else {
    for (const block of split.sections) {
      if (block.key === VERIFY_KEY) continue;
      sections.push({ key: block.key, title: block.heading });
      const node = sec({
        key: block.key,
        title: block.heading,
        onEdit: canEdit ? () => editSection(block.key) : null,
        children: block.body.trim() === "" ? [el("p", { class: "dim", text: "비어 있습니다" })] : mdNodes(block.body, mdCtx),
      });
      if (block.key === "도메인 지식") knowledge = { node, body: block.body };
      nodes.push(node);
    }
    if (main) {
      const block = split.sections.find((b) => b.key === VERIFY_KEY);
      sections.push({ key: VERIFY_KEY, title: block.heading });
      nodes.push(
        verifySection({ ctx, block, vlib, blib, parsed, last, verifyQueries, answerGroups, scoreLines, url, editSection }),
      );
    }
  }

  // 설치: SKILL.md 받기와 놓을 자리
  if (md) {
    const installCmd = `mkdir -p ~/.claude/skills/${s.name}\nmv ~/Downloads/SKILL.md ~/.claude/skills/${s.name}/SKILL.md`;
    sections.push({ key: "설치", title: "설치" });
    nodes.push(
      sec({
        key: "설치",
        title: "설치",
        cls: "sec-install",
        children: [
          el("p", { class: "md-p" }, [
            "받은 ",
            el("code", { text: "SKILL.md" }),
            " 를 아래 자리에 넣으면 Claude Code · opencode 가 읽습니다. 받는 파일은 이 문서 앞에 frontmatter(name · description)를 붙인 것입니다.",
          ]),
          el("div", { class: "install-row" }, [
            el("pre", { class: "md-code install-cmd" }, el("code", { text: installCmd })),
            el("div", { class: "install-acts" }, [
              el("button", {
                type: "button",
                class: "btn primary sm",
                onclick: () => {
                  downloadTextFile("SKILL.md", md, "text/markdown;charset=utf-8");
                  toast("SKILL.md 를 받았습니다 — 위 자리에 넣으세요");
                },
                text: "SKILL.md 받기",
              }),
              el("button", {
                type: "button",
                class: "btn ghost sm",
                onclick: async () => {
                  try {
                    await navigator.clipboard.writeText(installCmd);
                    toast("복사했습니다");
                  } catch {
                    toast("복사하지 못했습니다 — 명령을 직접 골라 복사하세요", "error");
                  }
                },
                text: "명령 복사",
              }),
            ]),
          ]),
        ],
      }),
    );
  }
  const answerHeading =
    knowledge && !sections.some((x) => isAnswerSection(x.title)) ? markAnswerHeading(knowledge.node, knowledge.body) : null;
  return {
    nodes,
    sections,
    answerHeading,
    info: { main, questions: parsed?.questions ?? [], last, run: score?.run ?? null, warnings: data?.warnings ?? [] },
  };
}

// ---------- 답변 품질 검증 Set: 카드 하나 ----------
function verifySection({ ctx, block, vlib, blib, parsed, last, verifyQueries, answerGroups, scoreLines, url, editSection }) {
  const { doc, rev, canEdit, reload, data } = ctx;
  const host = el("div", { class: "vcard-host" });
  const usable = vlib && parsed && parsed.errors.length === 0;
  const set = usable ? { settings: parsed.settings, questions: parsed.questions } : null;
  let editing = null; // "settings" | "q<i>" | "new<kind>" | "pick"
  const addSlot = el("span", { class: "vadd-slot" });

  const counts = set ? vlib.countByKind(set.questions) : null;
  const countLine = counts
    ? [1, 2, 3, 4, 5].filter((k) => counts[k]).map((k) => `${VERIFY_KIND_LABEL[k]} ${counts[k]}`).join(" · ")
    : "";

  async function saveSet(next, errBox, button) {
    button.disabled = true;
    const r = await api(`${url}/verification-set`, {
      method: "PUT",
      headers: { "if-match": rev },
      body: {
        ...(next.settings && Object.keys(next.settings).length ? { settings: next.settings } : {}),
        questions: next.questions.map(vlib.toContractQuestion),
      },
    });
    if (r.ok) {
      toast("저장했습니다");
      reload();
      return;
    }
    button.disabled = false;
    const d = r.data || {};
    showErrors(errBox, r.status === 409 ? ["다른 사람이 먼저 저장했습니다 — 문서를 다시 여세요."] : d.details || [d.message || `저장 실패 (${r.status})`]);
  }
  function showErrors(box, list) {
    box.replaceChildren(el("ul", {}, list.map((e) => el("li", { text: String(e).replace(/^\$\.body\.markdown: /, "") }))));
    box.hidden = false;
  }
  const field = (label, control) => el("label", { class: "verify-field" }, [el("span", { class: "verify-label", text: label }), control]);
  const input = (value, placeholder) => {
    const i = el("input", { type: "text", class: "fld", placeholder: placeholder || "" });
    i.value = value ?? "";
    return i;
  };
  const area = (value, cls) => {
    const t = el("textarea", { class: `fld ${cls || ""}`, spellcheck: "false", rows: 3 });
    t.value = value ?? "";
    return t;
  };
  const acts = (save, cancel) =>
    el("div", { class: "verify-acts" }, [
      el("button", { type: "button", class: "btn ghost sm", text: "취소", onclick: cancel }),
      el("button", { type: "button", class: "btn primary sm", text: "저장", onclick: save }),
    ]);
  const open = (key) => {
    editing = key;
    paint();
  };
  const close = () => open(null);

  function pathPicker(onPick) {
    if (!answerGroups.length) return null;
    const TIER = { own: "이 스킬", link1: "연결 1단", link2: "연결 2단" };
    return el("div", { class: "verify-paths-groups" }, answerGroups.map((g) =>
      el("div", { class: "verify-paths" }, [
        el("span", { class: "dim", text: `${TIER[g.tier]}${g.tier === "own" ? "" : ` ${g.skill}`} — ` }),
        ...g.values.map((v, i) => el("button", { type: "button", class: "chip verify-path", text: g.paths[i], title: `- 정답: ${v}`, onclick: () => onPick(v) })),
      ]),
    ));
  }

  // 조회 고르기 — 고른 조회의 SQL 틀에 값을 묶어 정답 SQL 을 채운다.
  function sqlPicker(target, shared) {
    if (!blib || !verifyQueries.length) return null;
    const st = set.settings || {};
    const pick = el("select", { class: "fld verify-pick", "aria-label": "조회 고르기" }, [
      el("option", { value: "", text: "조회 고르기 — 고르면 SQL 틀과 입력 칸이 나옵니다" }),
      ...verifyQueries.map((qq, i) => el("option", { value: String(i), text: `${qq.id}${qq.title ? ` — ${qq.title}` : ""}${qq.skill === doc.id ? "" : ` (${qq.skill})`}` })),
    ]);
    const body = el("div", { class: "verify-pick-body", hidden: true });
    const status = el("div", { class: "verify-pick-status dim" });
    const fill = (query, inputs) => {
      const binds = {};
      for (const [name, i] of inputs) if (i.value.trim() !== "") binds[name] = i.value;
      const { sql, missing } = blib.bindSql(query.sql, binds);
      target.value = sql;
      status.textContent = missing.length ? `값이 빈 칸: ${missing.map((m) => `:${m}`).join(" · ")}` : "SQL 을 채웠습니다 — 아래 칸에서 더 고칠 수 있습니다";
      status.className = missing.length ? "verify-pick-status missing" : "verify-pick-status dim";
    };
    pick.addEventListener("change", () => {
      const query = verifyQueries[Number(pick.value)];
      if (pick.value === "" || !query) {
        body.hidden = true;
        body.replaceChildren();
        return;
      }
      const inputs = [];
      const fields = query.binds.map((b) => {
        const prefill = b.from === "eqp" ? st.eqp : b.from === "start" ? st.duration?.start : b.from === "end" ? st.duration?.end : shared[b.name];
        const i = input(prefill, b.example ? `예: ${b.example}` : b.from === "start" || b.from === "end" ? "2026-10-01T00:00" : "");
        i.addEventListener("input", () => {
          if (b.from === "input") shared[b.name] = i.value;
          fill(query, inputs);
        });
        inputs.push([b.name, i]);
        const label = b.from === "eqp" ? "설비" : b.from === "start" ? "기간 시작" : b.from === "end" ? "기간 끝" : b.title || b.name;
        return el("label", { class: "verify-field" }, [
          el("span", { class: "verify-label" }, [`${label} `, el("code", { text: `:${b.name}` })]),
          i,
        ]);
      });
      body.replaceChildren(
        el("pre", { class: "verify-sql" }, sqlCode(query.sql)),
        fields.length ? el("div", { class: "verify-fields" }, fields) : el("div", { class: "dim", text: "이 조회는 입력이 없습니다" }),
        status,
      );
      body.hidden = false;
      fill(query, inputs);
    });
    return el("div", { class: "verify-pick-wrap" }, [field("조회 고르기", pick), body]);
  }
  const unbound = (sqls) => (blib ? [...new Set(sqls.flatMap((x) => blib.varsOf(x)))] : []);

  function editCard(q, index) {
    const text = input(q.text, "질문 문장");
    const errBox = el("div", { class: "verify-errors", hidden: true });
    const parts = [field("질문", text)];
    let collect = () => ({});
    const shared = {};
    if (q.kind === 1) {
      const path = input(q.path, "소제목 경로 — 다른 스킬 조각은 <스킬>/<소제목 경로>");
      const rubric = area(q.rubric);
      parts.push(field("정답 경로", path), pathPicker((p) => { path.value = p; path.focus(); }), field("채점표(선택)", rubric));
      collect = () => ({ path: path.value.trim() || null, rubric: rubric.value.trim() || null });
    } else if (q.kind === 2) {
      const sql = area(q.sqls[0], "verify-sql-edit");
      parts.push(sqlPicker(sql, shared), field("정답 SQL — 값이 다 들어간 문장", sql));
      collect = () => ({ sqls: sql.value.trim() ? [sql.value.trim()] : [] });
    } else if (q.kind === 3) {
      const list = el("div", { class: "verify-sql-list" });
      const rows = [];
      const addRow = (value) => {
        const t = area(value, "verify-sql-edit");
        const row = el("div", { class: "verify-sql-item" }, [
          el("button", { type: "button", class: "iconbtn", "aria-label": "이 SQL 줄 삭제", text: "✕", onclick: () => { rows.splice(rows.indexOf(t), 1); row.remove(); } }),
          sqlPicker(t, shared),
          field("정답 SQL", t),
        ]);
        rows.push(t);
        list.appendChild(row);
      };
      (q.sqls.length ? q.sqls : [""]).forEach(addRow);
      const rubric = area(q.rubric);
      parts.push(list, el("div", {}, el("button", { type: "button", class: "btn ghost sm", text: "+ SQL 추가", onclick: () => addRow("") })), field("채점표", rubric));
      collect = () => ({ sqls: rows.map((t) => t.value.trim()).filter(Boolean), rubric: rubric.value.trim() || null });
    } else if (q.kind === 4) {
      parts.push(el("span", { class: "chip", text: "보류 — 판정 없이 수만 셉니다" }));
      collect = () => ({ deferred: true });
    } else {
      parts.push(el("span", { class: "dim", text: "답이 자료에 없는 질문 — 에이전트가 \"모른다\" 로 답해야 맞습니다" }));
    }
    queueMicrotask(() => text.focus());
    const save = (e) => {
      const t = text.value.trim();
      if (!t) return showErrors(errBox, ["질문 문장이 비었습니다"]);
      const edited = { ...q, text: t, ...collect() };
      const left = unbound(edited.sqls || []);
      if (left.length) return showErrors(errBox, [`정답 SQL 에 값이 빈 바인드가 있습니다: ${left.map((m) => `:${m}`).join(" · ")}`]);
      const questions = index === null ? [...set.questions, edited] : set.questions.map((x, i) => (i === index ? edited : x));
      saveSet({ ...set, questions }, errBox, e.currentTarget);
    };
    const card = el("div", { class: "vrow editing" }, [
      el("b", { text: index === null ? `새 질문 · ${VERIFY_KIND_LABEL[q.kind]}` : `질문 고치기 · ${VERIFY_KIND_LABEL[q.kind]}` }),
      ...parts,
      errBox,
      acts(save, close),
    ]);
    card.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    });
    return card;
  }

  function settingsRow() {
    const st = set.settings || {};
    if (editing === "settings") {
      const line = input(st.line, "L1");
      const eqp = input(st.eqp, "EQP01");
      const start = input(st.duration?.start, "2026-10-01T00:00");
      const end = input(st.duration?.end, "2026-10-01T06:00");
      const errBox = el("div", { class: "verify-errors", hidden: true });
      return el("div", { class: "vrow editing" }, [
        el("b", { text: "설정" }),
        el("div", { class: "verify-fields" }, [field("라인", line), field("설비", eqp), field("기간 시작", start), field("기간 끝", end)]),
        errBox,
        acts((e) => {
          const v = (x) => x.value.trim();
          if ((v(start) === "") !== (v(end) === "")) return showErrors(errBox, ["기간은 시작과 끝을 같이 적습니다"]);
          const settings = {
            ...(v(line) ? { line: v(line) } : {}),
            ...(v(eqp) ? { eqp: v(eqp) } : {}),
            ...(v(start) ? { duration: { start: v(start), end: v(end) } } : {}),
          };
          saveSet({ ...set, settings }, errBox, e.currentTarget);
        }, close),
      ]);
    }
    const dur = st.duration ? `${st.duration.start.replace("T", " ")} ~ ${st.duration.end.replace("T", " ")}` : "—";
    return el("div", { class: "vrow vsettings" }, [
      el("span", { class: "vkind", text: "설정" }),
      el("span", { class: "vset" }, [
        el("span", { class: "dim", text: "라인 " }), el("b", { class: "mono", text: st.line || "—" }),
        el("span", { class: "dim", text: " · 설비 " }), el("b", { class: "mono", text: st.eqp || "—" }),
        el("span", { class: "dim", text: " · 기간 " }), el("span", { class: "mono", text: dur }),
      ]),
      canEdit ? el("button", { type: "button", class: "linkbtn", text: "고치기", disabled: editing !== null, onclick: () => open("settings") }) : null,
    ]);
  }

  // 사람 점수: "사람 80 / 100 · renoir" 또는 [사람 점수 적기]
  function humanScore(q, h) {
    const box = el("div", { class: "verify-human" });
    const shown = () => {
      const parts = h
        ? [el("span", { class: "dim", text: "사람 " }), el("b", { text: String(h.human.score) }), el("span", { class: "dim", text: ` / 100 · ${h.human.by}` })]
        : [];
      if (canEdit) parts.push(el("button", { type: "button", class: "linkbtn", text: h ? "고치기" : "사람 점수 적기", onclick: form }));
      box.replaceChildren(...parts);
    };
    const form = () => {
      const inp = el("input", { type: "number", min: "0", max: "100", step: "1", class: "fld verify-human-in", "aria-label": `${q.text} 사람 점수` });
      if (h) inp.value = String(h.human.score);
      const save = el("button", {
        type: "button",
        class: "btn primary sm",
        text: "저장",
        onclick: async () => {
          const score = Number(inp.value);
          if (inp.value === "" || !Number.isInteger(score) || score < 0 || score > 100) {
            toast("사람 점수는 0~100 정수입니다", "error");
            return;
          }
          save.disabled = true;
          const r = await api(`/api/score/${encodeURIComponent(doc.id)}`, {
            method: "POST",
            body: { lines: [{ kind: VERIFY_KIND_WIRE[q.kind], text: q.text, human: { score } }] },
          });
          if (r.ok) {
            toast("사람 점수를 남겼습니다");
            reload();
            return;
          }
          save.disabled = false;
          toast(`남기지 못했습니다 (${r.status})`, "error");
        },
      });
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter") save.click();
        if (e.key === "Escape") shown();
      });
      box.replaceChildren(inp, el("span", { class: "dim", text: "/ 100" }), save, el("button", { type: "button", class: "btn ghost sm", text: "취소", onclick: shown }));
      inp.focus();
    };
    shown();
    return box;
  }

  function verdict(m) {
    if (!m) return el("span", { class: "verify-pill none", text: "판정 없음" });
    return el("span", {
      class: `verify-pill ${m.machine.ok ? "ok" : "no"}`,
      title: shortAt(m.at),
      text: m.machine.ok ? "✓ 맞음" : `✗ ${m.machine.reason || "틀림"}`,
    });
  }

  function questionRow(q, i) {
    const { m, h } = last.of(q);
    const answer = [];
    if (q.path) answer.push(el("span", { class: "chip vpath", text: q.path }));
    for (const sql of q.sqls) answer.push(el("span", { class: "chip vpath", title: sql, text: sql.replace(/\s+/g, " ").slice(0, 60) }));
    if (q.rubric) answer.push(el("span", { class: "dim vrubric", text: `채점표: ${q.rubric}` }));
    if (q.deferred) answer.push(el("span", { class: "chip", text: "보류" }));
    return el("div", { class: "vrow" }, [
      el("span", { class: "vkind", text: VERIFY_KIND_LABEL[q.kind] }),
      el("div", { class: "vmain" }, [
        el("div", { class: "vq" }, [
          el("b", { text: q.text }),
          verdict(m),
        ]),
        el("div", { class: "vans" }, [
          ...answer,
          el("span", { class: "vsp" }),
          humanScore(q, h),
          canEdit
            ? el("span", { class: "vedit" }, [
                el("button", { type: "button", class: "linkbtn", text: "고치기", disabled: editing !== null, onclick: () => open(`q${i}`) }),
                el("button", {
                  type: "button",
                  class: "linkbtn",
                  text: "삭제",
                  disabled: editing !== null,
                  onclick: (e) => {
                    if (!confirm(`"${q.text}" 질문을 지울까요?`)) return;
                    const errBox = e.currentTarget.closest(".vrow").querySelector(".verify-errors");
                    saveSet({ ...set, questions: set.questions.filter((_, j) => j !== i) }, errBox, e.currentTarget);
                  },
                }),
              ])
            : null,
        ]),
        el("div", { class: "verify-errors", hidden: true }),
      ]),
    ]);
  }

  function addMenu() {
    if (!canEdit) return null;
    if (editing === "pick")
      return el("div", { class: "vadd-menu", role: "group", "aria-label": "질문 종류" }, [
        ...[1, 2, 3, 4, 5].map((k) => el("button", { type: "button", class: "btn ghost sm", text: VERIFY_KIND_LABEL[k], onclick: () => open(`new${k}`) })),
        el("button", { type: "button", class: "btn ghost sm", text: "취소", onclick: close }),
      ]);
    return el("button", { type: "button", class: "btn ghost sm vadd", disabled: editing !== null, onclick: () => open("pick") }, [icon("plus", 14), "질문 추가"]);
  }

  function history() {
    if (!scoreLines.length) return null;
    const lines = [...scoreLines].reverse();
    return el("details", { class: "verify-history" }, [
      el("summary", { text: `기록 ${lines.length}줄` }),
      el("div", { class: "tbl-wrap" }, el("table", { class: "verify-history-tbl" }, [
        el("thead", {}, el("tr", {}, ["시각", "종류", "질문", "기계", "사람"].map((t) => el("th", { text: t })))),
        el("tbody", {}, lines.map((l) =>
          el("tr", {}, [
            el("td", { class: "mono", text: shortAt(l.at) }),
            el("td", { class: "dim", text: VERIFY_LABEL_OF_WIRE[l.kind] ?? l.kind }),
            el("td", { text: l.text }),
            el("td", { text: l.machine ? `${l.machine.ok ? "✓" : "✗"}${l.machine.reason ? ` ${l.machine.reason}` : ""} · Score ${l.run?.score ?? "—"}` : "" }),
            el("td", { text: l.human ? `${l.human.score} / 100 · ${l.human.by}` : "" }),
          ]),
        )),
      ])),
    ]);
  }

  function paint() {
    addSlot.replaceChildren(...[usable ? addMenu() : null].filter(Boolean));
    if (!usable) {
      host.replaceChildren(
        el("div", { class: "vcard" }, [
          parsed?.errors.length
            ? el("div", { class: "verify-warn" }, [el("b", { text: "검증 Set 을 읽지 못했습니다" }), el("ul", {}, parsed.errors.map((e) => el("li", { text: e })))])
            : null,
          block.body.trim() ? el("div", { class: "md-body" }, mdNodes(block.body, {})) : el("p", { class: "dim", text: "아직 질문이 없습니다." }),
          canEdit ? el("button", { type: "button", class: "btn ghost sm", text: "절 편집으로 고치기", onclick: () => editSection(VERIFY_KEY) }) : null,
        ]),
      );
      return;
    }
    const rows = [];
    const order = [1, 2, 3, 4, 5];
    for (const k of order)
      set.questions.forEach((q, i) => {
        if (q.kind !== k) return;
        rows.push(editing === `q${i}` ? editCard(q, i) : questionRow(q, i));
      });
    for (const k of order)
      if (editing === `new${k}`) rows.push(editCard({ kind: k, text: "", path: null, sqls: [], rubric: null, deferred: k === 4 }, null));
    const warnings = data?.warnings || [];
    host.replaceChildren(
      el("div", { class: "vcard" }, [
        settingsRow(),
        ...(rows.length ? rows : [el("p", { class: "dim vempty", text: "아직 질문이 없습니다 — [질문 추가] 로 넣으세요." })]),
        warnings.length ? el("div", { class: "verify-warn" }, [el("b", { text: `경고 ${warnings.length}` }), el("ul", {}, warnings.map((w) => el("li", { text: w })))]) : null,
        history(),
      ]),
      el("p", { class: "dim vhint", text: VERIFY_HINT }),
    );
  }
  paint();

  const total = set ? set.questions.length : 0;
  return sec({
    key: VERIFY_KEY,
    title: block.heading,
    cls: "sec-verify",
    onEdit: canEdit ? () => editSection(VERIFY_KEY) : null,
    editLabel: "md 편집",
    extra: el("span", { class: "vhead" }, [
      el("span", { class: "count-pill", text: String(total) }),
      countLine ? el("span", { class: "dim", text: countLine }) : null,
      el("span", { class: "vhead-sp" }),
      usable ? addSlot : null,
    ]),
    children: [host],
  });
}
