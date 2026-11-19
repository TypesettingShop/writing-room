import { addDisposableListener } from '../../../../base/browser/dom.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { galleryQueryLimit } from '../../../../platform/extensionManagement/common/extensionGalleryService.js';
import type { GalleryExtension } from '../../../../platform/extensionManagement/common/extensionGalleryService.js';
import { sourceNames } from './extensionInstallConfirmation.js';
import { IExtensionsWorkbenchService } from './extensionsWorkbenchService.js';
import type { ExtensionsWorkbenchService, InstalledExtension } from './extensionsWorkbenchService.js';
import './media/extensionsView.css';

function button(document: Document, label: string, action: () => void, name = label, key = label): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = 'extensions-action';
  element.textContent = label;
  element.setAttribute('aria-label', name);
  element.dataset.focusId = key;
  element.addEventListener('click', action);
  return element;
}

function message(document: Document, text: string, className = 'extensions-message'): HTMLParagraphElement {
  const element = document.createElement('p');
  element.className = className;
  element.textContent = text;
  return element;
}

class ExtensionList extends Disposable {
  protected readonly document: Document;
  protected readonly root: HTMLDivElement;
  protected readonly list: HTMLUListElement;

  constructor(parent: HTMLElement, protected readonly service: ExtensionsWorkbenchService, label: string) {
    super();
    this.document = parent.ownerDocument;
    this.root = this.document.createElement('div');
    this.root.className = 'extensions-body';
    this.list = this.document.createElement('ul');
    this.list.className = 'extensions-list';
    this.list.setAttribute('role', 'list');
    this.list.setAttribute('aria-label', label);
    this.root.append(this.list);
    parent.append(this.root);
    this._register(toDisposable(() => this.root.remove()));
  }

  protected renderList(rows: readonly HTMLLIElement[], fallback?: HTMLElement): void {
    const focused = this.document.activeElement;
    const focusId = focused instanceof HTMLElement && this.list.contains(focused) ? focused.dataset.focusId : undefined;
    this.list.replaceChildren(...rows);
    if (focusId) {
      const target = [...this.list.querySelectorAll<HTMLButtonElement>('button[data-focus-id]')]
        .find(candidate => candidate.dataset.focusId === focusId && !candidate.disabled);
      (target ?? fallback)?.focus();
    }
  }

  protected row(id: string, name: string, details: string): HTMLLIElement {
    const item = this.document.createElement('li');
    const title = this.document.createElement('strong');
    title.className = 'extensions-name';
    title.textContent = name;
    item.append(title, message(this.document, details, 'extensions-details'));
    const operation = this.service.operation(id);
    if (operation) {
      const status = message(this.document, operation.kind === 'installing' ? operation.text : 'Uninstalling…');
      status.setAttribute('role', 'status');
      item.append(status);
      if (operation.kind === 'installing' && operation.cancellable) {
        item.append(button(this.document, 'Cancel', () => this.service.cancel(id), 'Cancel ' + name, id));
      }
    } else {
      const failure = this.service.failure(id);
      if (failure) {
        const error = message(this.document, failure.message, 'extensions-error');
        error.setAttribute('role', 'status');
        const retry = button(this.document, 'Retry', failure.retry, 'Retry ' + name, id);
        retry.disabled = failure.requiresInstallSlot && !this.service.canStartInstall;
        item.append(error, retry);
      }
    }
    return item;
  }
}

type Icon = { readonly controller: AbortController; url?: string };

export class ExtensionsSearchView extends ExtensionList {
  private readonly input: HTMLInputElement;
  private readonly status: HTMLDivElement;
  private readonly navigation: HTMLDivElement;
  private readonly icons = new Map<string, Icon>();
  private dropPending = false;
  private readonly dropMessage: HTMLDivElement;

  constructor(parent: HTMLElement, @IExtensionsWorkbenchService service: ExtensionsWorkbenchService) {
    super(parent, service, 'Open VSX search results');
    this.input = this.document.createElement('input');
    this.input.type = 'search';
    this.input.setAttribute('aria-label', 'Search Open VSX');
    this.input.placeholder = 'Search Open VSX';
    this.input.maxLength = galleryQueryLimit;
    this.input.disabled = !this.service.galleryEnabled;
    this.input.value = this.service.query;
    this.status = this.document.createElement('div');
    this.status.setAttribute('role', 'status');
    this.navigation = this.document.createElement('div');
    this.dropMessage = this.document.createElement('div');
    this.dropMessage.setAttribute('role', 'status');
    this.root.prepend(this.input, this.status, this.dropMessage);
    this.root.append(this.navigation);
    this._register(addDisposableListener(this.input, 'input', () => this.service.search(this.input.value)));
    this._register(addDisposableListener(this.root, 'dragover', event => {
      if (event.dataTransfer?.types.includes('Files')) {
        event.preventDefault();
      }
    }));
    this._register(addDisposableListener(this.root, 'drop', event => {
      if (!event.dataTransfer?.types.includes('Files')) {
        return;
      }
      event.preventDefault();
      const files = [...event.dataTransfer.files];
      if (files.length !== 1 || !/\.vsix$/i.test(files[0].name)) {
        this.dropMessage.textContent = 'Drop one .vsix file to install it.';
      } else if (!this.dropPending) {
        this.dropPending = true;
        this.dropMessage.textContent = 'Reading VSIX…';
        void this.service.installDroppedFile(files[0]).then(() => {
          this.dropMessage.textContent = '';
        }, (error: unknown) => {
          this.dropMessage.textContent = error instanceof Error ? error.message : String(error);
        }).finally(() => { this.dropPending = false; });
      }
    }));
    this._register(service.onDidChange(() => this.render()));
    this._register(toDisposable(() => this.clearUnusedIcons(new Set())));
    this.render();
  }

  private render(): void {
    const service = this.service;
    const results = service.searchResults;
    const installed = new Map(service.installed.map(extension => [extension.id, extension]));
    this.status.textContent = !service.galleryEnabled ? 'Open VSX is unavailable.'
      : service.status === 'searching' ? 'Searching Open VSX…'
        : service.status === 'error' ? service.searchFailure ?? 'Open VSX search failed.'
          : service.galleryLimitMessage ?? (service.status === 'complete' && results.length === 0 ? 'No extensions found.' : '');
    this.list.setAttribute('aria-busy', String(service.status === 'searching'));
    const hadNavigationFocus = this.navigation.contains(this.document.activeElement);
    this.navigation.replaceChildren();
    if (service.status === 'error') {
      this.navigation.append(button(this.document, 'Retry Search', () => service.retrySearch()));
    } else if (service.hasMore) {
      const more = button(this.document, 'Load More', () => service.searchMore());
      more.disabled = service.status === 'searching';
      this.navigation.append(more);
    }
    if (hadNavigationFocus) {
      const next = this.navigation.querySelector<HTMLButtonElement>('button:not(:disabled)');
      (next ?? this.input).focus();
    }

    // A new query empties the results until its page arrives. Keep the icons until then, so a refined query
    // does not download (and spend the gallery quota on) the icons it shares with the previous one again.
    if (service.status !== 'searching') {
      this.clearUnusedIcons(new Set(results.flatMap(result => result.icon ? [result.icon] : [])));
    }
    this.renderList(results.map(result => this.renderResult(result, installed.get(result.id))), this.input);
  }

  private renderResult(result: GalleryExtension, installed: InstalledExtension | undefined): HTMLLIElement {
    const { id, displayName, namespace, version, verifiedPublisher, downloadCount, description } = result;
    const publisher = verifiedPublisher ? namespace + ' (verified publisher)' : namespace;
    const row = this.row(id, displayName, `${publisher} · ${version} · ${downloadCount.toLocaleString()} downloads`);
    if (description) {
      row.append(message(this.document, description, 'extensions-details'));
    }
    const icon = this.document.createElement('span');
    icon.className = 'extensions-icon codicon codicon-extensions';
    icon.setAttribute('aria-hidden', 'true');
    row.prepend(icon);
    if (result.icon) {
      icon.dataset.iconUrl = result.icon;
      const url = this.readIcon(result.icon).url;
      if (url) {
        this.showIcon(icon, url);
      }
    }
    if (!this.service.operation(id) && !this.service.failure(id)) {
      if (installed && !this.service.canUpdate(result, installed)) {
        row.append(message(this.document, 'Installed', 'extensions-details'));
      } else {
        const label = installed ? 'Update' : 'Install';
        const install = button(this.document, label, () => this.service.install(result), label + ' ' + displayName, id);
        install.disabled = !this.service.canStartInstall;
        row.append(install);
      }
    }
    return row;
  }

  private readIcon(url: string): Icon {
    const existing = this.icons.get(url);
    if (existing) {
      return existing;
    }
    const controller = new AbortController();
    const icon: Icon = { controller };
    this.icons.set(url, icon);
    void this.service.fetchIcon(url, controller.signal).then(blob => {
      if (!controller.signal.aborted) {
        icon.url = URL.createObjectURL(blob);
        for (const target of this.list.querySelectorAll<HTMLElement>('[data-icon-url]')) {
          if (target.dataset.iconUrl === url) {
            this.showIcon(target, icon.url);
          }
        }
      }
    }, () => {});
    return icon;
  }

  private showIcon(target: HTMLElement, url: string): void {
    const image = this.document.createElement('img');
    image.alt = '';
    image.src = url;
    image.addEventListener('error', () => image.remove(), { once: true });
    target.append(image);
  }

  private clearUnusedIcons(urls: ReadonlySet<string>): void {
    for (const [url, icon] of this.icons) {
      if (!urls.has(url)) {
        icon.controller.abort();
        if (icon.url) {
          URL.revokeObjectURL(icon.url);
        }
        this.icons.delete(url);
      }
    }
  }
}

export class InstalledExtensionsView extends ExtensionList {
  private readonly empty: HTMLParagraphElement;

  constructor(parent: HTMLElement, @IExtensionsWorkbenchService service: ExtensionsWorkbenchService) {
    super(parent, service, 'Installed extensions');
    this.root.tabIndex = -1;
    this.empty = message(this.document, 'No extensions installed.');
    this.root.prepend(this.empty);
    this._register(service.onDidChange(() => this.render()));
    this.render();
  }

  private render(): void {
    const items = this.service.installed;
    this.empty.hidden = items.length > 0;
    this.renderList(items.map(extension => {
      const { id, displayName, version, source } = extension;
      const details = `${id} · ${version} · ${source === 'builtin' ? 'Built-in' : sourceNames[source]}`;
      const row = this.row(id, displayName, details);
      if (source !== 'builtin' && !this.service.operation(id) && this.service.failure(id)?.requiresInstallSlot !== false) {
        row.append(button(this.document, 'Uninstall', () => this.service.uninstall(extension), 'Uninstall ' + displayName, id));
      }
      return row;
    }), this.root);
  }
}
