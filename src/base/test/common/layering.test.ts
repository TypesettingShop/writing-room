// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, test } from 'vitest';

const projectRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const srcRoot = join(projectRoot, 'src');
const layers = ['base', 'platform', 'editor', 'workbench', 'code'];
const sourceExtension = /\.[cm]?[jt]sx?$/;
const compilerOptions = ts.getParsedCommandLineOfConfigFile(join(projectRoot, 'tsconfig.json'), {}, {
  ...ts.sys,
  onUnRecoverableConfigFileDiagnostic: diagnostic => {
    throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
  },
})!.options;

function sourceSegments(file: string): string[] {
  const path = relative(srcRoot, file);
  return isAbsolute(path) || path.startsWith('..' + sep) ? [] : path.split(sep);
}

function resolveImport(file: string, specifier: string): string | undefined {
  const path = specifier.split('?')[0];
  if (path.startsWith('.')) {
    return resolve(dirname(file), path);
  }
  if (path.startsWith('/src/')) {
    return join(projectRoot, path);
  }
  return ts.resolveModuleName(path, file, compilerOptions, ts.sys).resolvedModule?.resolvedFileName;
}

function importedPath(node: ts.Node): ts.StringLiteralLike | undefined {
  let path: ts.Node | undefined;
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
    path = node.moduleSpecifier;
  } else if (ts.isExternalModuleReference(node)) {
    path = node.expression;
  } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
    path = node.argument.literal;
  } else if (ts.isCallExpression(node) &&
    (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
    path = node.arguments[0];
  }
  return path && ts.isStringLiteralLike(path) ? path : undefined;
}

function findViolations(file: string, contents: string): string[] {
  const source = ts.createSourceFile(file, contents, ts.ScriptTarget.Latest, true);
  const from = sourceSegments(file);
  const violations: string[] = [];

  function visit(node: ts.Node): void {
    const path = importedPath(node);
    if (path) {
      const target = resolveImport(file, path.text);
      const to = target ? sourceSegments(target) : [];
      const fromLayer = layers.indexOf(from[0]);
      const toLayer = layers.indexOf(to[0]);
      const reasons: string[] = [];

      if (fromLayer >= 0 && toLayer > fromLayer) {
        reasons.push(`${from[0]} must not import ${to[0]}`);
      }
      if (from.slice(0, -1).includes('common') && to.slice(0, -1).includes('browser')) {
        reasons.push('common must not import browser');
      }
      if (reasons.length) {
        const { line } = source.getLineAndCharacterOfPosition(path.getStart(source));
        violations.push(`${relative(projectRoot, file)}:${line + 1} ${path.text}: ${reasons.join('; ')}`);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  return violations;
}

test('src imports obey the layer and common/browser boundaries', () => {
  const files = readdirSync(srcRoot, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && sourceExtension.test(entry.name))
    .map(entry => join(entry.parentPath, entry.name))
    .sort();
  const violations = files.flatMap(file => findViolations(file, readFileSync(file, 'utf8')));

  expect(files.length).toBeGreaterThan(0);
  expect(violations).toEqual([]);
});

test('detects planted upward and common-to-browser imports in multiline and indirect forms', () => {
  const violations = findViolations(join(srcRoot, 'base/common/planted.ts'), [
    'import type {',
    '  Service,',
    "} from '../../platform/common/service.js';",
    "export { widget } from '../browser/widget.js';",
    "const widget = import('../browser/widget.js');",
    "type Widget = import('/src/base/browser/widget.js').Widget;",
    "import service = require('../../platform/common/service.js');",
    "// import '../../platform/common/service.js';",
    "const example = \"import '../browser/widget.js'\";",
  ].join('\n'));

  expect(violations).toEqual([
    expect.stringContaining('base must not import platform'),
    expect.stringContaining('common must not import browser'),
    expect.stringContaining('common must not import browser'),
    expect.stringContaining('common must not import browser'),
    expect.stringContaining('base must not import platform'),
  ]);
});

test('allows same-layer and downward imports outside the common-to-browser boundary', () => {
  expect(findViolations(join(srcRoot, 'workbench/browser/allowed.ts'), [
    "import './widget.js';",
    "import '../common/service.js';",
    "import '../../platform/browser/service.js';",
    "import '../../base/common/event.js';",
  ].join('\n'))).toEqual([]);
});
