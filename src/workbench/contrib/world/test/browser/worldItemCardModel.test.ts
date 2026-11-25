import { expect, test, vi } from 'vitest';
import { URI } from '../../../../../base/common/uri.js';
import { characterLimits } from '../../../../../platform/characters/common/characters.js';
import type { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import type { INotificationService } from '../../../../../platform/notification/common/notification.js';
import type { WorldItem } from '../../../../../platform/world/common/world.js';
import type { WorldStore } from '../../../../../platform/world/common/worldStore.js';
import { WorldItemCardModel } from '../../browser/worldItemCardModel.js';
import { worldItemId, worldItemUri } from '../../browser/worldItemEditorInput.js';

const workId = '00000000-0000-0000-0000-000000000001';
const node: WorldItem = {
  kind: 'item', id: '00000000-0000-0000-0000-000000000002', parentId: '00000000-0000-0000-0000-000000000003',
  title: '항구', position: 0, createdAt: 0, updatedAt: 0, values: { removed: '보존' },
};

test('rejects oversized UTF-8 values before a write and preserves hidden fields on the next save', async () => {
  const updateNode = vi.fn<WorldStore['updateNode']>(async (_work, _id, patch) => ({
    revision: 2, node: { ...node, values: patch.values! },
  }));
  const error = vi.fn();
  const model = new WorldItemCardModel(workId, node, 1, { updateNode }, async () => undefined,
    {} as IDialogService, { error } as unknown as INotificationService);
  try {
    // A third of the limit in characters is over it in UTF-8 bytes, so a character count would let it through.
    model.edit({ ...model.draft, values: { ...model.draft.values, notes: '한'.repeat(Math.ceil(characterLimits.values / 3)) } });
    expect(await model.save('explicit')).toBe(false);
    expect(error).toHaveBeenCalledOnce();
    expect(updateNode).not.toHaveBeenCalled();

    model.edit({ ...model.draft, values: { ...model.draft.values, notes: '가나다' } });
    expect(await model.save('explicit')).toBe(true);
    expect(updateNode).toHaveBeenCalledExactlyOnceWith(workId, node.id, {
      title: '항구', values: { removed: '보존', notes: '가나다' },
    }, 1);
  } finally {
    model.dispose();
  }
});

test('accepts item resources only for the current work and unadorned item path', () => {
  const resource = worldItemUri(workId, node.id);
  expect(worldItemId(resource, workId)).toBe(node.id);
  expect(worldItemId(resource, node.parentId!)).toBeUndefined();
  expect(worldItemId(URI.parse(resource.toString() + '?revision=1'), workId)).toBeUndefined();
});
