declare module 'vscode' {
  export interface DiagnosticChangeEvent {
    readonly uris: readonly Uri[];
  }

  export enum DiagnosticSeverity {
    Error = 0,
    Warning = 1,
    Information = 2,
    Hint = 3
  }

  export class DiagnosticRelatedInformation {
    location: Location;
    message: string;
    constructor(location: Location, message: string);
  }

  export enum DiagnosticTag {
    Unnecessary = 1,
    Deprecated = 2,
  }

  export class Diagnostic {
    range: Range;
    message: string;
    severity: DiagnosticSeverity;
    source?: string;
    code?: string | number | {
      value: string | number;
      target: Uri;
    };
    relatedInformation?: DiagnosticRelatedInformation[];
    tags?: DiagnosticTag[];
    constructor(range: Range, message: string, severity?: DiagnosticSeverity);
  }

  export interface DiagnosticCollection extends Iterable<[uri: Uri, diagnostics: readonly Diagnostic[]]> {
    readonly name: string;
    set(uri: Uri, diagnostics: readonly Diagnostic[] | undefined): void;
    set(entries: ReadonlyArray<[Uri, readonly Diagnostic[] | undefined]>): void;
    delete(uri: Uri): void;
    clear(): void;
    forEach(callback: (uri: Uri, diagnostics: readonly Diagnostic[], collection: DiagnosticCollection) => any, thisArg?: any): void;
    get(uri: Uri): readonly Diagnostic[] | undefined;
    has(uri: Uri): boolean;
    dispose(): void;
  }

  export namespace languages {
    export const onDidChangeDiagnostics: Event<DiagnosticChangeEvent>;
    export function getDiagnostics(resource: Uri): Diagnostic[];
    export function getDiagnostics(): [Uri, Diagnostic[]][];
    export function createDiagnosticCollection(name?: string): DiagnosticCollection;
  }
}
