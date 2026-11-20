import test from 'node:test';
import assert from 'node:assert/strict';
import {
    mountChatAsDateMenuSibling,
    unmountChatDateMenuSibling,
    mountChatAsLeftColumn,
    restoreChatLeftColumn,
} from '../core/safeDateMenuMount.js';

function actor(label, {rejectInsert = false} = {}) {
    const children = [];
    let parent = null;
    return {
        label,
        get_parent() { return parent; },
        _assignParent(value) { parent = value; },
        get_children() { return [...children]; },
        add_child(child) {
            if (child.get_parent()) throw new Error('already parented');
            children.push(child);
            child._assignParent(this);
        },
        insert_child_at_index(child, index) {
            if (rejectInsert) throw new Error('simulated layout rejection');
            if (child.get_parent()) throw new Error('already parented');
            children.splice(index, 0, child);
            child._assignParent(this);
        },
        remove_child(child) {
            const index = children.indexOf(child);
            if (index < 0) throw new Error('not owned');
            children.splice(index, 1);
            child._assignParent(null);
        },
    };
}

test('safe DateMenu mount never reparents native calendar, notifications or message list', () => {
    const box = actor('dateMenu.menu.box');
    const nativeCalendar = actor('native calendar');
    const nativeNotifications = actor('native notifications');
    box.add_child(nativeCalendar);
    box.add_child(nativeNotifications);
    const chat = actor('Quick Chat');
    const mounted = mountChatAsDateMenuSibling(box, chat);
    assert.equal(mounted.ok, true);
    assert.equal(chat.get_parent(), box);
    assert.deepEqual(box.get_children(), [chat, nativeCalendar, nativeNotifications]);
    assert.equal(nativeCalendar.get_parent(), box);
    assert.equal(nativeNotifications.get_parent(), box);
    assert.equal(unmountChatDateMenuSibling(box, chat), true);
    assert.deepEqual(box.get_children(), [nativeCalendar, nativeNotifications]);
    assert.equal(nativeCalendar.get_parent(), box);
    assert.equal(nativeNotifications.get_parent(), box);
});

test('safe DateMenu rejects invalid or already parented actors without touching native children', () => {
    const parent = actor('native menu');
    const native = actor('native');
    parent.add_child(native);
    const alreadyParented = actor('chat');
    const other = actor('other');
    other.add_child(alreadyParented);
    assert.equal(mountChatAsDateMenuSibling(parent, alreadyParented).ok, false);
    assert.deepEqual(parent.get_children(), [native]);
    assert.equal(unmountChatDateMenuSibling(parent, alreadyParented), false);
    const failing = actor('failing menu', {rejectInsert:true});
    failing.add_child(native === undefined ? actor('unused') : actor('native fixture'));
    const original = failing.get_children();
    const wrapper = actor('chat');
    assert.equal(mountChatAsDateMenuSibling(failing, wrapper).ok, false);
    assert.deepEqual(failing.get_children(), original);
    assert.equal(wrapper.get_parent(), null);
});

test('safe left column keeps right calendar untouched and restores original native layout', () => {
    const hbox = actor('native horizontal DateMenu');
    const native = actor('native notification list');
    const right = actor('native calendar');
    hbox.add_child(native);
    hbox.add_child(right);
    const wrapper = actor('Quick Chat left');
    const tabs = actor('tabs');
    const body = actor('AI body');
    wrapper.add_child(tabs);
    wrapper.add_child(body);
    native.visible = true;
    const mounted = mountChatAsLeftColumn({_messageList: native}, wrapper);
    assert.equal(mounted.ok, true);
    assert.deepEqual(hbox.get_children(), [wrapper, right]);
    assert.deepEqual(wrapper.get_children(), [tabs, body, native]);
    assert.equal(right.get_parent(), hbox);
    native.visible = false;
    assert.equal(restoreChatLeftColumn(mounted, wrapper), true);
    assert.deepEqual(hbox.get_children(), [native, right]);
    assert.equal(native.visible, true);
});

test('left column mount rollback leaves native notifications in DateMenu after insert failure', () => {
    const hbox = actor('hbox', {rejectInsert: true});
    const native = actor('native');
    const calendar = actor('calendar');
    hbox.add_child(native);
    hbox.add_child(calendar);
    const wrapper = actor('AI');
    wrapper.add_child(actor('tabs'));
    const result = mountChatAsLeftColumn({_messageList: native}, wrapper);
    assert.equal(result.ok, false);
    assert.equal(native.get_parent(), hbox);
    assert.equal(calendar.get_parent(), hbox);
    assert.equal(wrapper.get_parent(), null);
});

test('production avoids GNOME private layout mutations and visibility signal interception', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const {fileURLToPath} = await import('node:url');
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const integration = fs.readFileSync(path.join(root,'ui/dateMenuIntegration.js'),'utf8');
    const extension = fs.readFileSync(path.join(root,'extension.js'),'utf8');
    assert.ok(!integration.includes('executeDateMenuMountTransaction('));
    assert.ok(!integration.includes('layout_changed('));
    assert.ok(!integration.includes('notify::visible'));
    assert.match(integration, /mountChatAsLeftColumn/);
    // Internal session-id settings changes must not schedule a redundant reconnect.
    assert.match(extension, /keyName === 'session-id' && this\._sessionMutationLock/);
    const newSession = extension.slice(extension.indexOf('async _newSession()'), extension.indexOf('disable() {', extension.indexOf('async _newSession()')));
    assert.ok(!newSession.includes('clearMessages()'));
    assert.match(newSession, /_scheduleIdle/);
});
