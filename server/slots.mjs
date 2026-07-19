// Slot addressing (json-spec §3) and slot-level diffing (design §11 S6).
//
// "A slot is wherever the type schema has `$ref: common/tiered-value.v1`" —
// json-spec §3's detection principle, taken literally: this module walks the
// JSON SCHEMA (not the body) to find those $ref sites, and walks the body in
// lockstep to produce FQN addresses like "purpose", "columnDescs.USE_YN",
// "queries[0].note". Types with no such $ref anywhere (domain-skill,
// unclassified) have zero slots — callers use that to fall back to whole-doc
// conflict semantics instead of slot-level merge.
const TIERED_VALUE_REF = "common/tiered-value.v1";

function formatPath(path) {
  let s = "";
  for (const seg of path) {
    s += seg.k === "key" ? (s ? `.${seg.v}` : seg.v) : `[${seg.v}]`;
  }
  return s;
}

function walk(schema, path, body, onSlot) {
  if (!schema || body === undefined) return;
  if (schema.$ref === TIERED_VALUE_REF) {
    onSlot(formatPath(path), body);
    return;
  }
  if (schema.type === "object") {
    if (schema.properties && body && typeof body === "object") {
      for (const [key, sub] of Object.entries(schema.properties)) {
        if (key in body)
          walk(sub, [...path, { k: "key", v: key }], body[key], onSlot);
      }
    }
    if (
      schema.additionalProperties &&
      typeof schema.additionalProperties === "object" &&
      body &&
      typeof body === "object"
    ) {
      for (const key of Object.keys(body)) {
        if (schema.properties && key in schema.properties) continue;
        walk(
          schema.additionalProperties,
          [...path, { k: "key", v: key }],
          body[key],
          onSlot,
        );
      }
    }
    return;
  }
  if (schema.type === "array" && schema.items && Array.isArray(body)) {
    body.forEach((item, i) =>
      walk(schema.items, [...path, { k: "idx", v: i }], item, onSlot),
    );
  }
}

/** @returns {string[]} every slot address present in `body` per `typeSchema` (body-schema, not envelope). */
export function listSlotAddresses(typeSchema, body) {
  const addresses = [];
  walk(typeSchema, [], body, (address) => addresses.push(address));
  return addresses;
}

const ADDRESS_RE = /([^.[\]]+)|\[(\d+)\]/g;

function parseAddress(address) {
  const tokens = [];
  let m;
  ADDRESS_RE.lastIndex = 0;
  while ((m = ADDRESS_RE.exec(address))) {
    tokens.push(
      m[1] !== undefined
        ? { k: "key", v: m[1] }
        : { k: "idx", v: Number(m[2]) },
    );
  }
  return tokens;
}

/** Read the tiered-value (or undefined) at `address` in `body`. */
export function getSlot(body, address) {
  let cur = body;
  for (const tok of parseAddress(address)) {
    if (cur == null) return undefined;
    cur = cur[tok.v];
  }
  return cur;
}

/** Write a tiered-value at `address` in `body` (mutates body). Parent path must exist. */
export function setSlot(body, address, value) {
  const tokens = parseAddress(address);
  let cur = body;
  for (let i = 0; i < tokens.length - 1; i++) cur = cur[tokens[i].v];
  cur[tokens[tokens.length - 1].v] = value;
}

/**
 * Slot addresses whose tiered-value differs between two body versions of the
 * SAME document (added/removed slots count as changed). Order-independent —
 * returns a Set.
 */
export function diffSlots(typeSchema, bodyA, bodyB) {
  const addrs = new Set([
    ...listSlotAddresses(typeSchema, bodyA),
    ...listSlotAddresses(typeSchema, bodyB),
  ]);
  const changed = new Set();
  for (const addr of addrs) {
    const a = getSlot(bodyA, addr);
    const b = getSlot(bodyB, addr);
    if (JSON.stringify(a) !== JSON.stringify(b)) changed.add(addr);
  }
  return changed;
}

/** True if this type's body schema has no tiered-value $ref anywhere (domain-skill, unclassified). */
export function hasNoSlots(typeSchema, body) {
  return listSlotAddresses(typeSchema, body).length === 0;
}

/** Slot counts by tier (design §7 — corpus screen scaffold/추정/confirmed cards). */
export function tierSummary(typeSchema, body) {
  const counts = { scaffold: 0, inferred: 0, confirmed: 0, deprecated: 0 };
  for (const addr of listSlotAddresses(typeSchema, body)) {
    const tier = getSlot(body, addr)?.tier;
    if (tier in counts) counts[tier] += 1;
  }
  return counts;
}
