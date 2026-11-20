import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

/**
 * Independent command capsule with a brief GNOME-managed keyboard grab
 * while typing. It always releases that grab on Send, Esc, Hide and Dispose;
 * the answer waterfall is non-modal and never covers the full screen.
 * Streaming updates are bounded and coalesced to protect the Shell loop.
 */
export class CapsuleView {
    constructor({onSubmit, onExpand} = {}) {
        this._onSubmit = onSubmit;
        this._onExpand = onExpand;
        this.actor = null;
        this.entry = null;
        this._responseLabel = null;
        this._responseScroll = null;
        this._status = null;
        this._buffer = '';
        this._flushId = 0;
        this._modalGrab = null;
        this._pending = false;
        this._disposed = false;
    }

    build() {
        if (this.actor || this._disposed) return;
        const root = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'qc-capsule-root',
            width: 590, reactive: true, visible: false,
        });
        const head = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            style_class: 'qc-capsule-pill',
            x_expand: true,
        });
        head.add_child(new St.Label({
            text: '✦', style_class: 'qc-capsule-glyph',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        const entry = new St.Entry({
            hint_text: '随问 · 输入问题，Enter 发送',
            style_class: 'qc-capsule-input',
            can_focus: true, x_expand: true,
        });
        entry.clutter_text.connect('activate', () => {
            if (this._pending) return;
            const text = entry.get_text().trim();
            if (!text) return;
            this.beginAnswer();
            try {
                const p = this._onSubmit?.(text);
                p?.catch?.(err => this.fail(err?.message || String(err)));
            } catch (err) {
                this.fail(err?.message || String(err));
            }
        });
        entry.connect('button-press-event', () => {
            if (!this._modalGrab) this._acquireKeyboard();
            return Clutter.EVENT_PROPAGATE;
        });
        entry.clutter_text.connect('key-press-event', (_text, event) => {
            if (event.get_key_symbol() === Clutter.KEY_Escape) {
                this.hide();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        head.add_child(entry);
        const expand = new St.Button({
            label: '↗', style_class: 'qc-capsule-control',
            can_focus: true, reactive: true,
            accessible_name: '打开完整随问面板',
        });
        expand.connect('clicked', () => { this.hide(); this._onExpand?.(); });
        head.add_child(expand);
        const close = new St.Button({
            label: '×', style_class: 'qc-capsule-control',
            can_focus: true, reactive: true,
            accessible_name: '收起随问胶囊',
        });
        close.connect('clicked', () => this.hide());
        head.add_child(close);
        root.add_child(head);

        const response = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'qc-capsule-waterfall',
            visible: false, x_expand: true,
        });
        const status = new St.Label({
            text: '', style_class: 'qc-capsule-state',
            x_align: Clutter.ActorAlign.START,
        });
        response.add_child(status);
        const scroll = new St.ScrollView({
            style_class: 'qc-capsule-answer-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true, x_expand: true,
        });
        const answer = new St.Label({
            text: '', x_expand: true,
            style_class: 'qc-capsule-answer',
            x_align: Clutter.ActorAlign.START,
        });
        answer.clutter_text.line_wrap = true;
        answer.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        scroll.set_child(answer);
        response.add_child(scroll);
        root.add_child(response);

        Main.layoutManager.addChrome(root, {
            affectsStruts: false,
            trackFullscreen: false,
        });
        this.actor = root;
        this.entry = entry;
        this._responseLabel = answer;
        this._responseScroll = response;
        this._status = status;
    }

    get isPending() {
        return this._pending;
    }

    get visible() {
        return Boolean(this.actor?.visible);
    }

    _acquireKeyboard() {
        if (!this.actor || this._modalGrab) return;
        try {
            this._modalGrab = Main.pushModal(this.actor, {actionMode: Shell.ActionMode.NORMAL});
            this.entry?.grab_key_focus();
        } catch (err) {
            console.warn('[Quick Chat] Capsule keyboard grab unavailable: ' + err.message);
            this._modalGrab = null;
        }
    }

    _releaseKeyboard() {
        const grab = this._modalGrab;
        this._modalGrab = null;
        if (grab) {
            try { Main.popModal(grab); }
            catch (err) { console.warn('[Quick Chat] Capsule modal release: ' + err.message); }
        }
    }

    show() {
        if (!this.actor) this.build();
        if (!this.actor) return;
        // Clamp to the active monitor; no full-stage reactive surfaces.
        const monitor = Main.layoutManager.primaryMonitor;
        if (monitor) {
            const width = Math.max(320, Math.min(590, monitor.width - 48));
            this.actor.set_width(width);
            this.actor.set_position(
                Math.round(monitor.x + (monitor.width - width) / 2),
                Math.round(monitor.y + Math.max(56, monitor.height * 0.10))
            );
        }
        this.actor.show();
        this._acquireKeyboard();
    }

    toggle() {
        if (this.visible) this.hide();
        else this.show();
    }

    hide() {
        this._releaseKeyboard();
        this.actor?.hide();
    }

    beginAnswer() {
        // The response can stream while the user works in other applications.
        this._releaseKeyboard();
        this._pending = true;
        this._buffer = '';
        if (this._responseLabel) this._responseLabel.text = '';
        if (this._status) this._status.text = '正在思考 · 实时回答';
        if (this._responseScroll) this._responseScroll.show();
    }

    _flush() {
        if (!this._responseLabel || this._disposed) return;
        this._responseLabel.text = this._buffer.slice(-10000);
    }

    _scheduleFlush() {
        if (this._flushId || this._disposed) return;
        this._flushId = GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, 90, () => {
            this._flushId = 0;
            this._flush();
            return GLib.SOURCE_REMOVE;
        });
    }

    recordEvent(event) {
        if (!this._pending || !event) return;
        if (event.type === 'message_update') {
            const delta = event.assistantMessageEvent;
            if (delta?.type === 'text_delta' && delta.delta) {
                this._buffer = (this._buffer + delta.delta).slice(-10000);
                this._scheduleFlush();
            } else if (delta?.type === 'text_replace' && typeof delta.text === 'string') {
                this._buffer = delta.text.slice(-10000);
                this._scheduleFlush();
            }
        }
        if (event.type === 'turn_settled' || event.type === 'agent_settled' ||
            (event.type === 'agent_end' && event.willRetry === undefined)) {
            this._pending = false;
            this._flush();
            if (this._status) {
                this._status.text = event.status === 'completed' ? '已完成 · Esc 收起'
                    : event.status === 'cancelled' ? '已停止'
                    : '回答结束 · 可展开查看详情';
            }
            if (!this._buffer && (event.errorMessage || event.message?.errorMessage)) {
                this._buffer = String(event.errorMessage || event.message.errorMessage).slice(0, 600);
                this._flush();
            }
        }
    }

    fail(error) {
        this._pending = false;
        this._buffer = String(error || '请求失败').slice(0, 600);
        this._flush();
        if (this._status) this._status.text = '请求失败';
        this._responseScroll?.show();
    }

    dispose() {
        this._releaseKeyboard();
        this._disposed = true;
        if (this._flushId) {
            try { GLib.source_remove(this._flushId); } catch (_) {}
            this._flushId = 0;
        }
        try { this.actor?.destroy(); } catch (_) {}
        this.actor = this.entry = this._responseLabel = this._responseScroll = this._status = null;
        this._buffer = '';
        this._pending = false;
    }
}
