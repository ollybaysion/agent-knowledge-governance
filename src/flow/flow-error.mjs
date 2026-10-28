// One error of a flow fence — BE FlowError.java. The code names are the
// contract: AKG's check gives the codes BE gives. No node imports: the
// dashboard runs this file as it is.

/** BE FlowError.Code, in its order. */
export const CODES = [
  "HEADER",
  "DIRECTIVE",
  "RESERVED_WORD",
  "AMPERSAND",
  "CHAIN",
  "ARROW",
  "EDGE_SYNTAX",
  "NODE_SYNTAX",
  "CONDITION_SYNTAX",
  "INPUT_ID",
  "SHAPE_CONFLICT",
  "UNKNOWN_ID",
  "INPUT_IS_QUERY",
  "QUERY_IS_MD",
  "SELF_FLOW",
  "FLOW_ALONE",
  "EDGE_KIND",
  "OPTIONAL_EDGE",
  "CONDITION_PLACE",
  "ELSE_DUPLICATE",
  "CONDITION_COLUMN",
  "UNSOURCED_VAR",
  "UNSUPPORTED_EQP_FLOW",
  "CYCLE",
  "MD_CYCLE",
  "SUBGRAPH_ID",
  "SUBGRAPH_TITLE",
  "SUBGRAPH_UNCLOSED",
  "SUBGRAPH_END",
  "SUBGRAPH_NESTED",
  "SUBGRAPH_MEMBER",
  "SUBGRAPH_EMPTY",
  "SUBGRAPH_ID_CLASH",
  "MAP_ITEM",
  "MAP_FENCE",
  "MAP_SHAPE",
  "MAP_LINE",
  "MAP_EXPR",
  "MAP_DUP",
  "MAP_SOURCE",
  "MAP_SCOPE",
  "MAP_NO_SOURCE",
  "MAP_ALONE",
  "CHART_KIND",
  "CHART_KEY",
  "CHART_REQUIRED",
  "CHART_COLUMN",
  "CHART_BINS",
  "CHART_DUPLICATE",
];

/** code name → itself, so a typo is an undefined, not a silent string. */
export const Code = Object.freeze(Object.fromEntries(CODES.map((c) => [c, c])));

/**
 * @param {number} line fence line (1-based, `flowchart TD` is 1); 0 when the
 *   error points at no line. A MAP_* · CHART_* error's line is the md's (1-based) —
 *   BE FlowError's line. {@link mdLine} gives every error's md line.
 * @param {string} code a {@link Code}
 * @param {string} message the reason for a person
 * @returns {{line: number, code: string, message: string}}
 */
export const flowError = (line, code, message) => ({ line, code, message });

/**
 * The md line an error points at: a MAP_* · CHART_* error's line as it is, another's
 * fence line counted from the fence's opening md line, that line itself for line 0.
 */
export const mdLine = (e, fenceLine) =>
  e.code.startsWith("MAP_") || e.code.startsWith("CHART_") ? e.line : e.line > 0 ? fenceLine + e.line : fenceLine;

/** BE FlowError.text(): `N 번째 줄 사유`, or the reason alone without a line. */
export const errorText = (e) => (e.line > 0 ? `${e.line} 번째 줄 ${e.message}` : e.message);

/** BE FlowError.report(): `N 번째 줄 CODE 사유`, or `CODE 사유` without a line. */
export const errorReport = (e) => `${e.line > 0 ? `${e.line} 번째 줄 ` : ""}${e.code} ${e.message}`;
