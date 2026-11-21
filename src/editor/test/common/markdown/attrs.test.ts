// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createMarkdownIt } from '../../../common/markdown/markdownIt.js';
import { parseMarkdown, parseMarkdownWithSource } from '../../../common/markdown/parser.js';

describe('Markdown classes', () => {
  it('attaches ordered classes to headings, paragraphs, quotes, list items and table cells', () => {
    const doc = parseMarkdown([
      '# 제목 {.center .unknown .center}',
      '',
      '첫 줄',
      '마지막 줄 {.subtitle}',
      '',
      '> 인용 {.quote}',
      '',
      '- 항목 {.item}',
      '    - [x] 체크 {.checked}',
      '',
      '| 표 {.header} |',
      '| -- |',
      '| 셀 {.cell} |',
    ].join('\n'));
    doc.check();

    expect(doc.child(0).attrs.classes).toEqual(['center', 'unknown', 'center']);
    expect(doc.child(1).attrs.classes).toEqual(['subtitle']);
    expect(doc.child(1).textContent).toBe('첫 줄\n마지막 줄');
    expect(doc.child(2).attrs.classes).toEqual(['quote']);
    expect(doc.child(2).firstChild!.attrs.classes).toEqual([]);
    const item = doc.child(3).firstChild!;
    expect(item.attrs.classes).toEqual(['item']);
    const task = item.lastChild!.firstChild!;
    expect(task.type.name).toBe('task_item');
    expect(task.attrs).toEqual({ classes: ['checked'], checked: true });
    expect(task.textContent).toBe('체크');
    expect(doc.child(4).firstChild!.firstChild!.attrs.classes).toEqual(['header']);
    expect(doc.child(4).lastChild!.firstChild!.attrs.classes).toEqual(['cell']);
  });

  it('parses styled spans in prose and link labels, with nested emphasis', () => {
    const { firstChild } = parseMarkdown('a [**글자**]{.size-lg .unknown} [링크 [내부]{.font-serif}](/x)');
    const strong = firstChild!.child(1);
    expect(strong.text).toBe('글자');
    expect(strong.marks.map(mark => [mark.type.name, mark.attrs]))
      .toEqual([['span', { classes: ['size-lg', 'unknown'] }], ['strong', { markup: '**' }]]);
    const linked = firstChild!.lastChild!;
    expect(linked.text).toBe('내부');
    expect(linked.marks.map(mark => mark.type.name)).toEqual(['link', 'span']);
    expect(createMarkdownIt().render('[글자]{.size-lg}')).toContain('<span class="size-lg">글자</span>');
  });

  it('keeps escapes, invalid attributes, code, URLs and image/link titles literal', () => {
    const doc = parseMarkdown([
      '# 제목 \\{.escaped}',
      '',
      '문단 {.valid .Invalid} [x]{#id} [y]{.size-lg bad=1} [z]\\{.escaped}',
      '',
      '`{.code}` [링크](/path{.href} "{.title}") ![{.alt}](/image{.src} "{.title}")',
      '',
      '~~~ {.info}',
      '[x]{.code}',
      '~~~',
    ].join('\n'));
    doc.check();
    expect(doc.child(0).textContent).toBe('제목 {.escaped}');
    expect(doc.child(1).textContent).toBe('문단 {.valid .Invalid} [x]{#id} [y]{.size-lg bad=1} [z]{.escaped}');
    const inline = doc.child(2);
    expect(inline.firstChild!.marks.map(mark => mark.type.name)).toEqual(['code']);
    expect(inline.child(2).marks[0].attrs).toEqual({ href: '/path%7B.href%7D', title: '{.title}' });
    expect(inline.lastChild!.attrs).toEqual({ src: '/image%7B.src%7D', alt: '{.alt}', title: '{.title}' });
    expect(doc.lastChild!.attrs.info).toBe('{.info}');
    expect(doc.lastChild!.textContent).toBe('[x]{.code}');
    doc.forEach(node => expect(node.attrs.classes).toEqual([]));
  });

  it('addresses containers with a detached trailer and nested paragraphs with a continued trailer', () => {
    const { doc, blocks } = parseMarkdownWithSource('> 본문\n> {.paragraph}\n\n{.quote}\n\n- 항목 {.item}\n    {.paragraph}');
    expect(doc.firstChild!.attrs.classes).toEqual(['quote']);
    expect(doc.firstChild!.firstChild!.attrs.classes).toEqual(['paragraph']);
    expect(doc.lastChild!.firstChild!.attrs.classes).toEqual(['item']);
    expect(doc.lastChild!.firstChild!.firstChild!.attrs.classes).toEqual(['paragraph']);
    expect(blocks[0].endLine).toBe(4);
  });
});
