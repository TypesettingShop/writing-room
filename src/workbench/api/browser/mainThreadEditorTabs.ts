import { Disposable } from '../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import { Schemas } from '../../../base/common/network.js';
import { ITextModelService } from '../../../editor/common/services/resolverService.js';
import type { EditorInput } from '../../common/editor/editorInput.js';
import { GroupsOrder, IEditorGroupsService } from '../../services/editor/common/editorGroupsService.js';
import type { IEditorGroup } from '../../services/editor/common/editorGroupsService.js';
import type {
  ExtHostEditorTabsShape, MainThreadEditorTabsShape, TabData, TabGroupData, TabInputData,
} from '../common/extHost.protocol.documents.js';
import type { MainThreadDocuments } from './mainThreadDocuments.js';

interface TrackedGroup {
  readonly group: IEditorGroup;
  readonly tabs: Map<EditorInput, number>;
  readonly listener: IDisposable;
}

export class MainThreadEditorTabs extends Disposable implements MainThreadEditorTabsShape {
  private readonly tracked = new Map<number, TrackedGroup>();
  private nextTab = 0;
  private previous: TabGroupData[] = [];
  private pending = false;
  private stopped = false;

  constructor(
    private readonly proxy: ExtHostEditorTabsShape,
    private readonly documents: MainThreadDocuments,
    @IEditorGroupsService private readonly groups: IEditorGroupsService,
    @ITextModelService private readonly models: ITextModelService,
  ) {
    super();
    this._register(groups.onDidChangeActiveGroup(() => this.schedule()));
    this._register(groups.onDidAddGroup(group => { this.track(group); this.schedule(); }));
    this._register(groups.onDidRemoveGroup(group => {
      this.tracked.get(group.id)?.listener.dispose();
      this.tracked.delete(group.id);
      this.schedule();
    }));
    this._register(groups.onDidMoveGroup(() => this.schedule()));
    this._register(documents.onDidStartSync(() => this.publish()));
    this._register(documents.onDidChangeMirrors(() => this.schedule()));
    for (const group of groups.groups) {
      this.track(group);
    }
    this.publish();
  }

  private track(group: IEditorGroup): void {
    this.tracked.set(group.id, { group, tabs: new Map(), listener: group.onDidModelChange(() => this.schedule()) });
  }

  private schedule(): void {
    if (!this.pending) {
      this.pending = true;
      queueMicrotask(() => {
        this.pending = false;
        this.publish();
      });
    }
  }

  private input(editor: EditorInput): TabInputData | undefined {
    const uri = editor.resource;
    const viewType = 'viewType' in editor && typeof editor.viewType === 'string' ? editor.viewType : undefined;
    if (viewType !== undefined) {
      if (!uri || uri.scheme === Schemas.webviewPanel) {
        return { kind: 'webview', viewType };
      }
      return { kind: 'custom', uri, viewType };
    }
    return uri && this.models.canHandleResource(uri) ? { kind: 'text', uri } : undefined;
  }

  private read(tracked: TrackedGroup, column: number): TabGroupData {
    const { group, tabs } = tracked;
    const tabData: TabData[] = [];
    const live = new Set(group.editors);
    for (const editor of tabs.keys()) {
      if (!live.has(editor)) {
        tabs.delete(editor);
      }
    }
    for (const editor of group.editors) {
      let id = tabs.get(editor);
      if (id === undefined) {
        tabs.set(editor, id = ++this.nextTab);
      }
      tabData.push({ id, label: editor.getName(), dirty: editor.isDirty(), active: group.isActive(editor), input: this.input(editor) });
    }
    return { id: group.id, column, active: group === this.groups.activeGroup, tabs: tabData };
  }

  private publish(): void {
    if (this.stopped || !this.documents.isReady) {
      return;
    }
    const next = this.groups.getGroups(GroupsOrder.GRID_APPEARANCE).map((group, index) => this.read(this.tracked.get(group.id)!, index + 1));
    if (JSON.stringify(next) !== JSON.stringify(this.previous)) {
      this.previous = next;
      void this.proxy.$acceptTabGroups(next).catch(() => {});
    }
  }

  async $closeTabs(ids: number[], _preserveFocus: boolean): Promise<boolean> {
    if (this.stopped || !Array.isArray(ids)) {
      return false;
    }
    const remaining = new Set(ids);
    const targets = new Map<IEditorGroup, EditorInput[]>();
    for (const { group, tabs } of this.tracked.values()) {
      const requested = group.editors.filter(editor => {
        const id = tabs.get(editor);
        return id !== undefined && remaining.delete(id);
      });
      if (requested.length) {
        targets.set(group, requested);
      }
    }
    if (remaining.size) {
      return false;
    }
    for (const [group, editors] of targets) {
      if (!await group.closeEditors(editors)) {
        return false;
      }
    }
    this.publish();
    return true;
  }

  async $closeTabGroups(ids: number[], preserveFocus: boolean): Promise<boolean> {
    if (this.stopped || !Array.isArray(ids)) {
      return false;
    }
    const targets = [...new Set(ids)].map(id => this.groups.getGroup(id));
    if (targets.some(group => group === undefined)) {
      return false;
    }
    for (const group of targets) {
      if (!group || !await group.closeAllEditors()) {
        return false;
      }
      if (this.groups.count > 1) {
        this.groups.removeGroup(group, preserveFocus);
      }
    }
    this.publish();
    return true;
  }

  override dispose(): void {
    this.stopped = true;
    for (const { listener } of this.tracked.values()) {
      listener.dispose();
    }
    this.tracked.clear();
    super.dispose();
  }
}
