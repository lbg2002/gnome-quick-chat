import test from 'node:test';
import assert from 'node:assert/strict';
import {
    mountChatAsDateMenuSibling,
    unmountChatDateMenuSibling,
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

test('production integration has no native _messageList ownership or layout-manager changes', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const {fileURLToPath} = await import('node:url');
    const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../ui/dateMenuIntegration.js');
    const source = fs.readFileSync(file,'utf8');
    assert.ok(!source.includes('executeDateMenuMountTransaction('));
    assert.ok(!source.includes('._messageList'));
    assert.ok(!source.includes('layout_changed('));
    assert.match(source, /mountChatAsDateMenuSibling/);
});
