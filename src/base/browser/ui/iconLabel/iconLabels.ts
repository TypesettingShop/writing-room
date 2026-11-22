import codiconNames from 'virtual:codicon-names';
import { ThemeIcon } from '../../../common/themables.js';
import './iconLabels.css';

const knownIcons = new Set([...codiconNames, 'underline']);
const iconInLabel = new RegExp('(\\\\)?\\$\\((' + ThemeIcon.iconIdExpression + ')\\)', 'g');

export function renderIcon(icon: ThemeIcon): HTMLSpanElement | undefined {
  if (!knownIcons.has(icon.id.split('~')[0])) {
    return undefined;
  }
  const node = document.createElement('span');
  node.className = ThemeIcon.asClassName(icon);
  node.setAttribute('aria-hidden', 'true');
  return node;
}

export function renderLabelWithIcons(text: string): (HTMLSpanElement | string)[] {
  const parts: (HTMLSpanElement | string)[] = [];
  let offset = 0;
  for (const match of text.matchAll(iconInLabel)) {
    const [token, escaped, id] = match;
    if (match.index > offset) {
      parts.push(text.slice(offset, match.index));
    }
    if (escaped) {
      parts.push(token.slice(1));
    } else {
      const icon = renderIcon({ id });
      if (icon) {
        parts.push(icon);
      }
    }
    offset = match.index + token.length;
  }
  if (offset < text.length) {
    parts.push(text.slice(offset));
  }
  return parts;
}
