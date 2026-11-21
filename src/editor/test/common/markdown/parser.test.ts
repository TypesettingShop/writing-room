// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createMarkdownParser, parseMarkdown, parseMarkdownWithSource } from '../../../common/markdown/parser.js';

describe('parseMarkdown', () => {
  it('maps inline syntax and spelling to schema nodes and marks', () => {
    const doc = parseMarkdown('# 제목\n\n*기울임* _다른_ **굵게** __다른__ ~~삭제~~ ``코드`` [링크](/uri "제목") ![**그림**](pic.png)  \n다음\n계속');
    doc.check();
    expect(doc.firstChild!.toJSON()).toEqual({
      type: 'heading', attrs: { classes: [], level: 1 }, content: [{ type: 'text', text: '제목' }],
    });
    expect(doc.lastChild!.toJSON()).toEqual({
      type: 'paragraph',
      attrs: { classes: [] },
      content: [
        { type: 'text', marks: [{ type: 'em', attrs: { markup: '*' } }], text: '기울임' },
        { type: 'text', text: ' ' },
        { type: 'text', marks: [{ type: 'em', attrs: { markup: '_' } }], text: '다른' },
        { type: 'text', text: ' ' },
        { type: 'text', marks: [{ type: 'strong', attrs: { markup: '**' } }], text: '굵게' },
        { type: 'text', text: ' ' },
        { type: 'text', marks: [{ type: 'strong', attrs: { markup: '__' } }], text: '다른' },
        { type: 'text', text: ' ' },
        { type: 'text', marks: [{ type: 'strike', attrs: { markup: '~~' } }], text: '삭제' },
        { type: 'text', text: ' ' },
        { type: 'text', marks: [{ type: 'code', attrs: { markup: '``' } }], text: '코드' },
        { type: 'text', text: ' ' },
        { type: 'text', marks: [{ type: 'link', attrs: { href: '/uri', title: '제목' } }], text: '링크' },
        { type: 'text', text: ' ' },
        { type: 'image', attrs: { src: 'pic.png', alt: '그림', title: null } },
        { type: 'hard_break' },
        { type: 'text', text: '다음' },
        { type: 'soft_break' },
        { type: 'text', text: '계속' },
      ],
    });
  });

  it('maps containers, code, aligned cells and footnotes', () => {
    const doc = parseMarkdown([
      '> 인용',
      '>',
      '> -----',
      '',
      '7) 상위',
      '    + [x] 완료',
      '    + [ ] 예정',
      '    + 일반',
      '',
      '~~~~ schema additional info',
      'literal',
      '~~~~',
      '',
      '| 왼쪽 | 오른쪽 |',
      '| :--- | ---: |',
      '| a | b |',
      '',
      '[^unused]: 남겨 둘 각주',
      '',
      '본문[^ref]^[짧은 각주]',
      '',
      '[^ref]: 각주 **내용**',
    ].join('\n'));
    doc.check();
    expect(doc.toJSON()).toMatchSnapshot();
  });

  it('keeps empty files editable and reports source lines and UTF-16 offsets', () => {
    expect(parseMarkdown('').toJSON()).toEqual({ type: 'doc', content: [{ type: 'paragraph', attrs: { classes: [] } }] });
    const source = '# 가😀\r\n\r\n둘째\r셋째';
    const { doc, blocks } = parseMarkdownWithSource(source);
    expect(blocks).toEqual([
      { from: 0, to: doc.firstChild!.nodeSize, startLine: 0, endLine: 1, startOffset: 0, endOffset: 7 },
      { from: doc.firstChild!.nodeSize, to: doc.content.size, startLine: 2, endLine: 4, startOffset: 9, endOffset: 14 },
    ]);
  });

  it('preserves an unknown plugin block and an unknown inline construct as raw source', () => {
    const parse = createMarkdownParser({
      plugins: [{
        id: 'custom',
        plugin: md => {
          md.block.ruler.before('paragraph', 'custom_block', (state, start, _end, silent) => {
            if (state.getLines(start, start + 1, 0, false) !== '::: custom') return false;
            if (!silent) {
              const token = state.push('custom_block', '', 0);
              token.map = [start, start + 2];
              state.line = start + 2;
            }
            return true;
          });
          md.inline.ruler.before('text', 'custom_inline', (state, silent) => {
            if (state.src[state.pos] !== '$') return false;
            if (!silent) state.push('custom_inline', '', 0);
            state.pos++;
            return true;
          });
        },
      }],
    });
    const { doc } = parse('시작\n\n::: custom\n*보존*\n\n> $ value\n\n끝');
    expect(doc.child(1).toJSON()).toEqual({ type: 'raw_block', attrs: { classes: [], source: '::: custom\n*보존*' } });
    expect(doc.child(2).toJSON()).toEqual({ type: 'raw_block', attrs: { classes: [], source: '> $ value' } });
    expect(doc.lastChild!.textContent).toBe('끝');
  });

  it('keeps reference definitions even when nested, repeated or unused', () => {
    const doc = parseMarkdown('> [ref]: /one\n\n[link][ref]\n\n[ref]: /two\n[unused]: /three');
    expect(doc.firstChild!.firstChild!.attrs.source).toBe('[ref]: /one');
    expect(doc.child(1).firstChild!.marks[0].attrs.href).toBe('/one');
    expect(doc.child(2).attrs.source).toBe('[ref]: /two');
    expect(doc.child(3).attrs.source).toBe('[unused]: /three');
  });
});

it('distinguishes task markers from reference links and reads tabs and empty tasks', () => {
  const doc = parseMarkdown('- [x]\t완료\n- [ ]\n- [x]\n\n[x]: /link');
  doc.firstChild!.forEach((task, _offset, index) => {
    expect(task.type.name).toBe('task_item');
    expect(task.attrs.checked).toBe(index !== 1);
    expect(task.textContent).toBe(index === 0 ? '완료' : '');
  });
});

it('reads list tightness when the first item starts with a blockquote', () => {
  const doc = parseMarkdown('- > quote\n- next');
  expect(doc.firstChild!.attrs.tight).toBe(true);
  expect(doc.firstChild!.firstChild!.lastChild!.type.name).toBe('blockquote');
});
