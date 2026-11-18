import { Emitter } from '../../../base/common/event.js';
import { formatKeybinding } from '../../../base/common/keybindingLabels.js';
import type { KeybindingPlatform, KeyCodeChord } from '../../../base/common/keybindings.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import type { ICommandService } from '../../commands/common/commands.js';
import type { IContext } from '../../contextkey/common/contextkey.js';
import { KeybindingResolver, ResultKind } from './keybindingResolver.js';
import type { IKeybindingService, ResolvedKeybinding } from './keybinding.js';
import { KeybindingsRegistry } from './keybindingsRegistry.js';

export abstract class AbstractKeybindingService extends Disposable implements IKeybindingService {
  declare readonly _serviceBrand: undefined;
  private readonly updated = this._register(new Emitter<void>());
  readonly onDidUpdateKeybindings = this.updated.event;
  private resolver: KeybindingResolver | undefined;
  private pending: KeyCodeChord | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly commandService: ICommandService,
    private readonly platform: KeybindingPlatform,
  ) {
    super();
    this._register(KeybindingsRegistry.onDidChange(() => {
      this.resolver = undefined;
      this.cancelChord();
      this.updated.fire();
    }));
  }

  lookupKeybinding(commandId: string): ResolvedKeybinding | undefined {
    const binding = this.getResolver().lookupKeybinding(commandId);
    return binding && {
      getLabel: () => formatKeybinding(binding, this.platform),
      getAriaLabel: () => formatKeybinding(binding, this.platform, true),
    };
  }

  protected get inChordMode(): boolean {
    return this.pending !== undefined;
  }

  protected dispatch(chord: KeyCodeChord, context: IContext): boolean {
    const pending = this.pending;
    this.cancelChord();
    const match = this.getResolver().resolve(context, pending ?? chord, pending ? chord : undefined);
    if (match.kind === ResultKind.MoreChordsNeeded) {
      this.pending = chord;
      this.timer = setTimeout(() => this.cancelChord(), 5000);
      return true;
    }
    if (match.kind === ResultKind.KbFound) {
      const { id, args } = match.rule;
      void this.runCommand(id, args);
      return true;
    }
    return pending !== undefined;
  }

  protected cancelChord(): void {
    this.pending = undefined;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private getResolver(): KeybindingResolver {
    return this.resolver ??= new KeybindingResolver(KeybindingsRegistry.getDefaultKeybindings(), this.platform);
  }

  private async runCommand(id: string, args: unknown): Promise<void> {
    try {
      await this.commandService.executeCommand(id, ...(args === undefined ? [] : [args]));
    } catch (error) {
      console.error(error);
    }
  }

  override dispose(): void {
    this.cancelChord();
    super.dispose();
  }
}
