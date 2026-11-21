// @vitest-environment node
import { expect, test } from 'vitest';
import { OUTPUT_CHANNEL_LIMIT, OutputChannelModel } from '../../common/output.js';

const lines = (model: OutputChannelModel) =>
  Array.from({ length: model.lineCount }, (_, index) => model.getLine(model.firstLine + index));

test('10,000 appends and appendLines keep their order', () => {
  const model = new OutputChannelModel();
  for (let index = 0; index < 10_000; index++) {
    model.append(`a${index} `);
    model.append(`b${index}\n`);
  }
  expect(model.lineCount).toBe(10_000);
  expect(lines(model).slice(-3)).toEqual(['a9997 b9997', 'a9998 b9998', 'a9999 b9999']);
  expect(model.getText().endsWith('a9999 b9999\n')).toBe(true);
});

test('past the limit the oldest lines go, the newest stay, and the size never grows past it', () => {
  const model = new OutputChannelModel(100);
  for (let index = 0; index < 50; index++) {
    model.append(`line ${String(index).padStart(2, '0')}\n`);
    expect(model.size).toBeLessThanOrEqual(100);
  }
  // Each line takes 8 code units with its line feed: 12 lines fit in 100.
  expect(lines(model)).toEqual(Array.from({ length: 12 }, (_, index) => `line ${38 + index}`));
  expect(model.firstLine).toBe(38);
  expect(model.size).toBe(96);
});

test('the real limit is 1 MiB of code units', () => {
  const model = new OutputChannelModel();
  const line = 'x'.repeat(1023);
  for (let index = 0; index < 1100; index++) {
    model.append(line + '\n');
  }
  expect(model.size).toBe(OUTPUT_CHANNEL_LIMIT);
  expect(model.lineCount).toBe(1024);
  expect(model.firstLine).toBe(1100 - 1024);
});

test('a line longer than the limit keeps its end, and so does an unfinished one', () => {
  const model = new OutputChannelModel(10);
  model.append('old\n');
  model.append('abcdefghijklmnop\nxyz');
  expect(model.getText()).toBe('klmnop\nxyz');
  expect(model.size).toBe(10);

  model.append('0123456789ABCDEF');
  expect(model.lineCount).toBe(0);
  expect(model.getText()).toBe('6789ABCDEF');
});

test('a cut never leaves half of a surrogate pair', () => {
  const model = new OutputChannelModel(3);
  model.append('a😀cd');
  expect(model.getText()).toBe('cd');
  model.clear();
  model.append('ab😀c');
  expect(model.getText()).toBe('😀c');
});

test('a carriage return before a line feed is dropped, even across appends', () => {
  const model = new OutputChannelModel();
  model.append('one\r');
  model.append('\ntwo\r\nthree');
  expect(lines(model)).toEqual(['one', 'two']);
  expect(model.partialLine).toBe('three');
});

test('clear and replace start over, and change the generation', () => {
  const model = new OutputChannelModel();
  let changes = 0;
  model.onDidChange(() => changes++);
  model.append('first\nsecond\n');
  const generation = model.generation;
  model.clear();
  expect(model.getText()).toBe('');
  expect(model.generation).not.toBe(generation);
  model.replace('only\n');
  expect(model.getText()).toBe('only\n');
  expect(model.firstLine).toBe(0);
  model.append('');
  expect(changes).toBe(3);
});
