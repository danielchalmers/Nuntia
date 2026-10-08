// Source: AutoTriage (danielchalmers/AutoTriage, src/llm/). Nuntia copies this folder verbatim, so change it in AutoTriage and copy it over in a paired PR.

// Response schemas for APIs that take standard JSON Schema.
// Callers write one schema in the Gemini API's dialect (uppercase types), which the Gemini adapter sends as is and the others convert here.

type SchemaNode = Record<string, unknown>;

function isNode(value: unknown): value is SchemaNode {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Convert a Gemini-dialect schema to the strict JSON Schema the Claude and OpenAI APIs take.
 * Types are lowercased, `nullable` becomes a type that also allows null, Gemini's `propertyOrdering` is dropped, and every object gets `additionalProperties: false`, which strict mode requires.
 * Key order, `required` order and `enum` order are kept, and the input is not changed.
 */
export function toJsonSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toJsonSchema);
  if (!isNode(schema)) return schema;

  const converted: SchemaNode = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'nullable' || key === 'propertyOrdering') continue;
    if (key === 'type' && typeof value === 'string') {
      converted.type = schema.nullable === true ? [value.toLowerCase(), 'null'] : value.toLowerCase();
    } else if (key === 'properties' && isNode(value)) {
      converted.properties = Object.fromEntries(Object.entries(value).map(([name, property]) => [name, toJsonSchema(property)]));
    } else if (key === 'items' || key === 'anyOf') {
      converted[key] = toJsonSchema(value);
    } else {
      converted[key] = Array.isArray(value) ? [...value] : value;
    }
  }
  if (typeof schema.type === 'string' && schema.type.toUpperCase() === 'OBJECT') {
    converted.additionalProperties = false;
  }
  return converted;
}

/**
 * The same schema without the `enum` on the items of any array, for an API that rejects the full schema as too large or complex.
 * Long enums built from data, such as repository labels, sit on array items, while short fixed ones on single values (an operation's kind or state) stay.
 * Works on either dialect, and the input is not changed.
 */
export function relaxSchema(schema: unknown): unknown {
  return withoutItemEnums(schema, false);
}

function withoutItemEnums(schema: unknown, isArrayItems: boolean): unknown {
  if (Array.isArray(schema)) return schema.map(item => withoutItemEnums(item, isArrayItems));
  if (!isNode(schema)) return schema;

  const relaxed: SchemaNode = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'enum' && isArrayItems) continue;
    if (key === 'properties' && isNode(value)) {
      relaxed.properties = Object.fromEntries(Object.entries(value).map(([name, property]) => [name, withoutItemEnums(property, false)]));
    } else if (key === 'items') {
      relaxed.items = withoutItemEnums(value, true);
    } else if (key === 'anyOf') {
      // The variants of an array's items are items too.
      relaxed.anyOf = withoutItemEnums(value, isArrayItems);
    } else {
      relaxed[key] = Array.isArray(value) ? [...value] : value;
    }
  }
  return relaxed;
}
