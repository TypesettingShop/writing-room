// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type Token from 'markdown-it/lib/token.mjs';
import { createMarkdownIt } from '../../../common/markdown/markdownIt.js';

function describeTokens(tokens: readonly Token[]): unknown[] {
  return tokens.map(({ type, markup, info, content, attrs, children }) => ({
    type,
    ...(markup && { markup }),
    ...(info && { info }),
    ...(content && { content }),
    ...(attrs && { attrs: Object.fromEntries(attrs) }),
    ...(children && { children: describeTokens(children) }),
  }));
}

describe('createMarkdownIt', () => {
  it('tokenizes the configured CommonMark and GFM features', () => {
    const source = [
      '# 제목',
      '',
      '~~삭제~~[^a]',
      '',
      '1. 상위',
      '    1. 하위',
      '',
      '- [x] 완료',
      '- [ ] 예정',
      '',
      '| 열 |',
      '| :-: |',
      '| 값 |',
      '',
      '~~~typescript',
      'const x = 1;',
      '~~~',
      '',
      '[^a]: 각주',
    ].join('\n');
    const tokens = createMarkdownIt().parse(source, {});
    expect(describeTokens(tokens)).toMatchSnapshot();
    expect(tokens.filter(token => token.type === 'ordered_list_open').map(token => token.level))
      .toEqual([0, 2]);
  });

  it('keeps source HTML literal', () => {
    expect(createMarkdownIt().render('<b>hello</b>')).toContain('&lt;b&gt;hello&lt;/b&gt;');
  });

  it('registers contributions in order with isolated instances', () => {
    const calls: string[] = [];
    const markdownIt = createMarkdownIt({
      plugins: [
        { id: 'a', plugin: (md, value: string) => { calls.push(value); md.disable('table'); }, options: 'first' },
        { id: 'b', plugin: () => { calls.push('second'); } },
      ],
    });
    expect(calls).toEqual(['first', 'second']);
    expect(markdownIt.render('| x |\n| - |')).not.toContain('<table>');
    expect(createMarkdownIt().render('| x |\n| - |')).toContain('<table>');
    expect(() => createMarkdownIt({ plugins: [{ id: 'footnote', plugin: () => {} }] }))
      .toThrow('Duplicate markdown-it plugin: footnote');
  });
});
