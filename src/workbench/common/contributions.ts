import { Emitter } from '../../base/common/event.js';
import type { IDisposable } from '../../base/common/lifecycle.js';
import { toDisposable } from '../../base/common/lifecycle.js';
import { Registry } from '../../platform/registry/common/platform.js';

export const Extensions = { Workbench: 'workbench.contributions.kind' };

export type WorkbenchContribution = new (...args: any[]) => IDisposable | object;

class WorkbenchContributionsRegistry {
  private readonly entries = new Map<string, WorkbenchContribution>();
  private readonly didRegister = new Emitter<[string, WorkbenchContribution]>();
  /** Fires for each registration, so a workbench that has already started can start a late one. */
  readonly onDidRegister = this.didRegister.event;

  register(id: string, contribution: WorkbenchContribution): IDisposable {
    if (this.entries.has(id)) {
      throw new Error(`Workbench contribution ${id} is already registered.`);
    }
    this.entries.set(id, contribution);
    this.didRegister.fire([id, contribution]);
    return toDisposable(() => this.entries.delete(id));
  }

  getContributions(): [string, WorkbenchContribution][] {
    return [...this.entries];
  }
}

export const workbenchContributions = new WorkbenchContributionsRegistry();
Registry.add(Extensions.Workbench, workbenchContributions);

export function registerWorkbenchContribution2(id: string, contribution: WorkbenchContribution): IDisposable {
  return workbenchContributions.register(id, contribution);
}
