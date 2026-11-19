// @vitest-environment node
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, test } from 'vitest';
import { createTestExtensionApi } from '../../workbench/api/test/common/testExtensionHost.js';

const upstreamFile = new URL('../../../test/fixtures/vscode-api/vscode.d.ts', import.meta.url);
const declarationsDirectory = fileURLToPath(new URL('../', import.meta.url));
const deviationsFile = new URL('./apiDeviations.json', import.meta.url);
const microsoftSha256 = '1100202846278445e33f466d04d98378408da78cb9a4ec0c941ccecba75b769a';

type Source = { readonly file: string; readonly text: string };
type RuntimeKind = 'object' | 'function' | 'value' | 'namespace';

interface Signature {
  readonly name: string;
  readonly kind: string;
  readonly value: string;
  readonly location: string;
  readonly scope?: string;
  readonly runtime?: RuntimeKind;
}
type Api = ReadonlyMap<string, Signature[]>;

const printer = ts.createPrinter({ removeComments: true });

function fingerprint(node: ts.Node, source: ts.SourceFile): string {
  const printed = printer.printNode(ts.EmitHint.Unspecified, node, source);
  const scan = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, printed);
  const tokens: string[] = [];
  let kind = scan.scan();
  while (kind === ts.SyntaxKind.ExportKeyword || kind === ts.SyntaxKind.DeclareKeyword) {
    kind = scan.scan();
  }
  for (; kind !== ts.SyntaxKind.EndOfFileToken; kind = scan.scan()) {
    tokens.push(scan.getTokenText());
  }
  if (tokens.at(-1) === ';') {
    tokens.pop();
  }
  return tokens.join(' ');
}

function collectApi(sources: readonly Source[]): Api {
  const api = new Map<string, Signature[]>();
  for (const { file, text } of sources) {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    function add(name: string, node: ts.Node, value: string, scope?: string, runtime?: RuntimeKind): void {
      const signatures = api.get(name) ?? [];
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      const kind = ts.isMethodDeclaration(node) || ts.isMethodSignature(node) ? 'Method'
        : ts.isPropertyDeclaration(node) || ts.isPropertySignature(node) ? 'Property' : ts.SyntaxKind[node.kind];
      signatures.push({ name, kind, value, location: file + ':' + (line + 1), scope, runtime });
      api.set(name, signatures);
    }
    function read(statements: ts.NodeArray<ts.Statement>, scope: string): void {
      for (const statement of statements) {
        if (ts.isModuleDeclaration(statement)) {
          if (statement.body && ts.isModuleBlock(statement.body)) {
            const namespace = scope === 'global' && ts.isStringLiteral(statement.name) && statement.name.text === 'vscode'
              ? 'vscode' : scope + '.' + statement.name.text;
            if (namespace !== 'vscode') {
              add(namespace, statement, 'namespace', scope, 'namespace');
            }
            read(statement.body.statements, namespace);
          }
        } else if (ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement)) {
          const name = scope + '.' + statement.name?.text;
          const parameters = statement.typeParameters?.map(parameter => fingerprint(parameter, source)).join(',') ?? '';
          add(name, statement, parameters, scope, ts.isClassDeclaration(statement) ? 'function' : undefined);
          for (const member of statement.members) {
            const memberName = member.name?.getText(source) ?? (ts.isConstructorDeclaration(member) ? 'constructor'
              : ts.isIndexSignatureDeclaration(member) ? '[index]' : '(call)');
            add(name + '#' + memberName, member, fingerprint(member, source));
          }
        } else if (ts.isEnumDeclaration(statement)) {
          const name = scope + '.' + statement.name.text;
          add(name, statement, '', scope, 'object');
          let nextValue: number | undefined = 0;
          for (const member of statement.members) {
            let value: string = String(nextValue);
            if (member.initializer) {
              value = fingerprint(member.initializer, source);
              const numerical = value.replaceAll(' ', '');
              nextValue = /^-?\d+$/.test(numerical) ? Number(numerical) : undefined;
              if (nextValue !== undefined) {
                value = String(nextValue);
              }
            }
            if (nextValue !== undefined) {
              nextValue++;
            }
            add(name + '#' + member.name.getText(source), member, value);
          }
        } else if (ts.isVariableStatement(statement)) {
          for (const variable of statement.declarationList.declarations) {
            const flags = statement.declarationList.flags;
            const declarationKind = flags & ts.NodeFlags.Const ? 'const ' : flags & ts.NodeFlags.Let ? 'let ' : 'var ';
            add(scope + '.' + variable.name.getText(source), variable, declarationKind + fingerprint(variable, source), scope, 'value');
          }
        } else if ((ts.isFunctionDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) && statement.name) {
          add(scope + '.' + statement.name.text, statement, fingerprint(statement, source), scope,
            ts.isFunctionDeclaration(statement) ? 'function' : undefined);
        }
      }
    }
    read(source.statements, 'global');
  }
  return api;
}

type ProblemKind = 'missing' | 'kind' | 'signature';
interface Problem { readonly name: string; readonly kind: ProblemKind; readonly message: string }
interface Deviation {
  readonly name: string;
  readonly kind: ProblemKind;
  readonly issue: string;
  readonly reason: string;
}

function compareDeclarations(local: Api, upstream: Api): Problem[] {
  const problems: Problem[] = [];
  for (const [name, signatures] of local) {
    const expected = upstream.get(name) ?? [];
    const classExists = signatures.some(signature => signature.kind === 'ClassDeclaration');
    for (const { kind, value, location } of signatures) {
      // An interface declaration may augment the corresponding class's instance members.
      const sameKind = expected.filter(signature => signature.kind === kind
        || (kind === 'InterfaceDeclaration' && classExists && signature.kind === 'ClassDeclaration'));
      const problem = expected.length === 0 ? 'missing' : sameKind.length === 0 ? 'kind'
        : sameKind.some(signature => signature.value === value) ? undefined : 'signature';
      if (problem) {
        const detail = problem === 'missing' ? 'is absent upstream' : problem === 'kind' ? 'has a different declaration kind'
          : 'has a different signature: ' + value;
        problems.push({ name, kind: problem, message: location + ' ' + name + ' ' + detail });
      }
    }
  }
  return problems;
}

function checkDeviations(problems: readonly Problem[], deviations: readonly Deviation[]): string[] {
  const errors: string[] = [];
  const allowed = new Map<string, Deviation>();
  const used = new Set<string>();
  for (const item of deviations) {
    const key = item.name + ':' + item.kind;
    if (typeof item.name !== 'string' || !item.name || !['missing', 'kind', 'signature'].includes(item.kind)
      || !/^wr-[a-z\d]+(?:\.[a-z\d]+)?$/.test(item.issue) || typeof item.reason !== 'string' || !item.reason.trim()) {
      errors.push('Invalid API deviation ' + key + ': a decision issue and reason are required');
      continue;
    }
    if (allowed.has(key)) {
      errors.push('Duplicate API deviation ' + key);
    }
    allowed.set(key, item);
  }
  for (const problem of problems) {
    const key = problem.name + ':' + problem.kind;
    if (allowed.has(key)) {
      used.add(key);
    } else {
      errors.push(problem.message);
    }
  }
  for (const [key, { issue }] of allowed) {
    if (!used.has(key)) {
      errors.push('Unused API deviation ' + key + ' (' + issue + ')');
    }
  }
  return errors;
}

function checkRuntime(local: Api, runtime: unknown): string[] {
  const errors: string[] = [];
  function visit(scope: string, value: unknown): void {
    const entries = new Map<string, Signature>();
    for (const signatures of local.values()) {
      const signature = signatures.find(signature => signature.scope === scope && signature.runtime);
      if (signature && (signature.runtime !== 'namespace' || [...local.values()].some(list =>
        list.some(member => member.name.startsWith(signature.name + '.') && member.runtime && member.runtime !== 'namespace')))) {
        entries.set(signature.name.slice(scope.length + 1), signature);
      }
    }
    const properties = value && typeof value === 'object' ? value as Record<string, unknown> : {};
    for (const [key, signature] of entries) {
      if (!Object.hasOwn(properties, key)) {
        errors.push(signature.location + ' ' + signature.name + ' is missing at runtime');
      } else if (signature.runtime === 'namespace') {
        if (properties[key] === null || typeof properties[key] !== 'object') {
          errors.push(signature.location + ' ' + signature.name + ' is not a namespace at runtime');
        } else {
          visit(signature.name, properties[key]);
        }
      } else if (signature.runtime !== 'value'
        && (properties[key] === null || typeof properties[key] !== signature.runtime)) {
        errors.push(signature.location + ' ' + signature.name + ' has a different runtime kind');
      }
    }
    for (const key of Object.getOwnPropertyNames(properties)) {
      if (!entries.has(key)) {
        errors.push(scope + '.' + key + ' exists at runtime without a declaration');
      }
    }
  }
  visit('vscode', runtime);
  return errors;
}

function countSymbols(api: Api, scope: string): number {
  return [...api.values()].filter(list => list.some(signature => signature.scope === scope)).length;
}

function projectApi(): Api {
  return collectApi(readdirSync(declarationsDirectory).filter(file => file.endsWith('.d.ts')).map(file => ({
    file, text: readFileSync(join(declarationsDirectory, file), 'utf8'),
  })));
}

test('matches the fixed VS Code declaration subset and records explicit deviations', () => {
  const reference = readFileSync(upstreamFile);
  expect(createHash('sha256').update(reference).digest('hex')).toBe(microsoftSha256);
  const upstream = collectApi([{ file: 'VS Code vscode.d.ts', text: reference.toString('utf8') }]);
  const local = projectApi();
  const deviations: Deviation[] = JSON.parse(readFileSync(deviationsFile, 'utf8'));
  const scopes = new Set(['vscode', ...[...local.values()].flatMap(list => list.flatMap(signature =>
    signature.runtime === 'namespace' ? [signature.name] : []))]);
  console.info([...scopes].map(scope => scope + ' ' + countSymbols(local, scope) + ' / ' + countSymbols(upstream, scope)).join('\n'));
  expect(checkDeviations(compareDeclarations(local, upstream), deviations)).toEqual([]);
});

test('assembles exactly the runtime keys declared by the repository', async () => {
  const host = await createTestExtensionApi();
  try {
    expect(checkRuntime(projectApi(), host.api)).toEqual([]);
    expect(host.api.CodeActionKind.QuickFix).toBeInstanceOf(host.api.CodeActionKind);
  } finally {
    host.dispose();
  }
});

test('detects planted signature mismatches across module and interface fragments', () => {
  const upstream = collectApi([{ file: 'upstream.d.ts', text: [
    "declare module 'vscode' {",
    '  function mix(left: string, right: string): void;',
    '  interface Value { readonly value?: string; length: number }',
    '  enum Kind { One = 1, Two = 2 }',
    '}',
  ].join('\n') }]);
  const local = collectApi([
    { file: 'first.d.ts', text: [
      "declare module 'vscode' {",
      '  function mix(right: string, left: string): void;',
      '  interface Value { readonly value: string }',
      '  enum Kind { One = 1, Two = 9 }',
      '}',
    ].join('\n') },
    { file: 'second.d.ts', text: "declare module 'vscode' { interface Value { length: number; unexpected: string } }" },
  ]);
  const problems = compareDeclarations(local, upstream);
  expect(problems.map(({ message }) => message)).toEqual([
    expect.stringContaining('first.d.ts:2 vscode.mix has a different signature'),
    expect.stringContaining('first.d.ts:3 vscode.Value#value has a different signature'),
    expect.stringContaining('first.d.ts:4 vscode.Kind#Two has a different signature'),
    expect.stringContaining('second.d.ts:1 vscode.Value#unexpected is absent upstream'),
  ]);
  expect(checkDeviations(problems, [{ name: 'vscode.mix', kind: 'signature', issue: '', reason: 'Test' }]))
    .toContain('Invalid API deviation vscode.mix:signature: a decision issue and reason are required');
});

test('accepts reformatting and class-interface and namespace merges across files', () => {
  const upstream = collectApi([{
    file: 'upstream.d.ts', text: "declare module 'vscode' { class Box { readonly value: string; close(): void } namespace commands { function run(): void } }",
  }]);
  const local = collectApi([
    { file: 'local.d.ts', text: "declare module 'vscode' { class Box { readonly value: string } namespace commands {} }" },
    { file: 'merged.d.ts', text: "declare module 'vscode' { interface Box { close ( /* close */ ) : void } namespace commands { function run(): void } }" },
  ]);
  expect(compareDeclarations(local, upstream)).toEqual([]);
});

test('reports both missing and untyped runtime members', () => {
  const local = collectApi([{
    file: 'local.d.ts', text: "declare module 'vscode' { class Expected {} namespace window { function expected(): void } }",
  }]);
  expect(checkRuntime(local, { window: { extra: () => {} }, Extra: class {} })).toEqual([
    'local.d.ts:1 vscode.Expected is missing at runtime',
    'local.d.ts:1 vscode.window.expected is missing at runtime',
    'vscode.window.extra exists at runtime without a declaration',
    'vscode.Extra exists at runtime without a declaration',
  ]);
});
