import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import {
    executeDateMenuMountTransaction,
    nudgeContainerLayoutSafely,
    restoreNativeActorFromSnapshot,
} from '../core/dateMenuTransaction.js';

/**
 * GNOME Shell 50 DateMenu Integration & Fallback PanelMenu Adapter (Stage E).
 * - Uses an all-or-nothing transaction (`executeDateMenuMountTransaction`) recording full native
 *   `parent`, `index`, `visible`, `opacity`, `translation_x`, `translation_y`, `scale`, and style
 *   classes BEFORE mutating DateMenu, rolling back completely on any partial failure.
 * - Never mutates private `layout_manager._frozen` by default.
 * - Provides an optional standalone `PanelMenu.Button` fallback (`panel-fallback-mode` =
 *   `auto` | `datemenu` | `panel-button`) so Quick Chat still works cleanly without crashing
 *   GNOME Shell even if DateMenu internals change in future desktop customizations.
 */
export class DateMenuIntegration {
    constructor() {
        this.dateMenu = null;
        this.nativeMessageList = null;
        this.parentBox = null;
        this.insertIndex = -1;
        this._snapshot = null;
        this._nativeVisibleGuard = 0;
        this._fallbackButton = null;
        this.mounted = false;
        this.mountMode = 'unmounted'; // 'datemenu' | 'panel-button' | 'unmounted'
        this.lastMountError = '';
    }

    get menu() {
        if (this.mountMode === 'panel-button') {
            return this._fallbackButton?.menu || null;
        }
        return this.dateMenu?.menu || null;
    }

    _currentSessionState() {
        return {
            hasNotifications: Boolean(Main.sessionMode?.hasNotifications ?? true),
            isLocked: Boolean(Main.sessionMode?.isLocked),
            isGreeter: Boolean(Main.sessionMode?.isGreeter),
        };
    }

    mount(wrapperActor, shouldForceHideNativeFn, {fallbackMode = 'auto'} = {}) {
        this.lastMountError = '';

        // GNOME 50 safety: never reparent private native DateMenu actors.
        // In particular, replacing _messageList can cause Shell layout loops
        // that freeze the entire Wayland desktop. Keep the original calendar
        // and notifications untouched and render Quick Chat in its own popup.
        return this._mountFallbackPanelButton(wrapperActor);

        /* Disabled legacy reparenting logic (kept for historical reference):
        if (fallbackMode === 'panel-button') {
            return this._mountFallbackPanelButton(wrapperActor);
        }

        const dateMenu = Main.panel?.statusArea?.dateMenu;
        const tx = executeDateMenuMountTransaction({
            dateMenu,
            wrapperActor,
            shouldForceHideNativeFn: () => Boolean(this.mounted && shouldForceHideNativeFn?.()),
            sessionState: this._currentSessionState(),
        });

        if (tx.ok) {
            this.dateMenu = dateMenu;
            this.nativeMessageList = tx.nativeList;
            this.parentBox = tx.parentBox;
            this.insertIndex = tx.insertIndex;
            this._snapshot = tx.snapshot;
            this._nativeVisibleGuard = tx.guardSignalId;
            this.mounted = true;
            this.mountMode = 'datemenu';
            return true;
        }

        this.lastMountError = tx.error || tx.reason || 'DateMenu mount failed';
        console.warn(`[Quick Chat] DateMenu mount skipped (${tx.reason}): ${this.lastMountError}`);

        if (fallbackMode === 'auto') {
            return this._mountFallbackPanelButton(wrapperActor);
        }
        return false;
        */
    }

    _mountFallbackPanelButton(wrapperActor) {
        try {
            if (!Main.panel || typeof Main.panel.addToStatusArea !== 'function') {
                this.lastMountError = this.lastMountError || 'Main.panel.addToStatusArea unavailable';
                return false;
            }
            const btn = new PanelMenu.Button(0.5, 'Quick Chat · 随问', false);
            const label = new St.Label({
                text: '✦ 随问',
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'qc-panel-fallback-label',
            });
            btn.add_child(label);
            btn.menu.box.add_child(wrapperActor);
            Main.panel.addToStatusArea('quick-chat', btn);

            this._fallbackButton = btn;
            this.dateMenu = btn; // exposes `.menu` uniformly
            this.nativeMessageList = null;
            this.parentBox = btn.menu.box;
            this.mounted = true;
            this.mountMode = 'panel-button';
            return true;
        } catch (err) {
            this.lastMountError = err?.message || String(err);
            console.error(`[Quick Chat] Fallback PanelMenu.Button mount failed: ${this.lastMountError}`);
            try { this._fallbackButton?.destroy?.(); } catch (_) {}
            this._fallbackButton = null;
            this.mounted = false;
            this.mountMode = 'unmounted';
            return false;
        }
    }

    collapseNativeMessageExpansion() {
        try {
            this.nativeMessageList?._messageView?.collapse?.();
        } catch (_) {}
    }

    nudgeLayout() {
        if (!this.mounted || !this.parentBox) return;
        nudgeContainerLayoutSafely(this.parentBox, {allowTemporaryUnfreeze: false});
    }

    unmount(wrapperActor) {
        if (this.nativeMessageList && this._nativeVisibleGuard) {
            try { this.nativeMessageList.disconnect(this._nativeVisibleGuard); } catch (_) {}
            this._nativeVisibleGuard = 0;
        }

        if (this.mountMode === 'panel-button' && this._fallbackButton) {
            try {
                if (wrapperActor && wrapperActor.get_parent?.() === this._fallbackButton.menu?.box) {
                    this._fallbackButton.menu.box.remove_child(wrapperActor);
                }
            } catch (_) {}
            try { this._fallbackButton.destroy(); } catch (_) {}
            this._fallbackButton = null;
        } else if (this.nativeMessageList && this._snapshot) {
            try {
                this.nativeMessageList.remove_all_transitions?.();
            } catch (_) {}
            const res = restoreNativeActorFromSnapshot(
                this.nativeMessageList,
                wrapperActor,
                this._snapshot,
                this._currentSessionState()
            );
            if (!res.restored && res.error) {
                console.warn(`[Quick Chat] Error restoring native DateMenu list: ${res.error}`);
            }
            nudgeContainerLayoutSafely(this.parentBox, {allowTemporaryUnfreeze: false});
        }

        this.mounted = false;
        this.mountMode = 'unmounted';
        try {
            wrapperActor?.remove_all_transitions?.();
            wrapperActor?.destroy?.();
        } catch (_) {}

        this.dateMenu = null;
        this.nativeMessageList = null;
        this.parentBox = null;
        this.insertIndex = -1;
        this._snapshot = null;
    }
}
