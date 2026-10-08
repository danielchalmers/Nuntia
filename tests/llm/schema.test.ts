import { describe, expect, it } from 'vitest'
import { relaxSchema, toJsonSchema } from '../../src/llm/schema'

// A Gemini-dialect schema shaped like AutoTriage's analysis schema: a fixed enum on a value and a data-built enum on array items.
function geminiSchema() {
  return {
    type: 'OBJECT',
    properties: {
      summary: { type: 'STRING' },
      operations: {
        type: 'ARRAY',
        items: {
          anyOf: [
            {
              type: 'OBJECT',
              properties: {
                kind: { type: 'STRING', enum: ['add_labels', 'remove_labels'] },
                labels: { type: 'ARRAY', items: { type: 'STRING', enum: ['enhancement', 'bug', 'breaking change'] } },
                authorization: { type: 'STRING' },
              },
              required: ['kind', 'labels', 'authorization'],
            },
            {
              type: 'OBJECT',
              properties: {
                kind: { type: 'STRING', enum: ['set_state'] },
                state: { type: 'STRING', enum: ['open', 'completed', 'not_planned'] },
                authorization: { type: 'STRING' },
              },
              required: ['kind', 'state', 'authorization'],
            },
          ],
        },
      },
    },
    required: ['summary', 'operations'],
  }
}

describe('toJsonSchema', () => {
  it('lowercases types and closes every object, keeping key, required and enum order', () => {
    // Compared as a string, because strict-mode APIs emit required properties in schema order.
    expect(JSON.stringify(toJsonSchema(geminiSchema()))).toBe(JSON.stringify({
      type: 'object',
      properties: {
        summary: { type: 'string' },
        operations: {
          type: 'array',
          items: {
            anyOf: [
              {
                type: 'object',
                properties: {
                  kind: { type: 'string', enum: ['add_labels', 'remove_labels'] },
                  labels: { type: 'array', items: { type: 'string', enum: ['enhancement', 'bug', 'breaking change'] } },
                  authorization: { type: 'string' },
                },
                required: ['kind', 'labels', 'authorization'],
                additionalProperties: false,
              },
              {
                type: 'object',
                properties: {
                  kind: { type: 'string', enum: ['set_state'] },
                  state: { type: 'string', enum: ['open', 'completed', 'not_planned'] },
                  authorization: { type: 'string' },
                },
                required: ['kind', 'state', 'authorization'],
                additionalProperties: false,
              },
            ],
          },
        },
      },
      required: ['summary', 'operations'],
      additionalProperties: false,
    }))
  })

  it('turns nullable into a null type, drops propertyOrdering and keeps other keywords', () => {
    expect(toJsonSchema({
      type: 'OBJECT',
      properties: { note: { type: 'STRING', nullable: true, description: 'Optional note' }, count: { type: 'INTEGER' } },
      propertyOrdering: ['note', 'count'],
      required: ['note', 'count'],
    })).toEqual({
      type: 'object',
      properties: { note: { type: ['string', 'null'], description: 'Optional note' }, count: { type: 'integer' } },
      required: ['note', 'count'],
      additionalProperties: false,
    })
  })

  it('does not change its input', () => {
    const schema = geminiSchema()
    toJsonSchema(schema)
    relaxSchema(schema)

    expect(schema).toEqual(geminiSchema())
  })

  it('returns new arrays, so changing the result leaves the input alone', () => {
    const schema = geminiSchema()
    const converted = toJsonSchema(schema) as { required: string[] }
    converted.required.push('extra')

    expect(schema.required).toEqual(['summary', 'operations'])
  })
})

describe('relaxSchema', () => {
  it('drops the enum on array items and keeps the enums on single values', () => {
    const relaxed = toJsonSchema(relaxSchema(geminiSchema())) as any
    const [labelOperation, stateOperation] = relaxed.properties.operations.items.anyOf

    expect(labelOperation.properties.labels.items).toEqual({ type: 'string' })
    expect(labelOperation.properties.kind.enum).toEqual(['add_labels', 'remove_labels'])
    expect(stateOperation.properties.state.enum).toEqual(['open', 'completed', 'not_planned'])
    expect(labelOperation.additionalProperties).toBe(false)
  })

  it('leaves a schema without item enums as it was', () => {
    const schema = { type: 'OBJECT', properties: { tags: { type: 'ARRAY', items: { type: 'STRING' } } }, required: ['tags'] }

    expect(relaxSchema(schema)).toEqual(schema)
  })
})
