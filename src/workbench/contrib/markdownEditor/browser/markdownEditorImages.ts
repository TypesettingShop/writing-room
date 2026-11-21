import type { Node } from 'prosemirror-model';
import { NodeSelection } from 'prosemirror-state';
import type { Command } from 'prosemirror-state';
import type { NodeView } from 'prosemirror-view';
import { dirname, extname, isEqualOrParent, joinPath } from '../../../../base/common/resources.js';
import type { URI } from '../../../../base/common/uri.js';
import type { IFileService } from '../../../../platform/files/common/files.js';
import type { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { normalizeMarkdownLink } from './markdownEditorInline.js';

type ImageSource = { url: string } | { resource: URI; mime: string } | { message: string };
const imageTypes: Readonly<Record<string, string>> = {
  '.avif': 'image/avif', '.bmp': 'image/bmp', '.gif': 'image/gif', '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp',
};

function imageSource(src: string, document: URI, workspace: IWorkspaceContextService): ImageSource {
  if (/^https:\/\//i.test(src)) {
    try {
      const url = new URL(src);
      if (url.protocol === 'https:' && !url.username && !url.password) return { url: url.href };
    } catch {
      // Fall through to the unsupported address message.
    }
  }
  if (/^http:/i.test(src)) return { message: 'HTTP image blocked' };
  if (/^data:image\/(?:gif|png|jpeg|webp);/i.test(src) && normalizeMarkdownLink(src) !== undefined) {
    return { url: src };
  }
  if (!src || /^(?:[a-z][a-z\d+.-]*:|[/\\])/i.test(src)) return { message: 'Unsupported image address' };
  const folder = workspace.getWorkspaceFolder(document);
  const path = src.split(/[?#]/, 1)[0];
  if (!path || /%2f|%5c/i.test(path)) return { message: 'Unsupported image path' };
  try {
    const relative = decodeURIComponent(path);
    if (/[\\\x00-\x1f]/.test(relative)) return { message: 'Unsupported image path' };
    const resource = joinPath(dirname(document), relative);
    if (!folder || !isEqualOrParent(resource, folder.uri)) return { message: 'Image is outside the workspace folder' };
    const mime = imageTypes[extname(resource).toLowerCase()];
    if (mime) return { resource, mime };
  } catch {
    return { message: 'Unsupported image path' };
  }
  return { message: 'Unsupported image format' };
}

export function markdownImageView(
  node: Node, document: Document, resource: URI, files: IFileService, workspace: IWorkspaceContextService,
): NodeView {
  const { src, alt, title } = node.attrs;
  const source = imageSource(src, resource, workspace);
  const dom = document.createElement('span');
  dom.className = 'markdown-image';
  dom.contentEditable = 'false';
  const abort = new AbortController();
  let objectUrl: string | undefined;
  let button: HTMLButtonElement | undefined;

  function fallback(message: string): void {
    const label = document.createElement('span');
    label.setAttribute('role', 'img');
    label.setAttribute('aria-label', alt || 'Image');
    label.textContent = alt || 'Image';
    dom.replaceChildren(label, document.createTextNode(` (${message})`));
  }

  function show(url: string): void {
    const image = document.createElement('img');
    image.alt = alt ?? '';
    if (title) image.title = title;
    image.referrerPolicy = 'no-referrer';
    image.addEventListener('error', () => fallback('Image could not be loaded'), { once: true });
    image.src = url;
    dom.replaceChildren(image);
  }

  if ('message' in source) {
    fallback(source.message);
  } else if ('resource' in source) {
    fallback('Loading image');
    void files.readFile(source.resource, { signal: abort.signal, limits: { size: 16 * 1024 * 1024 } }).then(({ value }) => {
      if (!abort.signal.aborted) {
        objectUrl = URL.createObjectURL(new Blob([new Uint8Array(value)], { type: source.mime }));
        show(objectUrl);
      }
    }).catch(() => {
      if (!abort.signal.aborted) fallback('Workspace image could not be loaded');
    });
  } else if (source.url.startsWith('data:')) {
    show(source.url);
  } else {
    fallback('Remote image');
    button = dom.appendChild(document.createElement('button'));
    button.type = 'button';
    button.textContent = 'Load image';
    button.title = source.url;
    button.addEventListener('click', () => show(source.url), { once: true });
  }

  return {
    dom,
    stopEvent: event => !!button && event.target === button,
    ignoreMutation: mutation => mutation.type !== 'selection',
    destroy: () => {
      abort.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    },
  };
}

export function selectedMarkdownImage(selection: CommandSelection): Node | undefined {
  return selection instanceof NodeSelection && selection.node.type.name === 'image' ? selection.node : undefined;
}

type CommandSelection = Parameters<Command>[0]['selection'];

export function setMarkdownImage(address: string, alt: string): Command {
  const src = normalizeMarkdownLink(address);
  return (state, dispatch) => {
    if (!src || state.selection.$from.parent.type.spec.code) return false;
    const existing = selectedMarkdownImage(state.selection);
    const type = state.schema.nodes.image;
    const node = type.create({ ...existing?.attrs, src, alt });
    const tr = state.tr.replaceSelectionWith(node);
    if (!tr.docChanged) return false;
    dispatch?.(tr.scrollIntoView());
    return true;
  };
}
