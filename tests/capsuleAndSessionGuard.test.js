import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = file => fs.readFileSync(path.join(root, file),'utf8');

test('capsule shortcut is configured, registered and handled separately from main panel', () => {
    const schema = source('schemas/org.gnome.shell.extensions.quick-chat.gschema.xml');
    const ext = source('extension.js');
    const prefs = source('prefs.js');
    assert.match(schema, /key name="capsule-shortcut"/);
    assert.match(ext, /addBinding\('capsule-shortcut'/);
    assert.match(ext, /watch\('capsule-shortcut'/);
    assert.match(ext, /_sendCapsuleQuestion/);
    assert.match(prefs, /const capsuleShortcutRow/);
});

test('capsule text stream is bounded and scheduled, does not render on every token', () => {
    const view = source('ui/capsuleView.js');
    assert.match(view, /_scheduleFlush/);
    assert.match(view, /slice\(-10000\)/);
    assert.match(view, /GLib\.timeout_add/);
    assert.match(view, /delta\?\.type === 'text_delta'/);
    assert.match(view, /delta\?\.type === 'text_replace'/);
    assert.match(view, /this\._releaseKeyboard\(\)/);
    assert.match(view, /Main\.popModal\(grab\)/);
    assert.ok(!view.includes('Mainloop.run('));
});

test('internal session transitions do not make redundant tree and backend changes', () => {
    const ext = source('extension.js');
    assert.match(ext, /keyName === 'session-id' && this\._sessionMutationLock/);
    const newSession = ext.slice(
        ext.indexOf('async _newSession()'),
        ext.indexOf('disable() {', ext.indexOf('async _newSession()'))
    );
    assert.match(newSession, /this\._scheduleIdle/);
    assert.ok(!newSession.includes('clearMessages()'));
    assert.match(newSession, /this\._chatController\.stopClient\(\)/);
});
