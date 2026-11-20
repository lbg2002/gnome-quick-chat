import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

/** Bounded, non-modal chrome with ordinary focus inside the capsule. */
export class CapsuleView {
    constructor({onSubmit, onExpand} = {}) {
        this._onSubmit = onSubmit;
        this._onExpand = onExpand;
        this.actor = null;
        this.entry = null;
        this._responseLabel = null;
        this._responseScroll = null;
        this._answerViewport = null;
        this._answerMaxHeight = 260;
        this._status = null;
        this._buffer = '';
        this._flushId = 0;
        this._request = null;
        this._pending = false;
        this._disposed = false;
    }

    build() {
        if (this.actor || this._disposed) return;
        const root = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'qc-capsule-root',
            width: 590, reactive: false, visible: false,
        });
        this.actor = root;
        root.connect('destroy', () => {
            this._cancelFlush();
            this.actor = this.entry = this._responseLabel = this._responseScroll = null;
            this._answerViewport = this._status = this._request = null;
            this._pending = false;
            this._buffer = '';
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
            const request = this.beginAnswer();
            entry.set_text('');
            Promise.resolve().then(() => {
                if (this._request !== request) return;
                return this._onSubmit?.(text);
            }).then(streaming => {
                if (!streaming && this._request === request) {
                    this.fail('请求已结束，请展开查看详情');
                }
            }, err => {
                if (this._request === request) this.fail(err?.message || String(err));
            });
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
            overlay_scrollbars: true, x_expand: true, height: 44,
        });
        const answer = new St.Label({
            text: '', x_expand: true,
            style_class: 'qc-capsule-answer',
            x_align: Clutter.ActorAlign.START,
        });
        answer.clutter_text.line_wrap = true;
        answer.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        // St.ScrollView requires StScrollable; the label belongs inside a box.
        const content = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL, x_expand: true,
        });
        content.add_child(answer);
        scroll.set_child(content);
        response.add_child(scroll);
        root.add_child(response);

        Main.layoutManager.addChrome(root, {
            affectsStruts: false,
            trackFullscreen: false,
        });
        this.entry = entry;
        this._responseLabel = answer;
        this._responseScroll = response;
        this._answerViewport = scroll;
        this._status = status;
    }

    get isPending() {
        return this._pending;
    }

    get visible() {
        return Boolean(this.actor?.visible);
    }

    _clearOwnedFocus() {
        const focus = global.stage.get_key_focus();
        if (focus && this.actor?.contains(focus)) global.stage.set_key_focus(null);
    }

    show() {
        if (!this.actor) this.build();
        if (!this.actor) return;
        // Clamp to the active monitor; no full-stage reactive surfaces.
        const monitor = Main.layoutManager.primaryMonitor;
        if (monitor) {
            const width = Math.max(1, Math.min(590, monitor.width - 48));
            this.actor.set_width(width);
            this._answerMaxHeight = Math.max(44, Math.min(260, Math.floor(monitor.height / 3)));
            this.actor.set_position(
                Math.round(monitor.x + (monitor.width - width) / 2),
                Math.round(monitor.y + Math.max(56, monitor.height * 0.10))
            );
        }
        this._flush();
        this.actor.show();
        this.entry?.grab_key_focus();
    }

    toggle() {
        if (this.visible) this.hide();
        else this.show();
    }

    hide() {
        if (!this.actor) return;
        this._clearOwnedFocus();
        this.actor.hide();
        this._cancelFlush();
    }

    beginAnswer() {
        this._clearOwnedFocus();
        const request = this._request = {turnId: null};
        this._pending = true;
        this._buffer = '';
        this._flush();
        if (this._status) this._status.text = '正在思考 · 实时回答';
        this._responseScroll?.show();
        return request;
    }

    trackTurn(turnId) {
        if (this._request) this._request.turnId = turnId;
    }

    _cancelFlush() {
        if (!this._flushId) return;
        GLib.source_remove(this._flushId);
        this._flushId = 0;
    }

    reset() {
        this.hide();
        this._request = null;
        this._pending = false;
        this._buffer = '';
        this.entry?.set_text('');
        this._flush();
        if (this._status) this._status.text = '';
        this._responseScroll?.hide();
    }

    _flush() {
        if (!this._responseLabel || this._disposed) return;
        const text = this._buffer.slice(-10000);
        if (this._responseLabel.text !== text) this._responseLabel.text = text;
        // Measure the single wrapped label at the capsule width. Layout is
        // invalidated only when the bounded viewport changes height.
        const width = Math.max(1, this.actor.width - 64);
        const [, naturalHeight] = this._responseLabel.get_preferred_height(width);
        const height = Math.min(this._answerMaxHeight, Math.max(44, Math.ceil(naturalHeight) + 12));
        if (this._answerViewport.height !== height) this._answerViewport.set_height(height);
    }

    _scheduleFlush() {
        if (this._flushId || this._disposed || !this.visible) return;
        this._flushId = GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, 90, () => {
            this._flushId = 0;
            this._flush();
            return GLib.SOURCE_REMOVE;
        });
    }

    recordEvent(event) {
        if (!this._pending || !event?.turnId || this._request?.turnId !== event.turnId) return;
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
            this._request = null;
            this._pending = false;
            this._cancelFlush();
            if (this.visible) this._flush();
            if (this._status) {
                this._status.text = event.status === 'completed' ? '已完成 · Esc 收起'
                    : event.status === 'cancelled' ? '已停止'
                    : '回答结束 · 可展开查看详情';
            }
            if (!this._buffer && (event.errorMessage || event.message?.errorMessage)) {
                this._buffer = String(event.errorMessage || event.message.errorMessage).slice(0, 600);
                if (this.visible) this._flush();
            }
        }
    }

    fail(error) {
        this._request = null;
        this._cancelFlush();
        this._pending = false;
        this._buffer = String(error || '请求失败').slice(0, 600);
        this._flush();
        if (this._status) this._status.text = '请求失败';
        this._responseScroll?.show();
    }

    dispose() {
        this.reset();
        this._disposed = true;
        // layoutManager drops chrome tracking when this actor is destroyed.
        this.actor?.destroy();
    }
}
