import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import {
    mountChatAsLeftColumn,
    restoreChatLeftColumn,
} from '../core/safeDateMenuMount.js';

/**
 * GNOME Shell 50 integration.
 *
 * DateMenu-safe mounts ONLY our Quick Chat actor in the existing popup's
 * public St.BoxLayout. It never steals the native _messageList, toggles
 * notification visibility, or forces private layout-manager relayouts.
 * If DateMenu is incompatible, auto mode falls back to a separate button.
 */
export class DateMenuIntegration {
    constructor() {
        this.dateMenu = null;
        this.nativeMessageList = null;
        this.parentBox = null;
        this.insertIndex = -1;
        this._nativeSnapshot = null;
        this._fallbackButton = null;
        this.mounted = false;
        this.mountMode = 'unmounted'; // datemenu-safe | panel-button | unmounted
        this.lastMountError = '';
    }

    get menu() {
        return this.mountMode === 'panel-button'
            ? this._fallbackButton?.menu || null
            : this.dateMenu?.menu || null;
    }

    mount(wrapperActor, _unusedShouldForceHideNativeFn, {fallbackMode = 'auto'} = {}) {
        this.lastMountError = '';
        if (fallbackMode === 'panel-button') {
            return this._mountFallbackPanelButton(wrapperActor);
        }

        const dateMenu = Main.panel?.statusArea?.dateMenu;
        const result = mountChatAsLeftColumn(dateMenu, wrapperActor);
        if (result.ok) {
            this.dateMenu = dateMenu;
            this.parentBox = result.parentBox;
            this.nativeMessageList = result.nativeList;
            this.insertIndex = result.index;
            this._nativeSnapshot = result;
            this.mounted = true;
            this.mountMode = 'datemenu';
            return true;
        }

        this.lastMountError = '无法安全嵌入原生通知中心：' + result.reason;
        console.warn('[Quick Chat] Safe DateMenu mount unavailable: ' + result.reason);
        if (fallbackMode === 'auto') {
            return this._mountFallbackPanelButton(wrapperActor);
        }
        return false;
    }

    _mountFallbackPanelButton(wrapperActor) {
        let btn = null;
        try {
            if (!Main.panel || typeof Main.panel.addToStatusArea !== 'function') {
                this.lastMountError = this.lastMountError || '顶栏不可用';
                return false;
            }
            btn = new PanelMenu.Button(0.5, 'Quick Chat · 随问', false);
            btn.add_child(new St.Label({
                text: '✦ 随问',
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'qc-panel-fallback-label',
            }));
            btn.menu.box.add_child(wrapperActor);
            Main.panel.addToStatusArea('quick-chat', btn);
            this._fallbackButton = btn;
            this.dateMenu = btn;
            this.parentBox = btn.menu.box;
            this.nativeMessageList = null;
            this.mounted = true;
            this.mountMode = 'panel-button';
            return true;
        } catch (err) {
            this.lastMountError = err?.message || String(err);
            console.error('[Quick Chat] Standalone popup mount failed: ' + this.lastMountError);
            if (wrapperActor?.get_parent?.() === btn?.menu?.box) {
                try { btn.menu.box.remove_child(wrapperActor); } catch (_) {}
            }
            try { btn?.destroy(); } catch (_) {}
            return false;
        }
    }

    // The GNOME-owned notification tree is intentionally never manipulated.
    collapseNativeMessageExpansion() {}

    // A normal St actor insert/remove performs its own layout invalidation.
    // Manually forcing DateMenu internals to relayout caused shell freezes.
    nudgeLayout() {}

    unmount(wrapperActor) {
        if (this.mountMode === 'datemenu') {
            const recovered = restoreChatLeftColumn(this._nativeSnapshot, wrapperActor, {
                hasNotifications: Main.sessionMode?.hasNotifications !== false &&
                    !Main.sessionMode?.isGreeter && !Main.sessionMode?.isLocked,
            });
            if (!recovered) {
                console.error('[Quick Chat] Native notification left column could not be restored');
                // Never destroy a wrapper still owning GNOME's native notification actor.
                if (this.nativeMessageList?.get_parent?.() === wrapperActor) return;
            }
        } else if (this.mountMode === 'panel-button' && this._fallbackButton) {
            const box = this._fallbackButton.menu?.box;
            if (box && wrapperActor?.get_parent?.() === box) {
                try { box.remove_child(wrapperActor); } catch (_) {}
            }
            try { this._fallbackButton.destroy(); } catch (_) {}
        }

        this.mounted = false;
        this.mountMode = 'unmounted';
        try {
            wrapperActor?.remove_all_transitions?.();
            wrapperActor?.destroy?.();
        } catch (_) {}
        this._fallbackButton = null;
        this.dateMenu = null;
        this.nativeMessageList = null;
        this.parentBox = null;
        this.insertIndex = -1;
        this._nativeSnapshot = null;
    }
}
