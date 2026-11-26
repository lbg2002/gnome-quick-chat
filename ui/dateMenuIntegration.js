import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

/** Hosts chat and notifications in the same date-menu column. */
export class DateMenuIntegration {
    constructor() {
        this._button = null;
        this._embedded = null;
        this.mountMode = 'unmounted';
        this.lastMountError = '';
    }

    get menu() {
        return this._embedded?.menu ?? this._button?.menu ?? null;
    }

    mount(wrapper, tabs = null) {
        this.lastMountError = '';
        if (tabs && this._mountEmbedded(wrapper, tabs)) return true;
        return this._mountStandalone(wrapper);
    }

    _mountEmbedded(wrapper, tabs) {
        const dateMenu = Main.panel?.statusArea?.dateMenu;
        const menu = dateMenu?.menu;
        const notifications = dateMenu?._messageList;
        const columns = notifications?.get_parent?.();
        if (!(columns instanceof St.BoxLayout) || !(menu?.box instanceof St.BoxLayout)) {
            this.lastMountError = '日期菜单布局不可识别';
            return false;
        }
        let popupContent = columns;
        while (popupContent && popupContent.get_parent() !== menu.box) {
            popupContent = popupContent.get_parent();
        }
        const nativeIndex = columns.get_children().indexOf(notifications);
        const popupIndex = menu.box.get_children().indexOf(popupContent);
        if (nativeIndex < 0 || popupIndex < 0 ||
            wrapper.get_parent() || tabs.get_parent() !== wrapper) {
            this.lastMountError = '日期菜单布局不可识别';
            return false;
        }

        const slot = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            y_expand: true,
            clip_to_allocation: true,
        });

        try {
            wrapper.hide();
            columns.remove_child(notifications);
            columns.insert_child_at_index(slot, nativeIndex);
            slot.add_child(notifications);
            slot.add_child(wrapper);
            wrapper.add_style_class_name('qc-in-date-menu');
            wrapper.remove_child(tabs);
            menu.box.insert_child_at_index(tabs, popupIndex);
            tabs.add_style_class_name('qc-datemenu-tabs');
            const mount = {menu, columns, slot, notifications, wrapper, tabs,
                nativeVisibility: notifications.visible};
            this._embedded = mount;
            tabs.connect('destroy', () => { mount.tabs = null; });
            mount.nativeDestroySignal = notifications.connect('destroy', () => { mount.notifications = null; });
            this.mountMode = 'datemenu';
            wrapper.connect('destroy', () => {
                if (this._embedded?.wrapper === wrapper) this._detachEmbedded();
            });
            return true;
        } catch (error) {
            this.lastMountError = error.message;
            this._embedded = null;
            this.mountMode = 'unmounted';
            if (tabs.get_parent() === menu.box) menu.box.remove_child(tabs);
            if (!tabs.get_parent()) wrapper.insert_child_at_index(tabs, 0);
            if (wrapper.get_parent() === slot) slot.remove_child(wrapper);
            if (notifications.get_parent() === slot) slot.remove_child(notifications);
            if (!notifications.get_parent()) columns.insert_child_at_index(notifications, nativeIndex);
            slot.destroy();
            wrapper.remove_style_class_name('qc-in-date-menu');
            wrapper.show();
            return false;
        }
    }

    setDimensions(width, height) {
        if (!this._embedded) return false;
        this._embedded.slot.set_size(width, height);
        return true;
    }

    setChatVisible(visible) {
        const mount = this._embedded;
        if (!mount || mount.notifications?.get_parent() !== mount.slot) return;
        const unlocked = !Main.sessionMode?.isLocked && !Main.sessionMode?.isGreeter;
        const nativeAllowed = Main.sessionMode?.hasNotifications !== false && !Main.sessionMode?.isGreeter;
        if (mount.tabs) mount.tabs.visible = unlocked;
        mount.wrapper.visible = unlocked && visible;
        mount.notifications.visible = nativeAllowed && !mount.wrapper.visible;
        mount.slot.visible = mount.wrapper.visible || mount.notifications.visible;
    }

    _detachEmbedded() {
        const mount = this._embedded;
        this._embedded = null;
        this.mountMode = 'unmounted';
        if (mount.notifications?.get_parent() === mount.slot && mount.slot.get_parent() === mount.columns) {
            const index = mount.columns.get_children().indexOf(mount.slot);
            mount.slot.remove_child(mount.notifications);
            mount.columns.insert_child_at_index(mount.notifications, index);
            mount.notifications.visible = Main.sessionMode?.isLocked || Main.sessionMode?.isGreeter
                ? Boolean(Main.sessionMode.hasNotifications && !Main.sessionMode.isGreeter)
                : mount.nativeVisibility && Main.sessionMode?.hasNotifications !== false;
        }
        if (mount.nativeDestroySignal && mount.notifications) {
            mount.notifications.disconnect(mount.nativeDestroySignal);
        }
        mount.tabs?.destroy();
        // The wrapper can itself be delivering destroy after the native tree was torn down.
        if (mount.slot.get_parent() === mount.columns) {
            if (mount.wrapper.get_parent() === mount.slot) mount.slot.remove_child(mount.wrapper);
            mount.slot.destroy();
        }
    }

    _mountStandalone(wrapper) {
        let button = null;
        try {
            button = new PanelMenu.Button(0.5, 'Quick Chat · 随问', false);
            button.add_child(new St.Label({
                text: '✦ 随问',
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'qc-panel-fallback-label',
            }));
            button.menu.box.add_child(wrapper);
            Main.panel.addToStatusArea('quick-chat', button);
            this._button = button;
            this.mountMode = 'panel-button';
            button.connect('destroy', () => {
                if (this._button !== button) return;
                this._button = null;
                this.mountMode = 'unmounted';
            });
            return true;
        } catch (err) {
            this.lastMountError = err?.message || String(err);
            if (button && wrapper.get_parent() === button.menu.box) {
                button.menu.box.remove_child(wrapper);
            }
            button?.destroy();
            return false;
        }
    }

    unmount(wrapper) {
        if (this._embedded) this._detachEmbedded();
        const button = this._button;
        this._button = null;
        this.mountMode = 'unmounted';
        if (button && wrapper?.get_parent() === button.menu.box) {
            button.menu.box.remove_child(wrapper);
        }
        wrapper?.destroy();
        button?.destroy();
    }
}
