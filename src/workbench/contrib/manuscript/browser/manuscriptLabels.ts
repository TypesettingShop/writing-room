import { Emitter } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import type { URI } from '../../../../base/common/uri.js';
import { isManuscriptId } from '../../../../platform/manuscript/common/manuscript.js';
import { registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { registerResourceLabelProvider } from '../../../services/label/common/resourceLabels.js';
import { manuscriptScheme } from '../../../services/manuscript/browser/manuscriptFileSystemProvider.js';
import { breadcrumb } from '../common/manuscriptTree.js';
import { IManuscriptViewState, type ManuscriptViewState } from './manuscriptViewState.js';

let state: ManuscriptViewState | undefined;
const labelsChanged = new Emitter<void>();

function nodeId(resource: URI): string | undefined {
  if (!state?.workId || resource.authority !== state.workId || resource.query || resource.fragment ||
      !resource.path.startsWith('/') || !resource.path.endsWith('.md')) {
    return undefined;
  }
  const id = resource.path.slice(1, -3);
  return isManuscriptId(id) ? id : undefined;
}

registerResourceLabelProvider(manuscriptScheme, {
  onDidChange: labelsChanged.event,
  getName(resource) {
    const id = nodeId(resource);
    return id && state?.index?.labels.get(id) || 'Document';
  },
  getDescription(resource) {
    const id = nodeId(resource);
    return id && state?.index ? breadcrumb(id, state.index).slice(0, -1).join(' / ') : '';
  },
});

class ManuscriptLabelsContribution extends Disposable {
  constructor(@IManuscriptViewState viewState: ManuscriptViewState) {
    super();
    if (!viewState.workId) {
      return;
    }
    state = viewState;
    this._register(viewState.onDidChangeTree(() => labelsChanged.fire()));
    this._register(toDisposable(() => {
      if (state === viewState) {
        state = undefined;
      }
    }));
    labelsChanged.fire();
    void viewState.ensureLoaded();
  }
}

registerWorkbenchContribution2('workbench.contrib.manuscriptLabels', ManuscriptLabelsContribution);
