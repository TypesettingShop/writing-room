import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import { isEqualOrParent } from '../../../base/common/resources.js';
import { URI } from '../../../base/common/uri.js';
import { IFileService } from '../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import type { HostExtensionDescription } from '../../services/extensions/common/extensionHostProtocol.js';
import { resolveExtensionPath } from '../../services/extensions/common/extensionResources.js';
import { decorationRangeLimit } from '../common/extHost.protocol.documents.js';
import type { DecorationInstance, MainThreadDecorationsShape } from '../common/extHost.protocol.documents.js';
import { validateModelRange } from './mainThreadDocumentEdits.js';
import { forbiddenResourcePath } from './mainThreadDocuments.js';
import type { MainThreadEditor } from './mainThreadEditor.js';
import { cssString, decorationColor, decorationCss, decorationIconSize, decorationOptions, themedDecoration } from './mainThreadEditorDecorationStyles.js';
import type { MainThreadEditors } from './mainThreadEditors.js';

type Collection = ReturnType<MainThreadEditor['control']['createDecorationsCollection']>;
type Decoration = Parameters<Collection['set']>[0][number];

interface Applied {
  readonly entries: DecorationInstance[];
  readonly collection: Collection;
  readonly editor: MainThreadEditor;
  readonly style: HTMLStyleElement;
  readonly dispose: IDisposable;
}

interface Registered {
  readonly extension: HostExtensionDescription;
  readonly options: Record<string, unknown>;
  readonly applied: Map<string, Applied>;
  readonly icons: Map<string, string | undefined>;
  warned: boolean;
}

let nextStyle = 0;
const iconLimit = 256 * 1024;
const imageType: Readonly<Record<string, string>> = {
  svg: 'image/svg+xml', png: 'image/png', gif: 'image/gif', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', ico: 'image/x-icon',
};

export class MainThreadEditorDecorations extends Disposable implements MainThreadDecorationsShape {
  private readonly types = new Map<string, Registered>();

  constructor(
    private readonly editors: MainThreadEditors,
    private readonly getExtension: (key: string) => HostExtensionDescription | undefined,
    @IThemeService private readonly themes: IThemeService,
    @IFileService private readonly files: IFileService,
    @IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
  ) {
    super();
    this._register(themes.onDidColorThemeChange(() => {
      for (const entry of this.types.values()) {
        this.refresh(entry);
      }
    }));
  }

  async $registerDecoration(extension: string, key: string, options: object): Promise<void> {
    const owner = this.getExtension(extension);
    if (!owner || typeof key !== 'string' || !/^decoration-\d+$/.test(key) || this.types.has(key)
      || !options || typeof options !== 'object') {
      throw new Error('Invalid text editor decoration type.');
    }
    this.types.set(key, { extension: owner, options: decorationOptions(options), applied: new Map(), icons: new Map(), warned: false });
  }

  async $removeDecoration(extension: string, key: string): Promise<void> {
    const entry = this.types.get(key);
    if (entry?.extension.key === extension) {
      this.removeType(key, entry);
    }
  }

  async $setDecorations(extension: string, id: string, key: string, entries: DecorationInstance[], truncated: boolean): Promise<void> {
    const editor = this.editors.get(id);
    const type = this.types.get(key);
    if (!editor || type?.extension.key !== extension || !Array.isArray(entries)) {
      return;
    }
    if (!type.warned && (truncated || entries.length > decorationRangeLimit)) {
      type.warned = true;
      console.warn(`[${type.extension.id}] Decorations limited to ${decorationRangeLimit} ranges per editor and type.`);
    }
    const clipped = entries.slice(0, decorationRangeLimit).map(entry => ({
      range: validateModelRange(editor.model, entry.range), hover: entry.hover, render: entry.render,
    }));
    const old = type.applied.get(id);
    if (old) {
      editor.decorations.delete(old.dispose);
    }
    if (!clipped.length) {
      return;
    }
    const collection = editor.control.createDecorationsCollection();
    const doc = editor.control.getDomNode()?.ownerDocument;
    if (!doc) {
      return;
    }
    const style = doc.createElement('style');
    doc.head.append(style);
    const dispose = editor.decorations.add(toDisposable(() => {
      collection.clear();
      style.remove();
      type.applied.delete(id);
    }));
    const applied = { editor, entries: clipped, collection, style, dispose };
    type.applied.set(id, applied);
    this.render(type, applied, false);
  }

  private refresh(type: Registered): void {
    for (const applied of type.applied.values()) {
      this.render(type, applied, true);
    }
  }

  private render(type: Registered, applied: Applied, useTrackedRanges: boolean): void {
    const theme = this.themes.getColorTheme();
    const styles = themedDecoration(type.options, theme);
    const prefix = 'wr-extension-decoration-' + ++nextStyle;
    const rules: string[] = [];
    const names = new Map<string, string>();
    const addRule = (contents: string, pseudo = '') => {
      if (!contents) {
        return undefined;
      }
      const key = pseudo + '\0' + contents;
      let name = names.get(key);
      if (!name) {
        name = prefix + '-' + names.size;
        names.set(key, name);
        rules.push('.monaco-editor .' + name + pseudo + '{' + contents + '}');
      }
      return name;
    };
    const inline = addRule(decorationCss(styles, theme));
    const gutter = this.icon(type, styles.gutterIconPath);
    const gutterCss = gutter && 'background:no-repeat center url(' + cssString(gutter) + ');background-size:'
      + (decorationIconSize(styles.gutterIconSize) ?? 'contain');
    const glyphMarginClassName = gutterCss ? addRule(gutterCss) : undefined;
    const overviewColor = decorationColor(styles.overviewRulerColor, theme);
    const lane = [1, 2, 4, 7].includes(styles.overviewRulerLane as number) ? styles.overviewRulerLane as 1 | 2 | 4 | 7 : 2;
    const stickiness = [0, 1, 2, 3].includes(styles.rangeBehavior as number) ? styles.rangeBehavior as 0 | 1 | 2 | 3 : 0;
    const attachment = (side: 'before' | 'after', base: Record<string, unknown>, override: Record<string, unknown>) => {
      const options = { ...base, ...override };
      const icon = this.icon(type, options.contentIconPath);
      const content = typeof options.contentText === 'string' ? options.contentText.slice(0, 2048) : undefined;
      if (content === undefined && !icon) {
        return undefined;
      }
      const css = 'content:' + (content === undefined ? 'url(' + cssString(icon!) + ')' : cssString(content))
        + ';display:inline-block;' + decorationCss(options, theme, true);
      return addRule(css, '::' + side);
    };
    const decorations: Decoration[] = [];
    for (const [index, item] of applied.entries.entries()) {
      const range = useTrackedRanges ? applied.collection.getRange(index) : item.range;
      if (!range) {
        continue;
      }
      const options = themedDecoration(decorationOptions(item.render), theme);
      decorations.push({
        range,
        options: {
          isWholeLine: styles.isWholeLine === true,
          className: styles.isWholeLine === true ? inline : undefined,
          inlineClassName: styles.isWholeLine === true ? undefined : inline,
          stickiness,
          glyphMarginClassName,
          overviewRuler: overviewColor ? { color: overviewColor, position: lane } : undefined,
          beforeContentClassName: attachment('before', decorationOptions(styles.before), decorationOptions(options.before)),
          afterContentClassName: attachment('after', decorationOptions(styles.after), decorationOptions(options.after)),
          hoverMessage: Array.isArray(item.hover) ? item.hover.filter(value => typeof value === 'string').map(value => ({
            value, isTrusted: false, supportHtml: false,
          })) : undefined,
        },
      });
    }
    applied.style.textContent = rules.join('\n');
    applied.collection.set(decorations);
  }

  private icon(type: Registered, value: unknown): string | undefined {
    try {
      const location = type.extension.location;
      const root = URI.parse(location.endsWith('/') ? location : location + '/', true);
      const resource = URI.isUri(value) ? value : typeof value === 'string'
        ? URI.parse(resolveExtensionPath(location, value)?.href ?? value, true) : undefined;
      if (!resource || resource.hasEncodedPathSeparator || forbiddenResourcePath.test(resource.path)) {
        return undefined;
      }
      const withinExtension = isEqualOrParent(resource, root) && !resource.path.split('/').includes('..')
        && !resource.query && !resource.fragment;
      if (!withinExtension && !this.workspace.getWorkspaceFolder(resource)) {
        return undefined;
      }
      const suffix = resource.path.split('.').at(-1)?.toLowerCase() ?? '';
      if (!Object.hasOwn(imageType, suffix)) {
        return undefined;
      }
      const key = resource.toString();
      if (!type.icons.has(key)) {
        type.icons.set(key, undefined);
        void this.files.readFile(resource, { limits: { size: iconLimit } }).then(({ value: bytes }) => {
          if (type.icons.has(key) && bytes.byteLength <= iconLimit) {
            const blob = new Blob([new Uint8Array(bytes)], { type: imageType[suffix] });
            type.icons.set(key, URL.createObjectURL(blob));
            this.refresh(type);
          }
        }, () => {});
      }
      return type.icons.get(key);
    } catch {
      return undefined;
    }
  }

  private removeType(key: string, type: Registered): void {
    this.types.delete(key);
    for (const applied of type.applied.values()) {
      applied.editor.decorations.delete(applied.dispose);
    }
    for (const url of type.icons.values()) {
      if (url) {
        URL.revokeObjectURL(url);
      }
    }
    type.icons.clear();
  }

  remove(extension: string): void {
    for (const [key, type] of this.types) {
      if (type.extension.key === extension) {
        this.removeType(key, type);
      }
    }
  }

  override dispose(): void {
    for (const [key, type] of this.types) {
      this.removeType(key, type);
    }
    super.dispose();
  }
}
