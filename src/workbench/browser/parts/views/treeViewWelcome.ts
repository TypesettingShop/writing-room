import type { ContextKeyExpression } from '../../../../platform/contextkey/common/contextkey.js';
import { ContributionSlot } from '../../../services/language/common/languageService.js';

/** One `contributes.viewsWelcome` entry. */
export interface IViewWelcomeContent {
  readonly view: string;
  readonly contents: string;
  readonly when?: ContextKeyExpression;
  readonly enablement?: ContextKeyExpression;
  /** The commands the contributing extension declares: the only ones its links may run. */
  readonly commands: readonly string[];
}

export const viewWelcomeContributions = new ContributionSlot<IViewWelcomeContent>();

/** A piece of a welcome line: plain text, or a link with its label and target as written. */
export type WelcomePart = { readonly text: string } | { readonly label: string; readonly target: string };

const link = /\[([^\]]*)\]\(([^)\s]+)\)/g;

/** Splits a welcome line into text and `[label](target)` links. Nothing in it is read as HTML. */
export function parseWelcomeLine(line: string): WelcomePart[] {
  const parts: WelcomePart[] = [];
  let start = 0;
  for (const match of line.matchAll(link)) {
    if (match.index > start) {
      parts.push({ text: line.slice(start, match.index) });
    }
    parts.push({ label: match[1], target: match[2] });
    start = match.index + match[0].length;
  }
  if (start < line.length) {
    parts.push({ text: line.slice(start) });
  }
  return parts;
}

/**
 * What a welcome link does: run a command the extension declared, with no arguments; open a web
 * address after the user agrees; or nothing, when it is shown as text.
 */
export function welcomeLinkTarget(target: string, commands: readonly string[]): { readonly command: string } | { readonly url: string } | undefined {
  const command = /^command:([^?#]+)$/.exec(target);
  if (command) {
    return commands.includes(command[1]) ? { command: command[1] } : undefined;
  }
  return /^https?:\/\/[^\s]+$/i.test(target) ? { url: target } : undefined;
}
