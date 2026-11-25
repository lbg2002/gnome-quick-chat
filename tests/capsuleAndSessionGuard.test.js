import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ChatController} from '../core/chatController.js';

const source = name => readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const noop = () => {};
const tick = () => new Promise(resolve => setImmediate(resolve));

// Execute the production classes with only native imports substituted.
function loadClass(file, name, native) {
    const code = source(file)
        .replace(/^import [\s\S]*? from ['"][^'"]+['"];$/gm, '')
        .replace(/export (default )?class /, 'class ');
    return new Function(...Object.keys(native), code + '\nreturn ' + name)(...Object.values(native));
}

function clock() {
    const tasks = new Map();
    let next = 0;
    const GLib = {
        timeout_add(_priority, _ms, fn) {
            tasks.set(++next, fn);
            return next;
        },
        source_remove: id => tasks.delete(id),
        uuid_string_random: () => 'session-' + ++next,
    };
    return {
        GLib, tasks,
        run() {
            for (const [id, fn] of [...tasks]) {
                if (tasks.delete(id)) fn();
            }
        },
    };
}

function sessionFixture() {
    const time = clock();
    const Main = {sessionMode: {isLocked: false, isGreeter: false}};
    const Extension = loadClass('extension.js', 'QuickChat', {
        Extension: class {}, Main, GLib: time.GLib,
    });
    const ext = new Extension();
    let sessionId = 'initial';
    const changed = new Map();
    const render = [];
    const started = [];
    const closed = [];
    let delayStartup = null;
    const controller = new ChatController({
        loadRuntimeEnvironment: async () => ({
            sessionId, config: {mode: 'readonly'}, workspace: '', sessionsDir: '',
        }),
        createClient: () => ({
            async startAsync(_config, _workspace, _dir, id) {
                this.id = id;
                started.push(id);
                await delayStartup;
            },
            request(command) {
                return ({get_messages: {messages: []}, get_state: {backend: 'codex'}, flush_session: {ok: true}})[command];
            },
            close() {
                if (!this.closed) closed.push(this.id);
                this.closed = true;
            },
        }),
        onStateChanged: ({sessionId: id}) => render.push(id),
        scheduleDelay(ms, fn) {
            const id = time.GLib.timeout_add(0, ms, fn);
            return () => time.GLib.source_remove(id);
        },
    });
    Object.assign(ext, {
        _enabled: true,
        _lifecycleGeneration: 42,
        _timers: new Set(),
        _settings: {
            settings_schema: {has_key: key => key === 'session-id'},
            get_string: () => sessionId,
            set_string: (_, id) => { sessionId = id; return true; },
            connect: (key, callback) => { changed.set(key, callback); return key; },
            disconnect: key => changed.delete(key),
        },
        _observedSessionId: sessionId,
        _chatController: controller,
        _rememberPreviousNonEmptySessionId: noop,
        _resetTransientComposerState: noop,
        _refreshAttachmentBarUi: noop,
        _cancelEditQuestion: noop,
        _panel: {
            chatBox: {}, setStatusIndicator: noop, toggleSessionMenu: noop,
            toggleFileAttachBar: noop, closeSlashMenu: noop, setRouteSuggestion: noop,
            renderAttachments: noop, setBusyVisual: noop, updateAiTabBadge: noop,
            flushPendingBackgroundWork: noop, dispose: noop,
        },
    });
    ext._connectSettingsSignals();
    return {
        ext, time, Main, controller, render, started, closed,
        get sessionId() { return sessionId; },
        delayStartup: promise => { delayStartup = promise; },
        notify: () => changed.get('changed::session-id')(),
    };
}

test('100 new-session switches each start one client and render history once', async () => {
    const f = sessionFixture();
    await f.ext._ensureClient();
    for (let i = 1; i <= 100; i++) {
        f.controller.scheduleConfigReconnect();
        await Promise.all([f.ext._newSession(), f.ext._newSession()]);
        f.notify(); // Deliver changed::session-id after the mutation lock was released.
        assert.equal(f.time.tasks.size, 1);
        f.time.run();
        await tick();
        f.notify();
        assert.equal(f.time.tasks.size, 0);
        assert.equal(f.started.length, i + 1);
        assert.equal(f.render.at(-1), f.sessionId);
        assert.equal(f.render.length, i + 1);
        assert.equal(f.ext._sessionSwitchInFlight, false);
    }
    assert.equal(f.closed.length, 100);
    f.ext.disable();
    assert.equal(f.closed.length, 101);
    assert.equal(f.time.tasks.size, 0);
});

test('external session changes still reconnect, while lock, logout and relogin reject stale startup', async () => {
    const f = sessionFixture();
    await f.ext._ensureClient();
    f.ext._settings.set_string('session-id', 'external');
    f.notify();
    f.time.run();
    await tick();
    assert.deepEqual(f.render, ['initial', 'external']);

    await f.ext._newSession();
    f.Main.sessionMode.isLocked = true;
    f.ext._onSessionModeUpdated(42);
    f.time.run();
    assert.equal(f.ext._sessionSwitchInFlight, false);
    assert.equal(f.controller.client, null);
    assert.equal(f.render.length, 2);

    f.Main.sessionMode.isLocked = false;
    f.ext._onSessionModeUpdated(42);
    let resolve;
    f.delayStartup(new Promise(done => { resolve = done; }));
    const pending = f.ext._ensureClient();
    await tick();
    assert.equal(f.started.length, 3);
    f.Main.sessionMode.isGreeter = true;
    f.ext._onSessionModeUpdated(42);
    f.ext.disable();
    resolve();
    await pending;
    assert.equal(f.render.length, 2);
    assert.equal(f.time.tasks.size, 0);
    const next = sessionFixture();
    next.ext._onSessionModeUpdated(42);
    await next.ext._ensureClient();
    await next.ext._newSession();
    next.time.run();
    await tick();
    assert.equal(next.render.length, 2);
    next.ext.disable();
});

test('native panel destruction cancels a queued new session before touching stale actors', async () => {
    const f = sessionFixture();
    await f.ext._ensureClient();
    await f.ext._newSession();
    assert.equal(f.time.tasks.size, 1);
    f.ext._onPanelDestroyed(42);
    f.time.run();
    await tick();
    assert.equal(await f.ext._ensureClient(), null);
    assert.equal(f.ext._sessionSwitchInFlight, false);
    assert.equal(f.controller.client, null);
    assert.equal(f.time.tasks.size, 0);
    assert.deepEqual(f.render, ['initial']);
    f.ext.disable();
});

function actorFixture({withDateMenu = false} = {}) {
    const time = clock();
    const chrome = new Set();
    const statusArea = new Map();
    let focus = null;
    const stage = {get_key_focus: () => focus, set_key_focus: actor => { focus = actor; }};
    class Actor {
        constructor(props = {}) {
            Object.assign(this, {visible: true, children: [], handlers: new Map()}, props);
        }
        connect(signal, handler) {
            const handlers = this.handlers.get(signal) ?? [];
            handlers.push(handler);
            this.handlers.set(signal, handlers);
        }
        emit(signal, ...args) {
            for (const handler of this.handlers.get(signal) ?? []) handler(this, ...args);
        }
        show() { this.visible = true; }
        hide() { this.visible = false; }
        get_parent() { return this.parent; }
        get_children() { return this.children; }
        insert_child_at_index(child, index) {
            assert.equal(child.parent, undefined);
            this.children.splice(index, 0, child);
            child.parent = this;
        }
        add_style_class_name() {}
        add_child(child) {
            assert.equal(child.parent, undefined);
            this.children.push(child);
            child.parent = this;
        }
        remove_child(child) {
            assert.equal(child.parent, this);
            this.children.splice(this.children.indexOf(child), 1);
            child.parent = undefined;
        }
        contains(actor) { return this === actor || this.children.some(child => child.contains(actor)); }
        destroy() {
            this.parent?.remove_child(this);
            this.emit('destroy');
            for (const child of [...this.children]) child.destroy();
            this.handlers.clear();
        }
        set_width(width) { this.width = width; }
        set_height(height) { this.height = height; }
        set_position(x, y) { this.position = [x, y]; }
    }
    class BoxLayout extends Actor {}
    class Label extends Actor {
        clutter_text = {};
        get_preferred_height(width) { return [16, Math.ceil(this.text.length * 12 / width) * 16]; }
    }
    class ScrollView extends Actor {
        set_child(child) {
            assert.ok(child instanceof BoxLayout, 'St.ScrollView requires StScrollable');
            this.add_child(child);
        }
    }
    class Entry extends Actor {
        constructor(props) {
            super(props);
            this.clutter_text = new Actor();
            this.add_child(this.clutter_text);
        }
        grab_key_focus() { stage.set_key_focus(this.clutter_text); }
        get_text() { return this.text; }
        set_text(text) { this.text = text; }
    }
    class PanelButton extends Actor {
        menu = {box: new BoxLayout()};
        destroy() { this.menu.box.destroy(); super.destroy(); }
    }
    const nativeDate = new BoxLayout();
    const notifications = new Actor();
    const calendar = new Actor();
    nativeDate.add_child(notifications);
    nativeDate.add_child(calendar);
    const shellMenu = {box: new BoxLayout()};
    const popupContent = new Actor();
    shellMenu.box.add_child(popupContent);
    popupContent.add_child(nativeDate);
    const Main = {
        pushModal: () => assert.fail('unexpected modal grab'),
        popModal: () => assert.fail('unexpected modal release'),
        layoutManager: {
            primaryMonitor: {x: 0, y: 0, width: 1280, height: 720},
            addChrome(actor) {
                chrome.add(actor);
                actor.connect('destroy', () => chrome.delete(actor));
            },
        },
        sessionMode: {hasNotifications: true},
        panel: {
            get statusArea() {
                assert.ok(withDateMenu, 'standalone fallback must avoid DateMenu access');
                return {dateMenu: {menu: shellMenu, _messageList: notifications}};
            },
            addToStatusArea(name, button) {
                assert.ok(!statusArea.has(name));
                statusArea.set(name, button);
                button.connect('destroy', () => statusArea.delete(name));
            },
        },
    };
    const native = {
        Main, Clutter: {Orientation: {}, ActorAlign: {}, KEY_Escape: 1}, Pango: {WrapMode: {}},
        St: {BoxLayout, Label, ScrollView, Entry, Button: Actor, PolicyType: {}},
        GLib: time.GLib, global: {stage}, PanelMenu: {Button: PanelButton},
    };
    return {native, time, chrome, statusArea, stage, shellMenu, popupContent, nativeDate, notifications, calendar, Actor};
}

test('100 capsule toggles preserve other focus, coalesce updates and release owned resources', async () => {
    const f = actorFixture();
    const Capsule = loadClass('ui/capsuleView.js', 'CapsuleView', f.native);
    const view = new Capsule({onSubmit: () => true});
    const other = new f.Actor();
    for (let i = 0; i < 100; i++) {
        view.toggle();
        assert.equal(f.chrome.size, 1);
        assert.equal(view.actor.reactive, false);
        assert.equal(f.stage.get_key_focus(), view.entry.clutter_text);
        view.entry.set_text('测试输入');
        view.entry.clutter_text.emit('activate');
        await tick();
        assert.equal(f.stage.get_key_focus(), null);
        view.trackTurn('current');
        view.recordEvent({type: 'message_update', turnId: 'stale', assistantMessageEvent: {type: 'text_delta', delta: 'ignore'}});
        assert.equal(f.time.tasks.size, 0);
        for (let j = 0; j < 20; j++) {
            view.recordEvent({type: 'message_update', turnId: 'current', assistantMessageEvent: {type: 'text_delta', delta: '字'.repeat(1000)}});
        }
        assert.equal(f.time.tasks.size, 1);
        f.time.run();
        assert.equal(view._responseLabel.text.length, 10000);
        assert.equal(view._answerViewport.height, 240);
        view.recordEvent({type: 'message_update', turnId: 'current', assistantMessageEvent: {type: 'text_delta', delta: '尾'}});
        f.stage.set_key_focus(other);
        view.toggle();
        assert.equal(f.stage.get_key_focus(), other);
        assert.equal(f.time.tasks.size, 0);
        view.reset();
        assert.equal(view.entry.get_text(), '');
        assert.equal(view._responseLabel.text, '');
        assert.equal(view._answerViewport.height, 44);
    }
    view.show();
    f.stage.set_key_focus(other);
    view.actor.destroy(); // Shell-side destruction can precede extension disable.
    assert.equal(view.actor, null);
    view.dispose();
    assert.equal(f.chrome.size, 0);
    assert.equal(f.time.tasks.size, 0);
    assert.equal(f.stage.get_key_focus(), other);
});

test('standalone panel mount and rollback preserve native notification and calendar parents', () => {
    const f = actorFixture();
    const Integration = loadClass('ui/dateMenuIntegration.js', 'DateMenuIntegration', f.native);
    for (let i = 0; i < 2; i++) {
        const integration = new Integration();
        const wrapper = new f.Actor();
        assert.equal(integration.mount(wrapper), true);
        assert.equal(wrapper.get_parent(), integration.menu.box);
        integration.unmount(wrapper);
        assert.equal(wrapper.get_parent(), undefined);
        assert.equal(f.statusArea.size, 0);
        assert.deepEqual(f.nativeDate.children, [f.notifications, f.calendar]);
    }
    f.native.Main.panel.addToStatusArea = () => { throw new Error('mount rejected'); };
    const integration = new Integration();
    const wrapper = new f.Actor();
    assert.equal(integration.mount(wrapper), false);
    assert.equal(wrapper.get_parent(), undefined);
    assert.equal(f.notifications.get_parent(), f.nativeDate);
    assert.equal(f.calendar.get_parent(), f.nativeDate);
});

test('embedded DateMenu toggles the original left column and restores it on destruction', () => {
    const f = actorFixture({withDateMenu: true});
    const Integration = loadClass('ui/dateMenuIntegration.js', 'DateMenuIntegration', f.native);
    const integration = new Integration();
    const wrapper = new f.Actor();
    const tabs = new f.Actor();
    wrapper.add_child(tabs);
    assert.equal(integration.mount(wrapper, tabs), true);
    assert.equal(integration.mountMode, 'datemenu');
    assert.equal(f.shellMenu.box.children[0], tabs);
    assert.equal(f.statusArea.size, 0);
    for (let i = 0; i < 30; i++) {
        integration.setChatVisible(true);
        assert.equal(wrapper.visible, true);
        assert.equal(f.notifications.visible, false);
        assert.deepEqual(f.nativeDate.children, [wrapper, f.notifications, f.calendar]);
        assert.equal(f.calendar.visible, true);
        integration.setChatVisible(false);
        assert.equal(f.notifications.visible, true);
        assert.equal(wrapper.visible, false);
    }
    f.native.Main.sessionMode.isLocked = true;
    integration.setChatVisible(true);
    assert.equal(wrapper.visible, false);
    assert.equal(tabs.visible, false);
    assert.equal(f.notifications.visible, true);
    f.native.Main.sessionMode.isLocked = false;
    integration.setChatVisible(true);
    tabs.destroy(); // Shell can destroy the separate tabs before the chat wrapper.
    wrapper.destroy();
    assert.equal(f.notifications.visible, true);
    assert.deepEqual(f.nativeDate.children, [f.notifications, f.calendar]);
    assert.deepEqual(f.shellMenu.box.children, [f.popupContent]);
    assert.equal(integration.mountMode, 'unmounted');
});

test('model picker has no stale DateMenu layout dependency', () => {
    assert.doesNotMatch(source('extension.js'), /nudgeLayout/);
    assert.doesNotMatch(source('ui/modelPicker.js'), /onNudgeLayout/);
});

test('experimental capsule defaults off and preferences bound titles and model names', () => {
    const schema = source('schemas/org.gnome.shell.extensions.quick-chat.gschema.xml');
    assert.match(schema, /key name="enable-experimental-capsule" type="b">\s*<default>false<\/default>/);
    assert.doesNotMatch(source('ui/capsuleView.js'), /\b(pushModal|popModal|grab_keyboard)\b|stage\.grab\(/);
    assert.match(source('prefs.js'), /compactNameCombo\(providerComboRow\)/);
    assert.match(source('prefs.js'), /compactNameCombo\(modelComboRow\)/);
    assert.match(source('ui/preferencesLayout.js'), /set_title_lines\(0\)/);
    assert.match(source('ui/preferencesLayout.js'), /set_subtitle_lines\(0\)/);
});
