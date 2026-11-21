import { $, append } from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import { extname } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import type { IFileService } from '../../../../platform/files/common/files.js';
import { asCssVariableName, ColorScheme } from '../../../../platform/theme/common/themeService.js';
import type { IThemeService } from '../../../../platform/theme/common/themeService.js';
import type { EditorInput, TabIcon } from '../../../common/editor/editorInput.js';
import { extensionResourceLimits } from '../../../services/extensions/common/extensionResources.js';

const imageTypes: Readonly<Record<string, string>> = {
  '.avif': 'image/avif', '.bmp': 'image/bmp', '.gif': 'image/gif', '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp',
};

/** Inputs may hand out a new object for the same icon, so the tab compares what the icon shows. */
function iconKey(source: Exclude<TabIcon, { readonly light: URI }> | undefined): string | undefined {
  if (!source) {
    return undefined;
  }
  return URI.isUri(source) ? 'uri:' + source.toString() : 'icon:' + JSON.stringify([source.id, source.color?.id]);
}

/** The tab owns its image request and object URL for as long as it displays the icon. */
export class EditorTabIcon extends Disposable {
  private readonly element: HTMLElement;
  private readonly image = this._register(new MutableDisposable<IDisposable>());
  private current?: string;

  constructor(
    label: HTMLElement, private readonly editor: EditorInput, private readonly files: IFileService,
    private readonly themes: IThemeService,
  ) {
    super();
    this.element = append(label, $('span.tab-icon', { 'aria-hidden': 'true', hidden: '' }));
    if (editor.onDidChangeTabIcon) {
      this._register(editor.onDidChangeTabIcon(() => this.update()));
    }
    this._register(themes.onDidColorThemeChange(() => this.update()));
    this.update();
  }

  private update(): void {
    const icon = this.editor.getTabIcon();
    const scheme = this.themes.getColorTheme().type;
    const light = scheme === ColorScheme.LIGHT || scheme === ColorScheme.HIGH_CONTRAST_LIGHT;
    const source = icon && 'light' in icon ? (light ? icon.light : icon.dark) : icon;
    const key = iconKey(source);
    if (key === this.current) {
      return;
    }
    this.current = key;
    this.image.clear();
    this.element.replaceChildren();
    this.element.hidden = true;
    if (URI.isUri(source)) {
      void this.load(source);
    } else if (source) {
      const node = renderIcon(source);
      if (node) {
        if (source.color) {
          node.style.color = `var(${asCssVariableName(source.color.id)})`;
        }
        this.element.append(node);
        this.element.hidden = false;
      }
    }
  }

  private async load(resource: URI): Promise<void> {
    const type = imageTypes[extname(resource).toLowerCase()];
    if (!type) {
      return;
    }
    const controller = new AbortController();
    const img = this.element.ownerDocument.createElement('img');
    let url: string | undefined;
    this.image.value = toDisposable(() => {
      controller.abort();
      img.onerror = null;
      if (url) {
        URL.revokeObjectURL(url);
      }
    });

    try {
      const { value } = await this.files.readFile(resource, { limits: { size: extensionResourceLimits.icon }, signal: controller.signal });
      if (controller.signal.aborted) {
        return;
      }
      url = URL.createObjectURL(new Blob([new Uint8Array(value)], { type }));
      img.alt = '';
      img.draggable = false;
      img.onerror = () => {
        this.image.clear();
        this.element.replaceChildren();
        this.element.hidden = true;
      };
      img.src = url;
      this.element.append(img);
      this.element.hidden = false;
    } catch {
      // The label is still usable if the file cannot be read as an image.
      if (!controller.signal.aborted) {
        this.image.clear();
      }
    }
  }
}
