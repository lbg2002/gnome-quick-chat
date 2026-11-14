import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import St from 'gi://St';
import {parseMarkdownBlocks} from '../protocol.js';

const V = Clutter.Orientation.VERTICAL;
const H = Clutter.Orientation.HORIZONTAL;

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

export function setLabelMarkupSafe(label, pangoMarkup, fallbackPlainText) {
    const ct = label.clutter_text;
    try {
        Pango.parse_markup(pangoMarkup, -1, '\0');
        ct.use_markup = true;
        ct.set_markup(pangoMarkup);
    } catch (_) {
        ct.use_markup = false;
        label.text = fallbackPlainText ?? '';
    }
}

function blockSignature(block) {
    if (block.type === 'code') {
        return `code:${block.lang || ''}:${block.code || ''}`;
    }
    return `text:${block.raw || ''}`;
}

function createBlockEntry(block, onCreateCopyButton) {
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
            codeValue: block.code || '',
            actor: codeCard,
            langLabel,
            textLabel: null,
        };

        const copyBtn = onCreateCopyButton(() => entry.codeValue);
        codeHeader.add_child(copyBtn);
        codeCard.add_child(codeHeader);

        const codeBody = createWrapLabel(block.code || ' ', 'qc-code-text', false);
        codeCard.add_child(codeBody);
        entry.textLabel = codeBody;
        return entry;
    }

    const lbl = createWrapLabel('', 'qc-message-text', false);
    setLabelMarkupSafe(lbl, block.pango, block.raw);
    return {
        type: 'text',
        signature: blockSignature(block),
        actor: lbl,
        textLabel: lbl,
    };
}

function updateBlockEntryInPlace(entry, block) {
    entry.signature = blockSignature(block);
    if (block.type === 'code') {
        entry.codeValue = block.code || '';
        const nextLang = block.lang || 'code';
        if (entry.langLabel.text !== nextLang) {
            entry.langLabel.text = nextLang;
        }
        const nextCode = block.code || ' ';
        if (entry.textLabel.text !== nextCode) {
            entry.textLabel.text = nextCode;
        }
    } else {
        setLabelMarkupSafe(entry.textLabel, block.pango, block.raw);
    }
}

/**
 * Incremental Markdown & Plaintext card body renderer.
 * - Freezes completed blocks (`0 .. blocks.length - 2`) so they are NEVER destroyed or recreated during streaming.
 * - Updates only the active tail block (`blocks[blocks.length - 1]`) in-place.
 * - Preserves copy button states on earlier code blocks while subsequent blocks stream.
 */
export function renderCardBodyIncremental(card, {markdownEnabled, placeholderText, onCreateCodeCopyButton}) {
    const {bodyBox, role} = card;
    const rawText = card.text || '';

    if (!card.renderState) {
        card.renderState = {
            mode: '',
            placeholderLabel: null,
            plainLabel: null,
            frozenEntries: [],
            tailEntry: null,
        };
    }
    const st = card.renderState;

    const resetBody = newMode => {
        bodyBox.destroy_all_children();
        st.mode = newMode;
        st.placeholderLabel = null;
        st.plainLabel = null;
        st.frozenEntries = [];
        st.tailEntry = null;
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

    // 2. Plaintext mode (user messages or Markdown disabled)
    if (role === 'user' || !markdownEnabled) {
        if (st.mode !== 'plain' || !st.plainLabel) {
            resetBody('plain');
            st.plainLabel = createWrapLabel(rawText, 'qc-message-text', false);
            bodyBox.add_child(st.plainLabel);
        } else if (st.plainLabel.text !== rawText) {
            st.plainLabel.text = rawText;
        }
        return;
    }

    // 3. Incremental Markdown mode
    const blocks = parseMarkdownBlocks(rawText);
    if (!blocks.length) {
        if (st.mode !== 'plain' || !st.plainLabel) {
            resetBody('plain');
            st.plainLabel = createWrapLabel(rawText, 'qc-message-text', false);
            bodyBox.add_child(st.plainLabel);
        } else if (st.plainLabel.text !== rawText) {
            st.plainLabel.text = rawText;
        }
        return;
    }

    if (st.mode !== 'markdown') {
        resetBody('markdown');
    }

    const completedCount = Math.max(0, blocks.length - 1);
    const tailBlock = blocks[blocks.length - 1];

    // If text shrunk or earlier frozen blocks diverged (e.g. full message replacement), trim from first divergence
    let divergeIdx = -1;
    const minCheck = Math.min(st.frozenEntries.length, completedCount);
    for (let i = 0; i < minCheck; i++) {
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

        // Promote existing tailEntry in-place if it matches the newly completed block's type!
        if (st.tailEntry && st.tailEntry.type === targetBlock.type) {
            updateBlockEntryInPlace(st.tailEntry, targetBlock);
            st.frozenEntries.push(st.tailEntry);
            st.tailEntry = null;
        } else {
            const entry = createBlockEntry(targetBlock, onCreateCodeCopyButton);
            if (st.tailEntry?.actor && st.tailEntry.actor.get_parent() === bodyBox) {
                bodyBox.insert_child_below(entry.actor, st.tailEntry.actor);
            } else {
                bodyBox.add_child(entry.actor);
            }
            st.frozenEntries.push(entry);
        }
    }

    // Update or create the single active tail block
    if (st.tailEntry && st.tailEntry.type === tailBlock.type) {
        if (st.tailEntry.signature !== blockSignature(tailBlock)) {
            updateBlockEntryInPlace(st.tailEntry, tailBlock);
        }
    } else {
        if (st.tailEntry) {
            try { bodyBox.remove_child(st.tailEntry.actor); st.tailEntry.actor.destroy(); } catch (_) {}
        }
        st.tailEntry = createBlockEntry(tailBlock, onCreateCodeCopyButton);
        bodyBox.add_child(st.tailEntry.actor);
    }
}
