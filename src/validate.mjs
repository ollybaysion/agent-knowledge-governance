// Hand-rolled validator for the JSON-Schema-shaped files under schemas/.
//
// Deliberately not ajv (or any dependency): Phase 0 has exactly one
// consumer (this repo's own migrate/render round trip), so a compact
// evaluator for the keyword subset the schema files actually use is
// cheaper than a dependency. The schema files themselves stay standard
// draft 2020-12 JSON Schema — a real validator (ajv, in the Phase 1
// server per design §5.0) can read them unmodified later.
//
// Supported keywords: type, enum, const, pattern, minLength, minItems,
// items, properties, required, additionalProperties (bool|schema),
// dependentRequired, if/then/else, $ref (resolved against a caller-supplied
// map of schema-id -> schema, not fetched over a network).

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value; // "object" | "string" | "number" | "boolean"
}

function checkType(schema, data, path, errors) {
  if (schema.type === undefined) return;
  const wanted = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (!wanted.includes(typeOf(data))) {
    errors.push(
      `${path}: expected type ${wanted.join("|")}, got ${typeOf(data)}`,
    );
  }
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function checkEnumConst(schema, data, path, errors) {
  if (schema.enum && !schema.enum.some((v) => deepEqual(v, data))) {
    errors.push(
      `${path}: value ${JSON.stringify(data)} not in enum [${schema.enum.join(", ")}]`,
    );
  }
  if ("const" in schema && !deepEqual(schema.const, data)) {
    errors.push(
      `${path}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(data)}`,
    );
  }
}

function checkStringConstraints(schema, data, path, errors) {
  if (typeof data !== "string") return;
  if (schema.minLength !== undefined && data.length < schema.minLength) {
    errors.push(
      `${path}: length ${data.length} < minLength ${schema.minLength}`,
    );
  }
  if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(data)) {
    errors.push(`${path}: does not match pattern ${schema.pattern}`);
  }
}

function checkArrayConstraints(schema, data, path, refs, errors) {
  if (!Array.isArray(data)) return;
  if (schema.minItems !== undefined && data.length < schema.minItems) {
    errors.push(
      `${path}: has ${data.length} items < minItems ${schema.minItems}`,
    );
  }
  if (schema.items) {
    data.forEach((item, i) =>
      validateNode(schema.items, item, `${path}[${i}]`, refs, errors),
    );
  }
}

function checkObjectConstraints(schema, data, path, refs, errors) {
  if (typeOf(data) !== "object") return;
  const props = schema.properties ?? {};
  for (const key of schema.required ?? []) {
    if (!(key in data)) errors.push(`${path}: missing required key "${key}"`);
  }
  for (const [key, value] of Object.entries(data)) {
    if (key in props) {
      validateNode(props[key], value, `${path}.${key}`, refs, errors);
      continue;
    }
    if (schema.additionalProperties === false) {
      errors.push(
        `${path}: unknown key "${key}" (additionalProperties: false)`,
      );
    } else if (
      schema.additionalProperties &&
      typeof schema.additionalProperties === "object"
    ) {
      validateNode(
        schema.additionalProperties,
        value,
        `${path}.${key}`,
        refs,
        errors,
      );
    }
  }
  for (const [trigger, deps] of Object.entries(
    schema.dependentRequired ?? {},
  )) {
    if (trigger in data) {
      for (const dep of deps) {
        if (!(dep in data)) {
          errors.push(
            `${path}: "${trigger}" present requires "${dep}" (dependentRequired)`,
          );
        }
      }
    }
  }
}

// if/then/else: `if` is evaluated silently (errors discarded) to pick a
// branch; only the chosen branch's errors are reported.
function checkConditional(schema, data, path, refs, errors) {
  if (!schema.if) return;
  const ifErrors = [];
  validateNode(schema.if, data, path, refs, ifErrors);
  const branch = ifErrors.length === 0 ? schema.then : schema.else;
  if (branch) validateNode(branch, data, path, refs, errors);
}

export function validateNode(schema, data, path, refs, errors) {
  if (schema.$ref) {
    const resolved = refs[schema.$ref];
    if (!resolved) {
      errors.push(`${path}: unresolved $ref "${schema.$ref}"`);
      return;
    }
    validateNode(resolved, data, path, refs, errors);
    return;
  }
  checkType(schema, data, path, errors);
  checkEnumConst(schema, data, path, errors);
  checkStringConstraints(schema, data, path, errors);
  checkArrayConstraints(schema, data, path, refs, errors);
  checkObjectConstraints(schema, data, path, refs, errors);
  checkConditional(schema, data, path, refs, errors);
}

/** @returns {string[]} empty when valid */
export function validate(schema, data, refs = {}) {
  const errors = [];
  validateNode(schema, data, "$", refs, errors);
  return errors;
}

/** Throws Error(joined messages) when invalid; returns data unchanged when valid. */
export function assertValid(schema, data, refs = {}, label = "document") {
  const errors = validate(schema, data, refs);
  if (errors.length) {
    throw new Error(
      `${label} 검증 실패:\n${errors.map((e) => `  - ${e}`).join("\n")}`,
    );
  }
  return data;
}
