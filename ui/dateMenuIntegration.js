import * as Main from 'resource:///org/gnome/shell/ui/main.js';

/**
 * Isolates all GNOME Shell 50 DateMenu private field interactions in one guarded adapter.
 * Performs strict existence checks before mounting and cleanly restores native state on unmount.
 */
export class DateMenuIntegration {
    constructor() {
        this.dateMenu = null;
        this.nativeMessageList = null;
        this.parentBox = null;
        this.insertIndex = -1;
        this.originalVisible = true;
        this._nativeVisibleGuard = 0;
        this.mounted = false;
    }

    mount(wrapperActor, shouldForceHideNativeFn) {
        const dateMenu = Main.panel?.statusArea?.dateMenu;
        if (!dateMenu || !dateMenu.menu) {
            console.warn('[Quick Chat] DateMenu unavailable on Main.panel.statusArea; skipping UI mount.');
            return false;
        }

        const nativeList = dateMenu._messageList;
        if (!nativeList || typeof nativeList.get_parent !== 'function') {
            console.warn('[Quick Chat] DateMenu._messageList structure changed; skipping UI mount safely.');
            return false;
        }

        const parent = nativeList.get_parent();
        if (!parent || typeof parent.get_children !== 'function' || typeof parent.insert_child_at_index !== 'function') {
            console.warn('[Quick Chat] DateMenu parent container incompatible; skipping UI mount safely.');
            return false;
        }

        const children = parent.get_children();
        const index = children.indexOf(nativeList);
        if (index < 0) {
            console.warn('[Quick Chat] Could not locate _messageList index in DateMenu container.');
            return false;
        }

        this.dateMenu = dateMenu;
        this.nativeMessageList = nativeList;
        this.parentBox = parent;
        this.insertIndex = index;
        this.originalVisible = Boolean(nativeList.visible);

        try {
            parent.remove_child(nativeList);
            nativeList.add_style_class_name('qc-native-clean');
            wrapperActor.add_child(nativeList);
            parent.insert_child_at_index(wrapperActor, index);

            this._nativeVisibleGuard = nativeList.connect('notify::visible', () => {
                if (this.mounted && shouldForceHideNativeFn?.() && nativeList.visible) {
                    nativeList.visible = false;
                }
            });

            this.mounted = true;
            this.nudgeLayout();
            return true;
        } catch (err) {
            console.error(`[Quick Chat] Failed to mount into DateMenu safely: ${err.message}`);
            this.unmount(wrapperActor);
            return false;
        }
    }

    collapseNativeMessageExpansion() {
        try {
            this.nativeMessageList?._messageView?.collapse?.();
        } catch (_) {}
    }

    /**
     * Safely nudges DateMenu layout allocation when switching tabs or resizing,
     * guarding internal `_frozen` access behind defensive checks.
     */
    nudgeLayout() {
        if (!this.mounted || !this.parentBox) return;
        try {
            const bin = this.parentBox.get_parent?.();
            const lm = bin?.layout_manager;
            if (lm) {
                if ('_frozen' in lm && lm._frozen) {
                    lm._frozen = false;
                }
                lm.layout_changed?.();
            }
            bin?.queue_relayout?.();
            this.parentBox.queue_relayout?.();
        } catch (_) {}
    }

    unmount(wrapperActor) {
        if (this.nativeMessageList && this._nativeVisibleGuard) {
            try { this.nativeMessageList.disconnect(this._nativeVisibleGuard); } catch (_) {}
            this._nativeVisibleGuard = 0;
        }

        if (wrapperActor && this.parentBox) {
            try {
                if (this.nativeMessageList && this.nativeMessageList.get_parent() === wrapperActor) {
                    wrapperActor.remove_child(this.nativeMessageList);
                    this.nativeMessageList.remove_style_class_name('qc-native-clean');
                    const maxIdx = this.parentBox.get_n_children?.() ?? 0;
                    const restoreIdx = Math.min(Math.max(0, this.insertIndex), maxIdx);
                    this.parentBox.insert_child_at_index(this.nativeMessageList, restoreIdx);
                    this.nativeMessageList.opacity = 255;
                    this.nativeMessageList.translation_y = 0;
                    this.nativeMessageList.visible =
                        Main.sessionMode.hasNotifications && !Main.sessionMode.isGreeter
                            ? true
                            : this.originalVisible;
                }
            } catch (err) {
                console.warn(`[Quick Chat] Error restoring native DateMenu list: ${err.message}`);
            }
        }

        this.mounted = false;
        this.nudgeLayout();
        try { wrapperActor?.destroy?.(); } catch (_) {}

        this.dateMenu = null;
        this.nativeMessageList = null;
        this.parentBox = null;
        this.insertIndex = -1;
    }
}
