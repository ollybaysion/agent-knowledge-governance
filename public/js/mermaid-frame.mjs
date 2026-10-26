// The hidden frame that runs mermaid (/mermaid-frame.html). mermaid draws in
// a scratch element with <style> and style="" in the live document, which the
// page's style-src 'self' refuses; this frame's own CSP allows inline style,
// so the page keeps its strict one. One text at a time: the page posts
// {type: "render", id, text, config}, the frame answers {type: "done", id, svg}
// or {type: "error", id, message}.
/* global mermaid */
const origin = location.origin;
let queue = Promise.resolve();

async function draw({ id, text, config }) {
  try {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "base",
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      themeVariables: config?.themeVariables ?? {},
    });
    const { svg } = await mermaid.render(`akg-mmd-${id}`, text);
    parent.postMessage({ type: "done", id, svg }, origin);
  } catch (err) {
    parent.postMessage({ type: "error", id, message: String(err?.message ?? err) }, origin);
  }
}

addEventListener("message", (e) => {
  if (e.source !== parent || e.origin !== origin || e.data?.type !== "render") return;
  queue = queue.then(() => draw(e.data));
});
parent.postMessage({ type: "ready" }, origin);
