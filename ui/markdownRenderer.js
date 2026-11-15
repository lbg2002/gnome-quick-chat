import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import St from 'gi://St';
import {StreamingMarkdownParser} from '../core/markdownStreamParser.js';
import {formatDisplayBufferWithCap, UI_BUFFER_CAPS} from '../core/renderScheduler.js';

const V = Clutter.Orientation.VERTICAL;
const H = Clutter.Orientation.HORIZONTAL;

const MAX_CODE_BLOCK_DISPLAY_CHARS = 32768;

export function createWrapLabel(text, styleClass, selectable = true) {
    const label = new St.Label({
        text: text ?? '',
        style_class: styleClass,
        x_expand: true,
    });
    const ct = label.clutter_text;
    ct.line_wrap = true;
    ct.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
    ct.ellipsize = Pango.EllipsizeMode.NONE;
    ct.selectable = selectable;
    return label;
}

/**
 * Sets Pango markup strictly when the markup or fallback text actually changed,
 * avoiding redundant `Pango.parse_markup` + `ct.set_markup` layout passes on unchanged blocks!
 */
export function setLabelMarkupSafe(label, pangoMarkup, fallbackPlainText) {
    const nextMarkup = String(pangoMarkup ?? '');
    const nextPlain = String(fallbackPlainText ?? '');
    if (label._lastMarkup === nextMarkup && label._lastPlainText === nextPlain) {
        return;
    }
    label._lastMarkup = nextMarkup;
    label._lastPlainText = nextPlain;

    const ct = label.clutter_text;
    try {
        Pango.parse_markup(nextMarkup, -1, '\0');
        if (!ct.use_markup) ct.use_markup = true;
        ct.set_markup(nextMarkup);
    } catch (_) {
        ct.use_markup = false;
        label.text = nextPlain;
    }
}

function blockSignature(block) {
    if (block.type === 'code') {
        return `code:${block.lang || ''}:${block.code || ''}`;
    }
    return `text:${block.pango || block.raw || ''}`;
}

function formatCodeForDisplay(rawCode, expanded = false) {
    const str = String(rawCode || '');
    if (!str) return ' ';
    if (expanded || str.length <= MAX_CODE_BLOCK_DISPLAY_CHARS) {
        return str;
    }
    return `${str.slice(0, MAX_CODE_BLOCK_DISPLAY_CHARS)}\n… [代码较长共 ${str.length} 字符，点击右上角「复制代码」可获取完整无损源码]`;
}

function createBlockEntry(block, onCreateCopyButton, codeExpanded = false) {
    if (block.type === 'code') {
        const codeCard = new St.BoxLayout({
            orientation: V,
            style_class: 'qc-code-block',
            x_expand: true,
        });
        const codeHeader = new St.BoxLayout({
            orientation: H,
            style_class: 'qc-code-header',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const langLabel = new St.Label({
            text: block.lang || 'code',
            style_class: 'qc-code-lang',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        codeHeader.add_child(langLabel);

        const entry = {
            type: 'code',
            signature: blockSignature(block),
            // Exact full raw code is ALWAYS preserved for copying, never truncated!
            codeValue: block.code || '',
            actor: codeCard,
            langLabel,
            textLabel: null,
        };

        const copyBtn = onCreateCopyButton(() => entry.codeValue);
        codeHeader.add_child(copyBtn);
        codeCard.add_child(codeHeader);

        const codeBody = createWrapLabel(formatCodeForDisplay(block.code, codeExpanded), 'qc-code-text', true);
        codeCard.add_child(codeBody);
        entry.textLabel = codeBody;
        return entry;
    }

    const lbl = createWrapLabel('', 'qc-message-text', true);
    setLabelMarkupSafe(lbl, block.pango, block.raw);
    return {
        type: 'text',
        signature: blockSignature(block),
        actor: lbl,
        textLabel: lbl,
    };
}

function updateBlockEntryInPlace(entry, block, codeExpanded = false) {
    entry.signature = blockSignature(block);
    if (block.type === 'code') {
        // Preserve full unmodified source code for copy button!
        entry.codeValue = block.code || '';
        const nextLang = block.lang || 'code';
        if (entry.langLabel.text !== nextLang) {
            entry.langLabel.text = nextLang;
        }
        const nextCodeDisplay = formatCodeForDisplay(block.code, codeExpanded);
        if (entry.textLabel.text !== nextCodeDisplay) {
            entry.textLabel.text = nextCodeDisplay;
        }
    } else {
        setLabelMarkupSafe(entry.textLabel, block.pango, block.raw);
    }
}

/**
 * True Incremental Streaming Markdown & Plaintext card body renderer (Stage D1):
 * - Uses per-card `StreamingMarkdownParser` so streaming deltas parse ONLY new characters/lines,
 *   never re-parsing earlier confirmed blocks or re-scanning frozen block signatures!
 * - Re-parses cleanly on `text_replace` (`parsed.replaced === true`) and finalizes deferred markup on `isFinal`.
 * - Preserves copyable text (`selectable = true`) and unmodified `entry.codeValue` on code copy buttons.
 */
export function renderCardBodyIncremental(card, {
    markdownEnabled,
    placeholderText,
    onCreateCodeCopyButton,
    isFinal = false,
}) {
    const {bodyBox, role} = card;
    const rawText = card.text || '';

    if (!card.renderState) {
        card.renderState = {
            mode: '',
            placeholderLabel: null,
            plainLabel: null,
            frozenEntries: [],
            tailEntry: null,
            streamParser: new StreamingMarkdownParser(),
        };
    }
    const st = card.renderState;
    if (!st.streamParser) {
        st.streamParser = new StreamingMarkdownParser();
    }

    const resetBody = newMode => {
        bodyBox.destroy_all_children();
        st.mode = newMode;
        st.placeholderLabel = null;
        st.plainLabel = null;
        st.frozenEntries = [];
        st.tailEntry = null;
        st.streamParser.reset();
    };

    // 1. Empty / Placeholder state
    if (!rawText) {
        if (st.mode !== 'placeholder' || !st.placeholderLabel) {
            resetBody('placeholder');
            st.placeholderLabel = createWrapLabel(placeholderText || '…', 'qc-message-text', true);
            bodyBox.add_child(st.placeholderLabel);
        } else if (st.placeholderLabel.text !== placeholderText) {
            st.placeholderLabel.text = placeholderText;
        }
        return;
    }

    const cappedDisplay = formatDisplayBufferWithCap(rawText, {
        maxDisplayBytes: UI_BUFFER_CAPS.maxCardStreamingBytes,
        expanded: Boolean(card.uiBodyExpanded),
    });
    const textForRender = cappedDisplay.displayText;

    // 2. Plaintext mode (user messages or Markdown disabled)
    if (role === 'user' || !markdownEnabled) {
        if (st.mode !== 'plain' || !st.plainLabel) {
            resetBody('plain');
            st.plainLabel = createWrapLabel(textForRender, 'qc-message-text', true);
            bodyBox.add_child(st.plainLabel);
        } else if (st.plainLabel.text !== textForRender) {
            st.plainLabel.text = textForRender;
        }
        return;
    }

    // 3. True Incremental Markdown mode
    if (st.mode !== 'markdown') {
        resetBody('markdown');
    }

    const parsed = st.streamParser.update(textForRender, {finalize: Boolean(isFinal)});
    const blocks = parsed.blocks;

    if (!blocks.length) {
        if (st.mode !== 'plain' || !st.plainLabel) {
            resetBody('plain');
            st.plainLabel = createWrapLabel(textForRender, 'qc-message-text', true);
            bodyBox.add_child(st.plainLabel);
        } else if (st.plainLabel.text !== textForRender) {
            st.plainLabel.text = textForRender;
        }
        return;
    }

    const completedCount = Math.max(0, blocks.length - 1);
    const tailBlock = blocks[blocks.length - 1];
    const codeExpanded = Boolean(card.uiBodyExpanded);

    // Only check earlier frozen blocks if `text_replace` happened OR if a transient unconfirmed fence line shifted!
    // During normal streaming, `0 .. parsed.confirmedCount - 1` are skipped in O(1)!
    let divergeIdx = -1;
    const checkStartIdx = parsed.replaced ? 0 : Math.min(st.frozenEntries.length, parsed.confirmedCount);
    const minCheck = Math.min(st.frozenEntries.length, completedCount);
    for (let i = checkStartIdx; i < minCheck; i++) {
        if (st.frozenEntries[i].signature !== blockSignature(blocks[i])) {
            divergeIdx = i;
            break;
        }
    }
    if (divergeIdx === -1 && st.frozenEntries.length > completedCount) {
        divergeIdx = completedCount;
    }

    if (divergeIdx !== -1) {
        while (st.frozenEntries.length > divergeIdx) {
            const removed = st.frozenEntries.pop();
            try { bodyBox.remove_child(removed.actor); removed.actor.destroy(); } catch (_) {}
        }
        if (st.tailEntry) {
            try { bodyBox.remove_child(st.tailEntry.actor); st.tailEntry.actor.destroy(); } catch (_) {}
            st.tailEntry = null;
        }
    }

    // Materialize newly completed blocks (`st.frozenEntries.length .. completedCount - 1`)
    while (st.frozenEntries.length < completedCount) {
        const idx = st.frozenEntries.length;
        const targetBlock = blocks[idx];

        if (st.tailEntry && st.tailEntry.type === targetBlock.type) {
            updateBlockEntryInPlace(st.tailEntry, targetBlock, codeExpanded);
            st.frozenEntries.push(st.tailEntry);
            st.tailEntry = null;
        } else {
            const entry = createBlockEntry(targetBlock, onCreateCodeCopyButton, codeExpanded);
            if (st.tailEntry?.actor && st.tailEntry.actor.get_parent() === bodyBox) {
                bodyBox.insert_child_below(entry.actor, st.tailEntry.actor);
            } else {
                bodyBox.add_child(entry.actor);
            }
            st.frozenEntries.push(entry);
        }
    }

    // Update or create the single active mutable tail block
    if (st.tailEntry && st.tailEntry.type === tailBlock.type) {
        const nextSig = blockSignature(tailBlock);
        if (st.tailEntry.signature !== nextSig) {
            updateBlockEntryInPlace(st.tailEntry, tailBlock, codeExpanded);
        }
    } else {
        if (st.tailEntry) {
            try { bodyBox.remove_child(st.tailEntry.actor); st.tailEntry.actor.destroy(); } catch (_) {}
        }
        st.tailEntry = createBlockEntry(tailBlock, onCreateCodeCopyButton, codeExpanded);
        bodyBox.add_child(st.tailEntry.actor);
    }
}
