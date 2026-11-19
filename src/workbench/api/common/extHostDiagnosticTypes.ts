import type * as vscode from 'vscode';
import { URI } from '../../../base/common/uri.js';
import { MarkerSeverity, MarkerTag } from '../../../platform/markers/common/markers.js';
import type { IRelatedInformation } from '../../../platform/markers/common/markers.js';
import type { MarkerDataDto } from './extHost.protocol.diagnostics.js';
import { Location, Range } from './extHostEditorTypes.js';
import { rangeFromEditor, rangeToEditor } from './extHostTypeConverters.js';

export enum DiagnosticSeverity {
  Error = 0,
  Warning = 1,
  Information = 2,
  Hint = 3,
}

export enum DiagnosticTag {
  Unnecessary = 1,
  Deprecated = 2,
}

function isPosition(value: unknown): value is vscode.Position {
  return typeof value === 'object' && value !== null
    && typeof (value as vscode.Position).line === 'number' && typeof (value as vscode.Position).character === 'number';
}

/** A `Range`, or what has its shape (VS Code's `Range.isRange`). */
export function isRange(value: unknown): value is vscode.Range {
  return value instanceof Range || (typeof value === 'object' && value !== null
    && isPosition((value as vscode.Range).start) && isPosition((value as vscode.Range).end));
}

export class DiagnosticRelatedInformation implements vscode.DiagnosticRelatedInformation {
  constructor(public location: vscode.Location, public message: string) {}
}

export class Diagnostic implements vscode.Diagnostic {
  range: vscode.Range;
  message: string;
  severity: DiagnosticSeverity;
  source?: string;
  code?: string | number | { value: string | number; target: vscode.Uri };
  relatedInformation?: vscode.DiagnosticRelatedInformation[];
  tags?: DiagnosticTag[];

  constructor(range: vscode.Range, message: string, severity: DiagnosticSeverity = DiagnosticSeverity.Error) {
    if (!isRange(range)) {
      throw new TypeError('range must be set');
    }
    if (!message) {
      throw new TypeError('message must be set');
    }
    this.range = range;
    this.message = message;
    this.severity = severity;
  }

  toJSON(): unknown {
    return {
      severity: DiagnosticSeverity[this.severity],
      message: this.message,
      range: this.range,
      source: this.source,
      code: this.code,
    };
  }
}

const toMarkerSeverity: Readonly<Record<number, MarkerSeverity>> = {
  [DiagnosticSeverity.Error]: MarkerSeverity.Error,
  [DiagnosticSeverity.Warning]: MarkerSeverity.Warning,
  [DiagnosticSeverity.Information]: MarkerSeverity.Info,
  [DiagnosticSeverity.Hint]: MarkerSeverity.Hint,
};

const fromMarkerSeverity: Readonly<Record<number, DiagnosticSeverity>> = {
  [MarkerSeverity.Error]: DiagnosticSeverity.Error,
  [MarkerSeverity.Warning]: DiagnosticSeverity.Warning,
  [MarkerSeverity.Info]: DiagnosticSeverity.Information,
  [MarkerSeverity.Hint]: DiagnosticSeverity.Hint,
};

/** The marker severity of an API severity. Anything else is an error, as in VS Code. */
export function markerSeverity(severity: unknown): MarkerSeverity {
  return typeof severity === 'number' ? toMarkerSeverity[severity] ?? MarkerSeverity.Error : MarkerSeverity.Error;
}

function relatedInformation(value: vscode.DiagnosticRelatedInformation): IRelatedInformation {
  return { resource: value.location.uri as unknown as URI, message: value.message, ...rangeToEditor(value.location.range) };
}

/** A diagnostic as the workbench takes it. */
export function toMarkerData(diagnostic: vscode.Diagnostic): MarkerDataDto {
  let code: MarkerDataDto['code'];
  const value = diagnostic.code;
  // As in VS Code, an empty string or 0 is no code.
  if (typeof value === 'string' || typeof value === 'number') {
    code = value ? String(value) : undefined;
  } else if (value && typeof value === 'object') {
    code = { value: String(value.value), target: value.target as unknown as URI };
  }
  // 0-based API positions to 1-based marker lines and columns. The workbench checks them again.
  return {
    ...rangeToEditor(diagnostic.range),
    message: diagnostic.message,
    source: diagnostic.source,
    code,
    severity: markerSeverity(diagnostic.severity),
    relatedInformation: diagnostic.relatedInformation?.map(relatedInformation),
    tags: Array.isArray(diagnostic.tags)
      ? (diagnostic.tags as number[]).filter((tag): tag is MarkerTag => tag === MarkerTag.Unnecessary || tag === MarkerTag.Deprecated)
      : undefined,
  };
}

/** A marker the workbench sent back as a diagnostic, for `getDiagnostics`. Its lines and columns are at least 1. */
export function fromMarkerData(data: MarkerDataDto): Diagnostic {
  const diagnostic = new Diagnostic(rangeFromEditor(data), data.message, fromMarkerSeverity[data.severity] ?? DiagnosticSeverity.Error);
  if (data.source) {
    diagnostic.source = data.source;
  }
  if (typeof data.code === 'string') {
    diagnostic.code = data.code;
  } else if (data.code) {
    diagnostic.code = { value: data.code.value, target: URI.revive(data.code.target) as unknown as vscode.Uri };
  }
  if (data.relatedInformation) {
    diagnostic.relatedInformation = data.relatedInformation.map(item => new DiagnosticRelatedInformation(
      new Location(URI.revive(item.resource) as unknown as vscode.Uri, rangeFromEditor(item)), item.message));
  }
  if (data.tags?.length) {
    diagnostic.tags = data.tags.map(tag => tag as number as DiagnosticTag);
  }
  return diagnostic;
}
