import { test } from "node:test";
import assert from "node:assert/strict";
import { createQueue } from "../../server/queue.mjs";

function later(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

test("jobs run one at a time, never overlapping", async () => {
  const q = createQueue();
  let running = 0;
  let maxConcurrent = 0;
  const job = () => async () => {
    running++;
    maxConcurrent = Math.max(maxConcurrent, running);
    await later(5);
    running--;
    return "ok";
  };
  const results = await Promise.all([
    q.enqueue(job()),
    q.enqueue(job()),
    q.enqueue(job()),
  ]);
  assert.deepEqual(results, ["ok", "ok", "ok"]);
  assert.equal(maxConcurrent, 1);
});

test("a human job enqueued after several agent jobs still runs before them (S7)", async () => {
  const q = createQueue();
  const order = [];
  // Block the queue on an in-flight agent job first so the rest queue up behind it.
  const blocker = q.enqueue(
    async () => {
      await later(10);
      order.push("agent-blocker");
    },
    { priority: "agent" },
  );
  await later(1); // let the blocker actually start draining before we enqueue more
  const agent2 = q.enqueue(async () => order.push("agent-2"), {
    priority: "agent",
  });
  const agent3 = q.enqueue(async () => order.push("agent-3"), {
    priority: "agent",
  });
  const human = q.enqueue(async () => order.push("human"), {
    priority: "human",
  });
  await Promise.all([blocker, agent2, agent3, human]);
  assert.deepEqual(order, ["agent-blocker", "human", "agent-2", "agent-3"]);
});

test("a job that throws rejects its own promise without breaking the queue for later jobs", async () => {
  const q = createQueue();
  await assert.rejects(
    q.enqueue(async () => {
      throw new Error("boom");
    }),
  );
  assert.equal(await q.enqueue(async () => "still fine"), "still fine");
});
