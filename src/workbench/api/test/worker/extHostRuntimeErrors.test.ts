import { expect, test } from 'vitest';
import { findExtensionErrorOwner } from '../../worker/extHostRuntimeErrors.js';

const first = 'https://example.test/extensions/extension.js';
const second = first + '2';
const removed = 'vscode-userdata:/extensions/test.removed-1.0.0/bundle.web.js';
const owners = new Map([[first, 'test.first'], [second, 'test.second'], [removed, 'test.removed']]);

function errorWithFrames(...frames: string[]): Error {
  const error = new Error('runtime failure');
  error.stack = [String(error), ...frames].join('\n');
  return error;
}

test('attributes a host API error to the first exact extension frame in the stack', () => {
  const error = errorWithFrames(
    '    at DiagnosticCollection.clear (http://localhost:5173/extHostDiagnostics.ts:2:9)',
    '    at tick (' + second + ':34:21)',
    '    at async ' + first + ':5:1',
  );
  expect(findExtensionErrorOwner(error, owners)).toBe('test.second');
  expect(findExtensionErrorOwner(errorWithFrames('    at async ' + first + ':5:1'), owners)).toBe('test.first');
});

test('matches the virtual package URL of a recorded extension entry', () => {
  const error = errorWithFrames('    at fn (' + removed + ':50:12)');
  expect(findExtensionErrorOwner(error, owners)).toBe('test.removed');
});

test('leaves host frames, ambiguous locations and stackless reasons without an owner', () => {
  const noStack = new Error('no stack');
  delete noStack.stack;
  const exotic = new Error('custom stack');
  Object.defineProperty(exotic, 'stack', { get() { throw new Error('formatter failed'); } });
  const multiline = new Error('message\n    at ' + first + ':1:2');
  const examples = [
    errorWithFrames('    at fn (' + second + '0:12:5)'),
    errorWithFrames('    at fn (' + first + ':12)'),
    errorWithFrames('    at http://localhost:5173/extensionHostWorkerMain.ts:12:5'),
    errorWithFrames('mentioned ' + first + ':12:5'),
    multiline, noStack, exotic, '    at ' + first + ':12:5', undefined,
  ];
  for (const reason of examples) {
    expect(findExtensionErrorOwner(reason, owners)).toBeUndefined();
  }
});
