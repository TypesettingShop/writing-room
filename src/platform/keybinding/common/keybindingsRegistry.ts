import { Emitter } from '../../../base/common/event.js';
import { combinedDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import { CommandsRegistry } from '../../commands/common/commands.js';
import type { ICommandHandler } from '../../commands/common/commands.js';
import type { ContextKeyExpression } from '../../contextkey/common/contextkey.js';

export enum KeybindingWeight {
  EditorCore = 0,
  EditorContrib = 100,
  WorkbenchContrib = 200,
  BuiltinExtension = 300,
  ExternalExtension = 400,
}

export type KeybindingSpec = number | string;

export interface IKeybindings {
  readonly primary?: KeybindingSpec;
  readonly secondary?: readonly KeybindingSpec[];
  readonly key?: string;
}

export interface IKeybindingRule extends IKeybindings {
  readonly id: string;
  readonly weight: number;
  readonly when?: ContextKeyExpression;
  readonly args?: unknown;
  readonly mac?: IKeybindings;
  readonly win?: IKeybindings;
  readonly linux?: IKeybindings;
}

class KeybindingsRegistryImpl {
  private readonly rules = new Set<IKeybindingRule>();
  private readonly changed = new Emitter<void>();
  readonly onDidChange = this.changed.event;

  registerKeybindingRule(rule: IKeybindingRule): IDisposable {
    const entry = { ...rule };
    this.rules.add(entry);
    this.changed.fire();
    return toDisposable(() => {
      this.rules.delete(entry);
      this.changed.fire();
    });
  }

  registerCommandAndKeybindingRule(rule: IKeybindingRule & { handler: ICommandHandler }): IDisposable {
    return combinedDisposable(CommandsRegistry.registerCommand(rule.id, rule.handler), this.registerKeybindingRule(rule));
  }

  getDefaultKeybindings(): IKeybindingRule[] {
    return [...this.rules].sort((a, b) => a.weight - b.weight || (a.id < b.id ? -1 : Number(a.id > b.id)));
  }
}

export const KeybindingsRegistry = new KeybindingsRegistryImpl();
