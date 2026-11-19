import type * as vscode from 'vscode';
import { promiseApiMethod } from './extHostApiRegistry.js';
import { Disposable } from './extHostTypes.js';

class TaskGroup {
  static Clean = new TaskGroup('clean');
  static Build = new TaskGroup('build');
  static Rebuild = new TaskGroup('rebuild');
  static Test = new TaskGroup('test');
  readonly isDefault = undefined;

  private constructor(readonly id: string) {}
}

class ProcessExecution {
  args: string[];
  options?: vscode.ProcessExecutionOptions;

  constructor(public process: string, argsOrOptions?: string[] | vscode.ProcessExecutionOptions, options?: vscode.ProcessExecutionOptions) {
    this.args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
    this.options = Array.isArray(argsOrOptions) ? options : argsOrOptions;
  }
}

class ShellExecution {
  commandLine?: string;
  command?: string | vscode.ShellQuotedString;
  args?: Array<string | vscode.ShellQuotedString>;
  options?: vscode.ShellExecutionOptions;

  constructor(
    command: string | vscode.ShellQuotedString,
    argsOrOptions?: Array<string | vscode.ShellQuotedString> | vscode.ShellExecutionOptions,
    options?: vscode.ShellExecutionOptions,
  ) {
    if (Array.isArray(argsOrOptions)) {
      this.command = command;
      this.args = argsOrOptions;
      this.options = options;
    } else {
      this.commandLine = typeof command === 'string' ? command : command.value;
      this.options = argsOrOptions;
    }
  }
}

class CustomExecution {
  // The callback is accepted for compatibility. There is no terminal to invoke it.
  constructor(_callback: (definition: vscode.TaskDefinition) => Thenable<vscode.Pseudoterminal>) {}
}

class Task implements vscode.Task {
  readonly scope: vscode.Task['scope'];
  name: string;
  source: string;
  execution?: vscode.Task['execution'];
  detail?: string;
  group?: vscode.TaskGroup;
  isBackground = false;
  presentationOptions: vscode.TaskPresentationOptions = {};
  problemMatchers: string[];
  runOptions: vscode.RunOptions = {};

  constructor(
    public definition: vscode.TaskDefinition, scopeOrName: NonNullable<vscode.Task['scope']> | string,
    nameOrSource: string, sourceOrExecution?: string | vscode.Task['execution'],
    executionOrMatchers?: vscode.Task['execution'] | string | string[], problemMatchers?: string | string[],
  ) {
    if (typeof scopeOrName === 'string') {
      this.name = scopeOrName;
      this.source = nameOrSource;
      this.execution = sourceOrExecution as vscode.Task['execution'];
      problemMatchers = executionOrMatchers as string | string[] | undefined;
    } else {
      this.scope = scopeOrName;
      this.name = nameOrSource;
      this.source = sourceOrExecution as string;
      this.execution = executionOrMatchers as vscode.Task['execution'];
    }
    this.problemMatchers = typeof problemMatchers === 'string' ? [problemMatchers] : [...problemMatchers ?? []];
  }
}

export function compatibilityFragments(noEvent: () => vscode.Disposable) {
  return {
    types: {
      Task, TaskGroup, CustomExecution, ProcessExecution, ShellExecution,
      TaskScope: Object.freeze({ Global: 1, Workspace: 2 }),
      TaskRevealKind: Object.freeze({ Always: 1, Silent: 2, Never: 3 }),
      TaskPanelKind: Object.freeze({ Shared: 1, Dedicated: 2, New: 3 }),
      ShellQuoting: Object.freeze({ Escape: 1, Strong: 2, Weak: 3 }),
      NotebookCellKind: Object.freeze({ Markup: 1, Code: 2 }),
    },
    tasks: {
      registerTaskProvider: () => new Disposable(() => {}),
      fetchTasks: promiseApiMethod(async () => []),
      executeTask: promiseApiMethod(async () => { throw new Error('Task execution is not supported.'); }),
      taskExecutions: Object.freeze([]),
      onDidStartTask: noEvent, onDidEndTask: noEvent, onDidStartTaskProcess: noEvent, onDidEndTaskProcess: noEvent,
    } satisfies typeof vscode.tasks,
    workspace: {
      notebookDocuments: Object.freeze([]),
      onDidChangeNotebookDocument: noEvent, onDidSaveNotebookDocument: noEvent,
      onDidOpenNotebookDocument: noEvent, onDidCloseNotebookDocument: noEvent,
    },
  };
}
