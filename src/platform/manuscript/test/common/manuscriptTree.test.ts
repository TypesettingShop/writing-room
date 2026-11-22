// @vitest-environment node
import { expect, it } from 'vitest';
import { manuscriptLimits, type ManuscriptNode } from '../../common/manuscript.js';
import { ManuscriptTreeEditor } from '../../common/manuscriptTree.js';

it('bounds the total metadata in a work while allowing titles and smaller replacements', () => {
  const nodes = new Map<string, ManuscriptNode>();
  const payload = { data: 'a'.repeat(manuscriptLimits.metadata - '{"data":""}'.length) };
  const full = manuscriptLimits.workMetadata / manuscriptLimits.metadata;
  for (let position = 0; position <= full; position++) {
    const id = String(position);
    nodes.set(id, {
      id, position, parentId: null, kind: 'document', title: '', metadata: position < full ? payload : {},
      createdAt: 0, updatedAt: 0,
    });
  }
  const id = String(full);
  const rejected = new ManuscriptTreeEditor(nodes);
  expect(() => rejected.update(id, { title: 'Uncommitted', metadata: { label: '한글' } }, 1))
    .toThrow(expect.objectContaining({ code: 'too_large' }));
  expect(rejected.changed.size).toBe(0);
  expect(rejected.update(id, { title: 'A title still fits' }, 1).title).toBe('A title still fits');

  const reducing = new ManuscriptTreeEditor(nodes);
  nodes.set('0', reducing.update('0', { metadata: {} }, 1));
  const replacement = new ManuscriptTreeEditor(nodes);
  expect(replacement.update(id, { metadata: payload }, 1).metadata).toEqual(payload);
});
