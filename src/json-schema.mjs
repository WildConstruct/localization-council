/**
 * Minimal JSON Schema validator (no dependencies).
 *
 * Supports the subset the council's own schemas use: type (string or array),
 * properties, required, additionalProperties (boolean or schema), items,
 * enum, const, minimum, maximum, minItems, minLength, anyOf, and local
 * $ref ("#/$defs/…"). Anything else is ignored rather than rejected, so keep
 * schemas in schemas/ inside this subset.
 */

import { readFileSync } from "node:fs";

const SCHEMA_DIR = new URL("../schemas/", import.meta.url);
const cache = new Map();

/** Load a schema from schemas/ by file name (cached). */
export function loadSchema(name) {
  if (!cache.has(name)) {
    cache.set(name, JSON.parse(readFileSync(new URL(name, SCHEMA_DIR), "utf8")));
  }
  return cache.get(name);
}

function typeOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

function typeMatches(value, type) {
  const actual = typeOf(value);
  if (type === "number") return actual === "number" || actual === "integer";
  return actual === type;
}

function resolveRef(root, ref) {
  if (!ref.startsWith("#/")) throw new Error(`Unsupported $ref "${ref}"`);
  let node = root;
  for (const part of ref.slice(2).split("/")) {
    node = node?.[part];
    if (node === undefined) throw new Error(`Unresolvable $ref "${ref}"`);
  }
  return node;
}

function check(value, schema, root, path, errors) {
  if (schema === true || schema == null) return;
  if (schema === false) {
    errors.push(`${path}: not allowed`);
    return;
  }
  if (schema.$ref) {
    check(value, resolveRef(root, schema.$ref), root, path, errors);
    return;
  }
  if (schema.anyOf) {
    const ok = schema.anyOf.some((s) => {
      const sub = [];
      check(value, s, root, path, sub);
      return sub.length === 0;
    });
    if (!ok) {
      errors.push(`${path}: does not match any allowed shape`);
      return;
    }
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(value, t))) {
      errors.push(`${path}: expected ${types.join("|")}, got ${typeOf(value)}`);
      return;
    }
  }
  if ("const" in schema && value !== schema.const) {
    errors.push(`${path}: expected ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum && !schema.enum.some((e) => e === value)) {
    errors.push(`${path}: expected one of ${JSON.stringify(schema.enum)}`);
  }
  if (typeof value === "number") {
    if (schema.minimum != null && value < schema.minimum) {
      errors.push(`${path}: ${value} < minimum ${schema.minimum}`);
    }
    if (schema.maximum != null && value > schema.maximum) {
      errors.push(`${path}: ${value} > maximum ${schema.maximum}`);
    }
  }
  if (typeof value === "string" && schema.minLength != null && value.length < schema.minLength) {
    errors.push(`${path}: shorter than ${schema.minLength}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) {
      errors.push(`${path}: fewer than ${schema.minItems} items`);
    }
    if (schema.items) {
      value.forEach((v, i) => check(v, schema.items, root, `${path}[${i}]`, errors));
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const req of schema.required || []) {
      if (!(req in value)) errors.push(`${path}: missing required "${req}"`);
    }
    const props = schema.properties || {};
    for (const [k, v] of Object.entries(value)) {
      if (k in props) {
        check(v, props[k], root, `${path}.${k}`, errors);
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}: unexpected property "${k}"`);
      } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        check(v, schema.additionalProperties, root, `${path}.${k}`, errors);
      }
    }
  }
}

/**
 * Validate a value. Returns { ok, errors }.
 * @param {unknown} value
 * @param {object|string} schema - schema object, or a file name in schemas/
 */
export function validate(value, schema) {
  const root = typeof schema === "string" ? loadSchema(schema) : schema;
  const errors = [];
  check(value, root, root, "$", errors);
  return { ok: errors.length === 0, errors };
}

/** Validate and throw with a readable message on failure. */
export function assertValid(value, schema, label = "value") {
  const { ok, errors } = validate(value, schema);
  if (!ok) {
    throw new Error(`${label} failed schema validation: ${errors.slice(0, 5).join("; ")}`);
  }
  return value;
}

/** Validate against one entry of a schema file's $defs (e.g. stage-results.v1.json#translate). */
export function validateDef(value, file, def) {
  const root = loadSchema(file);
  if (!root.$defs?.[def]) throw new Error(`${file} has no $defs.${def}`);
  const errors = [];
  check(value, root.$defs[def], root, "$", errors);
  return { ok: errors.length === 0, errors };
}
