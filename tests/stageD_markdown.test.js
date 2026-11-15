import test from 'node:test';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {
    StreamingMarkdownParser,
    parseMarkdownBlocks,
    escapePango,
    inlineMarkdownToPango,
    formatLineToPango,
} from '../core/markdownStreamParser.js';

function assertValidSimplePangoMarkup(pangoStr) {
    // Verify no unescaped `<` or `>` outside allowed Pango tags (`b`, `i`, `u`, `s`, `tt`, `small`)
    const strippedAllowed = String(pangoStr || '').replace(/<\/?(?:b|i|u|s|tt|small)>/g, '');
    assert.equal(strippedAllowed.includes('<'), false, `Unescaped '<' in Pango markup: ${pangoStr}`);
    assert.equal(strippedAllowed.includes('>'), false, `Unescaped '>' in Pango markup: ${pangoStr}`);

    // Verify tag stack balance
    const tagRe = /<(\/?)(b|i|u|s|tt|small)>/g;
    const stack = [];
    let m;
    while ((m = tagRe.exec(pangoStr)) !== null) {
        const [, slash, name] = m;
        if (!slash) {
            stack.push(name);
        } else {
            const top = stack.pop();
            assert.equal(top, name, `Mismatched Pango closing tag </${name}> (expected </${top}>) in: ${pangoStr}`);
        }
    }
    assert.equal(stack.length, 0, `Unclosed Pango tags [${stack.join(',')}] in: ${pangoStr}`);
}

const COMPLEX_MARKDOWN_DOC = [
    '# 随问 GNOME 50 流式解析器验证 🚀',
    '',
    '这是一段包含 **中文加粗**、*斜体*、`inline_code("<tag>&attr")` 以及 [GitHub 链接](https://github.com/lbg2002/gnome-quick-chat) 的混合段落。',
    '- 列表项 1：包含特殊符号 `a < b && c > d` 与表情 💡',
    '  - 嵌套列表项：~~删除线~~ 与 **嵌套 `code` 加粗**',
    '1. 有序步骤一：检查 `<span foreground="red">注入攻击</span>` 是否被严格转义',
    '> 引用提示：流式分块边界可能切在任意字节、反引号或 CRLF 中间！',
    '',
    '```python',
    'def verify_stream(chunks: list[str]) -> bool:',
    '    # 代码块内不应解析 **bold** 或 <script>alert(1)</script>',
    '    msg = "你好，世界 🌍\\nLine 2"',
    '    return len(chunks) > 0 and ("a" < "b")',
    '```',
    '',
    '---',
    '',
    '第二段正文紧跟分割线之后：',
    '```bash',
    'gsettings get org.gnome.shell.extensions.quick-chat backend',
    '```',
    '结尾收束行（无尾随换行）。',
].join('\n');

test('D1: StreamingMarkdownParser matches parseMarkdownBlocks across arbitrary chunk boundaries (1, 2, 3, 5, 13, CRLF)', () => {
    const expectedBlocks = parseMarkdownBlocks(COMPLEX_MARKDOWN_DOC);
    assert.ok(expectedBlocks.length >= 4);

    for (const step of [1, 2, 3, 5, 13, 37]) {
        const parser = new StreamingMarkdownParser();
        let acc = '';
        for (let i = 0; i < COMPLEX_MARKDOWN_DOC.length; i += step) {
            acc += COMPLEX_MARKDOWN_DOC.slice(i, i + step);
            const interim = parser.update(acc, {finalize: false});
            for (const blk of interim.blocks) {
                if (blk.type === 'text') {
                    assertValidSimplePangoMarkup(blk.pango);
                }
            }
        }
        const finalRes = parser.update(acc, {finalize: true});
        assert.deepEqual(
            finalRes.blocks,
            expectedBlocks,
            `Mismatch for chunk step=${step}`
        );
    }

    // Also test `\r\n` split right between `\r` and `\n` across chunks!
    const crlfDoc = COMPLEX_MARKDOWN_DOC.replace(/\n/g, '\r\n');
    const crlfParser = new StreamingMarkdownParser();
    let crlfAcc = '';
    for (let i = 0; i < crlfDoc.length; i++) {
        crlfAcc += crlfDoc[i];
        crlfParser.update(crlfAcc, {finalize: false});
    }
    const crlfFinal = crlfParser.update(crlfAcc, {finalize: true});
    assert.deepEqual(crlfFinal.blocks, expectedBlocks);
});

test('D1: Unclosed code fences, split triple-backticks, and Pango/Markdown injection stay safe mid-stream', () => {
    const parser = new StreamingMarkdownParser();

    // Split ```javascript across 4 tiny chunks
    let text = '前置说明 <unsafe attr="1">&test\n`';
    let r = parser.update(text);
    assert.equal(r.blocks.length, 1);
    assert.equal(r.blocks[0].type, 'text');
    assertValidSimplePangoMarkup(r.blocks[0].pango);

    text += '`';
    r = parser.update(text);
    assertValidSimplePangoMarkup(r.blocks[0].pango);

    text += '`javascript\nconst x = 1 < 2 && 3 > 1;';
    r = parser.update(text);
    assert.equal(r.blocks.length, 2);
    assert.equal(r.blocks[0].type, 'text');
    assert.equal(r.blocks[0].raw, '前置说明 <unsafe attr="1">&test');
    assert.equal(r.blocks[1].type, 'code');
    assert.equal(r.blocks[1].lang, 'javascript');
    assert.equal(r.blocks[1].closed, false);
    assert.equal(r.blocks[1].code, 'const x = 1 < 2 && 3 > 1;');

    // Close the fence incrementally
    text += '\n``';
    r = parser.update(text);
    assert.equal(r.blocks[1].closed, false);

    text += '`\n后续 **未闭合加粗 <span bad="1">';
    r = parser.update(text);
    assert.equal(r.blocks.length, 3);
    assert.equal(r.blocks[1].closed, true);
    assert.equal(r.confirmedCount, 2, 'First text block + closed code block must be frozen');
    assertValidSimplePangoMarkup(r.blocks[2].pango);

    // Injection payloads directly through helpers
    const injected = formatLineToPango('Click [here](https://example.com) & < markup > **bold `<tag>`** *italic*');
    assertValidSimplePangoMarkup(injected);
    assert.ok(injected.includes('&lt; markup &gt;'));
    assert.ok(injected.includes('<tt>&lt;tag&gt;</tt>'));
    assert.equal(escapePango('<a&"b">'), '&lt;a&amp;&quot;b&quot;&gt;');
    assertValidSimplePangoMarkup(inlineMarkdownToPango('***nested*** __under__ ~~strike~~'));
});

test('D1: text_replace (non-prefix update) triggers clean reset and exact block parity', () => {
    const parser = new StreamingMarkdownParser();
    parser.update('第一版草稿\n```sh\necho old\n```\n尾部');
    assert.equal(parser.confirmedBlockCount, 2);

    const replacedDoc = '修正后的完整回答：\n\n1. 第一项\n2. 第二项\n\n```json\n{"ok": true}\n```';
    const res = parser.update(replacedDoc, {finalize: true});
    assert.equal(res.replaced, true);
    assert.equal(parser.stats.fullResets, 1);
    assert.deepEqual(res.blocks, parseMarkdownBlocks(replacedDoc));
});

test('D1: Deferred formatting on huge streaming blocks preserves exact raw copyable text and completes formatting on finalize', () => {
    const parser = new StreamingMarkdownParser({deferMarkupThresholdChars: 1024});
    const paragraphLines = [];
    for (let i = 0; i < 45; i++) {
        paragraphLines.push(`第 ${i + 1} 行：包含 **重点标记_${i}** 与 \`cmd_${i}\` 的长段落内容。`);
    }
    const bigDoc = paragraphLines.join('\n');
    assert.ok(bigDoc.length > 1500);

    let acc = '';
    for (let i = 0; i < bigDoc.length; i += 97) {
        acc = bigDoc.slice(0, i + 97);
        parser.update(acc, {finalize: false});
    }

    const midRes = parser.update(bigDoc, {finalize: false});
    assert.equal(midRes.blocks.length, 1);
    assert.equal(midRes.blocks[0].raw, bigDoc, 'Raw copyable text must NEVER be altered during deferred streaming');
    assert.equal(midRes.blocks[0].deferredFormatting, true);
    assertValidSimplePangoMarkup(midRes.blocks[0].pango);

    const finalRes = parser.update(bigDoc, {finalize: true});
    assert.equal(Boolean(finalRes.blocks[0].deferredFormatting), false);
    assert.ok(finalRes.blocks[0].pango.includes('<b>重点标记_44</b>'));
    assert.deepEqual(finalRes.blocks, parseMarkdownBlocks(bigDoc));
});

test('D1 Benchmark: StreamingMarkdownParser avoids O(N^2) re-parsing across 400 streaming chunks', () => {
    // Build a realistic 18 KB multi-section Markdown + code response (~400 chunks of ~45 chars)
    const sections = [];
    for (let s = 1; s <= 18; s++) {
        sections.push(
            `## 第 ${s} 节：GNOME Shell 主线程渲染分析`,
            `在流式输出阶段，若每个增量都对全文重新执行正则解析，总复杂度会退化为二次方级别（Section **#${s}**，指标 \`frame_budget <= 16.6ms\`）。`,
            '```javascript',
            `export function step${s}(items) {`,
            `    return items.filter(x => x.ok && x.id !== "${s}").map(x => x.value * ${s});`,
            '}',
            '```',
            ''
        );
    }
    const fullDoc = sections.join('\n');
    const chunkSize = Math.ceil(fullDoc.length / 400);
    const prefixes = [];
    for (let pos = chunkSize; pos < fullDoc.length; pos += chunkSize) {
        prefixes.push(fullDoc.slice(0, pos));
    }
    prefixes.push(fullDoc);

    // Warmup JIT briefly
    parseMarkdownBlocks(prefixes[5]);
    const warm = new StreamingMarkdownParser();
    warm.update(prefixes[5]);

    const tFull0 = performance.now();
    let lastFull = null;
    for (let i = 0; i < prefixes.length; i++) {
        lastFull = parseMarkdownBlocks(prefixes[i]);
    }
    const fullParseMs = performance.now() - tFull0;

    const streamParser = new StreamingMarkdownParser();
    const tInc0 = performance.now();
    let lastInc = null;
    for (let i = 0; i < prefixes.length; i++) {
        const isLast = i === prefixes.length - 1;
        lastInc = streamParser.update(prefixes[i], {finalize: isLast});
    }
    const incrementalMs = performance.now() - tInc0;

    assert.deepEqual(lastInc.blocks, lastFull);
    // Confirmed blocks are cached, so total lines formatted incrementally is O(total_lines), NOT O(chunks * total_lines)!
    const totalLinesInDoc = fullDoc.split('\n').length;
    assert.ok(
        streamParser.stats.linesFormatted < totalLinesInDoc * 3,
        `Expected O(N) line formatting (< ${totalLinesInDoc * 3}), got ${streamParser.stats.linesFormatted}`
    );
    assert.ok(
        incrementalMs < fullParseMs,
        `Expected incremental parser (${incrementalMs.toFixed(2)}ms) to beat full re-parse (${fullParseMs.toFixed(2)}ms)`
    );
});
