import type * as vscode from 'vscode';
import { Uri } from './extHostTypes.js';

type Argument = string | number | boolean;
type Arguments = Argument[] | Record<string, Argument>;
type Options = { message: string; args?: Arguments; comment: string | string[] };

export class ExtensionLocalization {
  private entries?: Record<string, string>;
  private location?: vscode.Uri;

  accept(bundle: { readonly json: string; readonly uri: string } | undefined): void {
    if (!bundle) {
      return;
    }
    this.entries = Object.freeze(JSON.parse(bundle.json));
    this.location = Uri.parse(bundle.uri);
  }

  api(): typeof vscode.l10n {
    const localization = this;
    return {
      get bundle() { return localization.entries; },
      get uri() { return localization.location; },
      t(message: string | Options, ...args: (Argument | Record<string, Argument>)[]) {
        const source = typeof message === 'string' ? message : message.message;
        const values = typeof message === 'string'
          ? (typeof args[0] === 'object' ? args[0] : args)
          : message.args;
        const comment = typeof message === 'string' ? '' : Array.isArray(message.comment) ? message.comment.join('') : message.comment;
        const key = comment ? source + '/' + comment : source;
        const translated = localization.entries && Object.hasOwn(localization.entries, key) ? localization.entries[key] : source;
        return values ? translated.replace(/\{([^{}]+)\}/g, (token, name: string) =>
          Object.hasOwn(values, name) ? String((values as Record<string, unknown>)[name]) : token) : translated;
      },
    };
  }
}
