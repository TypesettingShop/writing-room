import type * as vscode from 'vscode';
import { isJSONValue } from '../../../platform/configuration/common/configurationValues.js';

export class ExtHostMemento implements vscode.Memento {
  private state: Record<string, unknown> = {};

  constructor(
    private readonly checkLive: () => void,
    private readonly write: (key: string, json: string | undefined) => Promise<void>,
  ) {}

  accept(json: string): void {
    this.state = JSON.parse(json);
  }

  keys(): readonly string[] {
    this.checkLive();
    return Object.keys(this.state);
  }

  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    this.checkLive();
    return Object.hasOwn(this.state, key) ? structuredClone(this.state[key]) as T : defaultValue;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.checkLive();
    if (value !== undefined && !isJSONValue(value)) {
      throw new TypeError('Extension state must contain JSON data without functions or cycles.');
    }
    await this.write(key, value === undefined ? undefined : JSON.stringify(value));
  }
}
