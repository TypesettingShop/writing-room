import type { IDisposable } from '../../base/common/lifecycle.js';

/**
 * The part of a text model the workbench reads outside the editor control. Monaco's text models have
 * this shape; tests implement it without Monaco.
 */
export interface ITextModel {
  /** Prints as the resource the model was created for. */
  readonly uri: { toString(): string };
  getValue(): string;
  getValueLength(): number;
  setValue(value: string): void;
  onDidChangeContent(listener: (event: unknown) => void): IDisposable;
  isDisposed(): boolean;
  dispose(): void;
}
