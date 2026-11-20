import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

/** Owns the standalone top-bar popup. GNOME retains its entire DateMenu tree. */
export class DateMenuIntegration {
    constructor() {
        this._button = null;
        this.mountMode = 'unmounted';
        this.lastMountError = '';
    }

    get menu() {
        return this._button?.menu ?? null;
    }

    mount(wrapper) {
        let button = null;
        this.lastMountError = '';
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
