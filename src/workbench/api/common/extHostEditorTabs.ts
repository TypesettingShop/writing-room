import type * as vscode from 'vscode';
import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import type {
  ExtHostEditorTabsShape, MainThreadEditorTabsShape, TabData, TabGroupData, TabInputData,
} from './extHost.protocol.documents.js';
import type { ExtHostDocuments } from './extHostDocuments.js';

class TabInputText {
  constructor(readonly uri: vscode.Uri) {}
}

class TabInputTextDiff {
  constructor(readonly original: vscode.Uri, readonly modified: vscode.Uri) {}
}

class TabInputCustom {
  constructor(readonly uri: vscode.Uri, readonly viewType: string) {}
}

class TabInputWebview {
  constructor(readonly viewType: string) {}
}

class TabInputNotebook {
  constructor(readonly uri: vscode.Uri, readonly notebookType: string) {}
}

class TabInputNotebookDiff {
  constructor(readonly original: vscode.Uri, readonly modified: vscode.Uri, readonly notebookType: string) {}
}

class TabInputTerminal {}

export const tabInputTypes = {
  TabInputText, TabInputTextDiff, TabInputCustom, TabInputWebview, TabInputNotebook, TabInputNotebookDiff, TabInputTerminal,
};

function fromInput(input: TabInputData | undefined): unknown {
  switch (input?.kind) {
    case 'text': return Object.freeze(new TabInputText(input.uri as unknown as vscode.Uri));
    case 'custom': return Object.freeze(new TabInputCustom(input.uri as unknown as vscode.Uri, input.viewType));
    case 'webview': return Object.freeze(new TabInputWebview(input.viewType));
  }
}

class TabHandle {
  readonly value: vscode.Tab;
  input: unknown;

  constructor(public data: TabData, readonly group: GroupHandle) {
    this.input = fromInput(data.input);
    const handle = this;
    this.value = Object.freeze({
      get label() { return handle.data.label; },
      get group() { return group.value; },
      get input() { return handle.input; },
      get isDirty() { return handle.data.dirty; },
      get isActive() { return handle.data.active; },
      isPinned: false,
      isPreview: false,
    });
  }

  update(data: TabData): boolean {
    const old = this.data;
    this.data = data;
    const inputChanged = JSON.stringify(old.input) !== JSON.stringify(data.input);
    if (inputChanged) {
      this.input = fromInput(data.input);
    }
    return old.active !== data.active || old.dirty !== data.dirty || old.label !== data.label || inputChanged;
  }
}

class GroupHandle {
  readonly value: vscode.TabGroup;
  tabs = new Map<number, TabHandle>();

  constructor(public data: TabGroupData) {
    const handle = this;
    this.value = Object.freeze({
      get isActive() { return handle.data.active; },
      get viewColumn() { return handle.data.column; },
      get activeTab() { return [...handle.tabs.values()].find(tab => tab.data.active)?.value; },
      get tabs() { return [...handle.tabs.values()].map(tab => tab.value); },
    });
  }
}

export class ExtHostEditorTabs extends Disposable implements ExtHostEditorTabsShape {
  private groups = new Map<number, GroupHandle>();
  private readonly tabHandles = new WeakMap<vscode.Tab, TabHandle>();
  private readonly groupHandles = new WeakMap<vscode.TabGroup, GroupHandle>();
  private readonly groupsChanged = this._register(new Emitter<vscode.TabGroupChangeEvent>());
  private readonly tabsChanged = this._register(new Emitter<vscode.TabChangeEvent>());

  constructor(private readonly proxy: MainThreadEditorTabsShape, private readonly documents: ExtHostDocuments) { super(); }

  createApi(extension: string): vscode.TabGroups {
    const api = this;
    return Object.freeze({
      get all() { return [...api.groups.values()].map(group => group.value); },
      get activeTabGroup() {
        const group = [...api.groups.values()].find(entry => entry.data.active);
        if (!group) {
          throw new Error('There is no active tab group.');
        }
        return group.value;
      },
      onDidChangeTabGroups: this.documents.event(extension, this.groupsChanged.event),
      onDidChangeTabs: this.documents.event(extension, this.tabsChanged.event),
      close: (value: vscode.Tab | vscode.TabGroup | readonly (vscode.Tab | vscode.TabGroup)[], preserveFocus?: boolean) =>
        this.close(value, preserveFocus === true),
    });
  }

  private async close(value: vscode.Tab | vscode.TabGroup | readonly (vscode.Tab | vscode.TabGroup)[], preserveFocus: boolean): Promise<boolean> {
    const targets = Array.isArray(value) ? value : [value];
    const tabs: number[] = [];
    const groups: number[] = [];
    for (const target of targets) {
      const group = this.groupHandles.get(target);
      const tab = this.tabHandles.get(target);
      if (group && this.groups.get(group.data.id) === group) {
        groups.push(group.data.id);
      } else if (tab && this.groups.get(tab.group.data.id) === tab.group && tab.group.tabs.get(tab.data.id) === tab) {
        tabs.push(tab.data.id);
      } else {
        return false;
      }
    }
    try {
      return (!tabs.length || await this.proxy.$closeTabs(tabs, preserveFocus))
        && (!groups.length || await this.proxy.$closeTabGroups(groups, preserveFocus));
    } catch {
      return false;
    }
  }

  async $acceptTabGroups(groups: TabGroupData[]): Promise<void> {
    const next = new Map<number, GroupHandle>();
    const openedGroups: vscode.TabGroup[] = [];
    const closedGroups: vscode.TabGroup[] = [];
    const changedGroups: vscode.TabGroup[] = [];
    const opened: vscode.Tab[] = [];
    const closed: vscode.Tab[] = [];
    const changed: vscode.Tab[] = [];

    for (const data of groups) {
      let group = this.groups.get(data.id);
      if (!group) {
        group = new GroupHandle(data);
        this.groupHandles.set(group.value, group);
        openedGroups.push(group.value);
      } else if (data.active !== group.data.active || data.column !== group.data.column) {
        changedGroups.push(group.value);
      }
      const positions = new Map(group.data.tabs.map((tab, index) => [tab.id, index]));
      group.data = data;
      const tabs = new Map<number, TabHandle>();
      for (const [index, tabData] of data.tabs.entries()) {
        let tab = group.tabs.get(tabData.id);
        if (!tab) {
          tab = new TabHandle(tabData, group);
          this.tabHandles.set(tab.value, tab);
          opened.push(tab.value);
        } else if (tab.update(tabData) || positions.get(tabData.id) !== index) {
          changed.push(tab.value);
        }
        tabs.set(tabData.id, tab);
      }
      for (const [id, tab] of group.tabs) {
        if (!tabs.has(id)) {
          closed.push(tab.value);
        }
      }
      group.tabs = tabs;
      next.set(data.id, group);
    }
    for (const [id, group] of this.groups) {
      if (!next.has(id)) {
        closedGroups.push(group.value);
        closed.push(...group.value.tabs);
      }
    }
    this.groups = next;
    if (opened.length || closed.length || changed.length) {
      this.tabsChanged.fire({ opened, closed, changed });
    }
    if (openedGroups.length || closedGroups.length || changedGroups.length) {
      this.groupsChanged.fire({ opened: openedGroups, closed: closedGroups, changed: changedGroups });
    }
  }

  override dispose(): void {
    this.groups.clear();
    super.dispose();
  }
}
