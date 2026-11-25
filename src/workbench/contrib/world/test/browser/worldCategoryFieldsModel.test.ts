import { expect, test, vi } from 'vitest';
import type { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import type { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { WorldStoreError, type WorldCategory } from '../../../../../platform/world/common/world.js';
import type { WorldStore } from '../../../../../platform/world/common/worldStore.js';
import { WorldCategoryFieldsModel } from '../../browser/worldCategoryFieldsModel.js';

const node: WorldCategory = {
  id: 'category', parentId: null, kind: 'category', title: '장소', position: 0, createdAt: 0, updatedAt: 0,
  fields: [{ id: 'name', label: '이름', kind: 'text' }],
};

test('holds invalid fields and retries on unrelated revisions without replacing raw labels', async () => {
  const storeRevision = 2;
  const updateNode = vi.fn<WorldStore['updateNode']>(async (_workId, _id, update, revision) => {
    if (revision !== storeRevision) {
      throw new WorldStoreError('conflict', storeRevision);
    }
    return { revision: revision + 1, node: { ...node, fields: update.fields! } };
  });
  const prompt = vi.fn<IDialogService['prompt']>();
  const read = vi.fn(async () => ({ value: { fields: node.fields }, revision: storeRevision }));
  const model = new WorldCategoryFieldsModel('work', node, 1, { updateNode },
    revision => revision === 3 ? Promise.resolve(undefined) : read(), () => node.title,
    { _serviceBrand: undefined, prompt }, { error: vi.fn(), warn: vi.fn() } as unknown as INotificationService);
  try {
    model.edit({ fields: [{ id: 'name', label: '', kind: 'text' }] });
    expect(await model.save('explicit')).toBe(false);
    expect(model.saveBlock).toEqual({ kind: 'validation', problems: [{ fieldId: 'name', message: 'Enter a label.' }] });
    expect(updateNode).not.toHaveBeenCalled();
    model.edit({ fields: [{ id: 'name', label: '항구 이름 ', kind: 'text' }] });
    expect(await model.save('explicit')).toBe(true);
    expect(prompt).not.toHaveBeenCalled();
    expect(updateNode.mock.calls.map(call => call[3])).toEqual([1, 2]);
    expect(updateNode.mock.lastCall?.[2]).toEqual({ fields: [{ id: 'name', label: '항구 이름', kind: 'text' }] });
    expect(model.draft.fields[0].label).toBe('항구 이름 ');
    expect(model.dirty).toBe(false);
  } finally {
    model.dispose();
  }
});
