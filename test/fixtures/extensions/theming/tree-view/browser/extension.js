const vscode = require('vscode');

const treeType = 'application/vnd.code.tree.treefixture.notes';

function node(name, children, extra = {}) {
  const result = { name, children, ...extra };
  for (const child of children ?? []) {
    child.parent = result;
  }
  return result;
}

const deep = node('Deep');
const draft = node('Draft', undefined, { checkbox: true });
const ideas = node('Ideas', [deep]);
const inbox = node('Inbox', [draft, ideas]);
const archive = node('Archive', []);
const readme = node('Readme', undefined, { resource: true });
const roots = [inbox, archive, readme];
const all = () => {
  const result = [];
  const visit = list => list.forEach(item => { result.push(item); visit(item.children ?? []); });
  visit(roots);
  return result;
};

// The events land in one status bar entry, newest last, so a test reads them without a pile of toasts.
const log = [];
let status;

function say(text) {
  log.push(text);
  status.text = log.slice(-12).join(' | ');
}

module.exports.activate = context => {
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
  status.name = 'Tree Fixture Log';
  status.text = 'Tree Fixture';
  status.show();
  context.subscriptions.push(status);
  const changes = new vscode.EventEmitter();
  let notes = [];
  const media = name => vscode.Uri.joinPath(context.extensionUri, 'media', name);
  const provider = {
    onDidChangeTreeData: changes.event,
    getChildren: element => element ? element.children ?? [] : roots,
    getParent: element => element.parent,
    getTreeItem: element => {
      const item = element.resource
        ? new vscode.TreeItem(vscode.Uri.joinPath(context.extensionUri, 'docs', 'readme.md'))
        : new vscode.TreeItem(element.name, element.children ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
      item.id = element.name;
      if (element === inbox) {
        item.iconPath = new vscode.ThemeIcon('inbox', new vscode.ThemeColor('charts.blue'));
      } else if (element === ideas) {
        item.iconPath = new vscode.ThemeIcon('lightbulb');
      } else if (element === draft) {
        item.iconPath = { light: media('light.svg'), dark: media('dark.svg') };
        item.checkboxState = element.checked ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
      } else if (element === archive) {
        // Outside the extension's folder: not shown.
        item.iconPath = vscode.Uri.parse('https://example.com/icon.svg');
      } else if (element === readme) {
        item.accessibilityInformation = { label: 'Read me first' };
      }
      return item;
    },
    resolveTreeItem: (item, element) => {
      if (element === readme) {
        item.tooltip = 'Resolved readme';
      }
      return item;
    },
  };
  const view = vscode.window.createTreeView('treeFixture.notes', {
    treeDataProvider: provider,
    showCollapseAll: true,
    canSelectMany: true,
    dragAndDropController: {
      dragMimeTypes: [treeType],
      dropMimeTypes: [treeType, 'text/plain', 'files'],
      handleDrag: (source, transfer) => {
        transfer.set(treeType, new vscode.DataTransferItem(source));
      },
      handleDrop: async (target, transfer) => {
        const moved = transfer.get(treeType)?.value;
        if (Array.isArray(moved)) {
          const own = moved.every(item => all().includes(item));
          const destination = target?.children ? target : undefined;
          for (const item of moved) {
            const from = item.parent ? item.parent.children : roots;
            from.splice(from.indexOf(item), 1);
            (destination ? destination.children : roots).push(item);
            item.parent = destination;
          }
          changes.fire(undefined);
          say('Moved: ' + moved.map(item => item.name).join(', ') + ' to ' + (destination?.name ?? 'the root') + (own ? ' (same objects)' : ' (copies)'));
          return;
        }
        for (const [mimeType, item] of transfer) {
          const file = item.asFile();
          if (file) {
            const data = await file.data();
            say('Dropped file: ' + file.name + ' (' + data.length + ' bytes)');
          } else if (mimeType === 'text/plain') {
            say('Dropped text: ' + await item.asString());
          }
        }
      },
    },
  });
  context.subscriptions.push(view);
  view.onDidChangeSelection(event => {
    say('Selected: ' + event.selection.map(item => item.name).join(', ')
      + (event.selection.every(item => all().includes(item)) ? ' (same objects)' : ' (copies)'));
  });
  view.onDidExpandElement(event => say('Expanded: ' + event.element.name + (all().includes(event.element) ? ' (same object)' : ' (copy)')));
  view.onDidCollapseElement(event => say('Collapsed: ' + event.element.name));
  view.onDidChangeVisibility(event => say('Visible: ' + event.visible));
  view.onDidChangeCheckboxState(event => {
    for (const [item, state] of event.items) {
      item.checked = state === vscode.TreeItemCheckboxState.Checked;
    }
    say('Checked: ' + event.items.map(([item, state]) => item.name + '=' + state).join(', ')
      + (event.items.every(([item]) => all().includes(item)) ? ' (same objects)' : ' (copies)'));
  });

  const empty = vscode.window.createTreeView('treeFixture.empty', {
    treeDataProvider: { onDidChangeTreeData: changes.event, getChildren: () => notes, getTreeItem: name => new vscode.TreeItem(name) },
  });
  context.subscriptions.push(empty);

  context.subscriptions.push(vscode.commands.registerCommand('treeFixture.create', () => {
    notes = ['First note'];
    changes.fire(undefined);
    say('Created a note');
  }));
  context.subscriptions.push(vscode.commands.registerCommand('treeFixture.reveal', async () => {
    try {
      await view.reveal(deep, { select: true, focus: true });
      say('Revealed: ' + view.selection.map(item => item.name).join(', '));
    } catch (error) {
      say('Reveal failed: ' + error.message);
    }
    try {
      await empty.reveal('anything');
    } catch (error) {
      say('Empty reveal: ' + error.message);
    }
  }));
  context.subscriptions.push(vscode.commands.registerCommand('treeFixture.decorate', () => {
    view.title = 'Notebook';
    view.description = 'three notes';
    view.badge = { value: 3, tooltip: '3 unread notes' };
    view.message = 'Drag notes to <b>file</b> them.';
  }));
  context.subscriptions.push(vscode.commands.registerCommand('treeFixture.move', () => {
    // Draft keeps its id and moves from Inbox to Archive; a full refresh shows it once, under Archive.
    inbox.children.splice(inbox.children.indexOf(draft), 1);
    archive.children.push(draft);
    draft.parent = archive;
    changes.fire(undefined);
  }));
};
