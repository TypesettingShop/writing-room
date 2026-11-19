import { decodeKeybinding } from '../../../base/common/keybindings.js';
import type { Keybinding, KeybindingPlatform, KeyCodeChord } from '../../../base/common/keybindings.js';
import { parseKeybinding } from '../../../base/common/keybindingParser.js';
import type { IContext } from '../../contextkey/common/contextkey.js';
import type { IKeybindingRule } from './keybindingsRegistry.js';

export interface ResolvedKeybindingRule {
  readonly rule: IKeybindingRule;
  readonly binding: Keybinding;
}

export enum ResultKind {
  NoMatchingKb,
  MoreChordsNeeded,
  KbFound,
}

type Resolution = { kind: ResultKind.NoMatchingKb | ResultKind.MoreChordsNeeded }
  | { kind: ResultKind.KbFound; rule: IKeybindingRule };

export class KeybindingResolver {
  private readonly rules: ResolvedKeybindingRule[] = [];
  private readonly lookup = new Map<string, Keybinding>();

  // Registrations arrive ordered by increasing weight, id and registration order.
  constructor(rules: readonly IKeybindingRule[], platform: KeybindingPlatform) {
    for (const rule of rules) {
      const effective = rule[platform] ?? rule;
      const primary = effective.primary ?? effective.key;
      // When the same rule has several bindings, lookup prefers its primary key.
      for (const spec of [...[...(effective.secondary ?? [])].reverse(), primary]) {
        if (spec === undefined || spec === 0) {
          continue;
        }
        const binding = typeof spec === 'number' ? decodeKeybinding(spec, platform) : parseKeybinding(spec);
        if (binding) {
          this.rules.push({ rule, binding });
        } else {
          console.error(`Invalid keybinding for '${rule.id}': ${spec}`);
        }
      }
    }
    this.rules.reverse();
    for (const { rule, binding } of this.rules) {
      if (!this.lookup.has(rule.id)) {
        this.lookup.set(rule.id, binding);
      }
    }
  }

  resolve(context: IContext, first: KeyCodeChord, second?: KeyCodeChord): Resolution {
    const match = this.rules.find(({ binding, rule }) => {
      const [head, tail] = binding.chords;
      return first.equals(head) && (!second || (tail !== undefined && second.equals(tail)))
        && (rule.when?.evaluate(context) ?? true);
    });
    if (!match) {
      return { kind: ResultKind.NoMatchingKb };
    }
    if (match.binding.chords.length > 1 && !second) {
      return { kind: ResultKind.MoreChordsNeeded };
    }
    return { kind: ResultKind.KbFound, rule: match.rule };
  }

  lookupKeybinding(id: string): Keybinding | undefined {
    return this.lookup.get(id);
  }
}
