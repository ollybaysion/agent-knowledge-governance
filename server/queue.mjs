// Serial write queue (design §D2, §11 S7). Every mutation funnels through
// here so writes never race each other in the git store; a two-tier priority
// (human writes always drain before queued agent batches) stops an agent
// batch from self-DoSing everyone else's edits.
//
// The queue does NOT validate anything itself — S5 requires rev
// re-validation to happen "커밋 직전" inside the worker, so callers pass a
// job function that does its own read-validate-commit and the queue just
// guarantees jobs run one at a time, in priority order.
export function createQueue() {
  const lanes = { human: [], agent: [] };
  let draining = false;

  function pickNext() {
    if (lanes.human.length) return lanes.human.shift();
    if (lanes.agent.length) return lanes.agent.shift();
    return null;
  }

  async function drain() {
    if (draining) return;
    draining = true;
    let job;
    while ((job = pickNext())) {
      try {
        job.resolve(await job.fn());
      } catch (err) {
        job.reject(err);
      }
    }
    draining = false;
  }

  /**
   * @param {() => Promise<any>} fn re-validates + commits; runs alone.
   * @param {{priority?: "human"|"agent"}} [opts]
   */
  function enqueue(fn, { priority = "human" } = {}) {
    if (priority !== "human" && priority !== "agent") {
      throw new Error(`알 수 없는 큐 우선순위: ${priority}`);
    }
    return new Promise((resolve, reject) => {
      lanes[priority].push({ fn, resolve, reject });
      drain();
    });
  }

  return { enqueue };
}
