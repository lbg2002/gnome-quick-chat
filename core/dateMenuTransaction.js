// Pure-JS transactional DateMenu mount/rollback/restore engine (Stage E).
// Isolates all DOM/Actor mutation steps so partial failures (e.g., after removing native
// `_messageList` from its parent before `wrapperActor` is inserted) ALWAYS roll back cleanly
// without leaving GNOME Shell's DateMenu broken or mutating private `_frozen` unnecessarily.

const CLEAN_STYLE_CLASS = 'qc-native-clean';

export function captureNativeActorSnapshot(nativeList, parent, index) {
    const hadCleanClass = typeof nativeList.has_style_class_name === 'function'
        ? Boolean(nativeList.has_style_class_name(CLEAN_STYLE_CLASS))
        : false;
    return {
        parent,
        index,
        visible: Boolean(nativeList.visible),
        opacity: typeof nativeList.opacity === 'number' ? nativeList.opacity : 255,
        translation_x: typeof nativeList.translation_x === 'number' ? nativeList.translation_x : 0,
        translation_y: typeof nativeList.translation_y === 'number' ? nativeList.translation_y : 0,
        scale_x: typeof nativeList.scale_x === 'number' ? nativeList.scale_x : 1,
        scale_y: typeof nativeList.scale_y === 'number' ? nativeList.scale_y : 1,
        styleClass: typeof nativeList.style_class === 'string' ? nativeList.style_class : '',
        hadCleanClass,
    };
}

export function computeDesiredNativeVisibility(snapshot, sessionState = {}) {
    const hasNotifications = sessionState.hasNotifications !== false;
    const isLocked = Boolean(sessionState.isLocked);
    const isGreeter = Boolean(sessionState.isGreeter);
    if (!hasNotifications || isLocked || isGreeter) {
        return false;
    }
    return snapshot ? Boolean(snapshot.visible) : true;
}

export function restoreNativeActorFromSnapshot(nativeList, wrapperActor, snapshot, sessionState = {}) {
    if (!nativeList || !snapshot || !snapshot.parent) {
        return {restored: false, error: 'missing_snapshot_or_parent'};
    }

    const parent = snapshot.parent;
    try {
        const curParent = typeof nativeList.get_parent === 'function'
            ? nativeList.get_parent()
            : null;

        if (wrapperActor) {
            const wrapperParent = typeof wrapperActor.get_parent === 'function'
                ? wrapperActor.get_parent()
                : null;
            if (wrapperParent === parent && typeof parent.remove_child === 'function') {
                parent.remove_child(wrapperActor);
            }
            if (curParent === wrapperActor && typeof wrapperActor.remove_child === 'function') {
                wrapperActor.remove_child(nativeList);
            }
        } else if (curParent && curParent !== parent && typeof curParent.remove_child === 'function') {
            curParent.remove_child(nativeList);
        }

        const afterDetachParent = typeof nativeList.get_parent === 'function'
            ? nativeList.get_parent()
            : null;
        if (afterDetachParent !== parent) {
            const childCount = typeof parent.get_n_children === 'function'
                ? parent.get_n_children()
                : (typeof parent.get_children === 'function' ? parent.get_children().length : 0);
            const restoreIdx = Math.min(Math.max(0, snapshot.index), Math.max(0, childCount));
            parent.insert_child_at_index(nativeList, restoreIdx);
        }

        if (!snapshot.hadCleanClass && typeof nativeList.remove_style_class_name === 'function') {
            nativeList.remove_style_class_name(CLEAN_STYLE_CLASS);
        }
        if ('opacity' in nativeList) nativeList.opacity = snapshot.opacity;
        if ('translation_x' in nativeList) nativeList.translation_x = snapshot.translation_x;
        if ('translation_y' in nativeList) nativeList.translation_y = snapshot.translation_y;
        if ('scale_x' in nativeList) nativeList.scale_x = snapshot.scale_x;
        if ('scale_y' in nativeList) nativeList.scale_y = snapshot.scale_y;
        nativeList.visible = computeDesiredNativeVisibility(snapshot, sessionState);

        return {restored: true, error: ''};
    } catch (err) {
        return {restored: false, error: err?.message || String(err)};
    }
}

/**
 * Safely nudges parent/bin layout WITHOUT mutating private `layout_manager._frozen` by default.
 * If `allowTemporaryUnfreeze` is explicitly enabled, records and restores `_frozen` immediately.
 */
export function nudgeContainerLayoutSafely(parentBox, {allowTemporaryUnfreeze = false} = {}) {
    if (!parentBox) return;
    try {
        const bin = typeof parentBox.get_parent === 'function' ? parentBox.get_parent() : null;
        const lm = bin?.layout_manager;
        if (lm) {
            const hadFrozenProp = Object.prototype.hasOwnProperty.call(lm, '_frozen') || '_frozen' in lm;
            const prevFrozen = hadFrozenProp ? lm._frozen : undefined;
            try {
                if (allowTemporaryUnfreeze && hadFrozenProp && prevFrozen === true) {
                    lm._frozen = false;
                }
                lm.layout_changed?.();
            } finally {
                if (allowTemporaryUnfreeze && hadFrozenProp && lm._frozen !== prevFrozen) {
                    lm._frozen = prevFrozen;
                }
            }
        }
        bin?.queue_relayout?.();
        parentBox.queue_relayout?.();
    } catch (_) {}
}

/**
 * Performs an all-or-nothing transactional mount into `dateMenu`.
 * Returns `{ok, snapshot, guardSignalId, error}` and guarantees full native restoration on error.
 */
export function executeDateMenuMountTransaction({
    dateMenu,
    wrapperActor,
    shouldForceHideNativeFn,
    sessionState = {},
} = {}) {
    if (!dateMenu || !dateMenu.menu) {
        return {ok: false, reason: 'datemenu_unavailable', error: 'DateMenu unavailable on Main.panel.statusArea'};
    }
    if (!wrapperActor || typeof wrapperActor.add_child !== 'function') {
        return {ok: false, reason: 'invalid_wrapper', error: 'Invalid wrapperActor'};
    }

    const nativeList = dateMenu._messageList;
    if (!nativeList || typeof nativeList.get_parent !== 'function') {
        return {ok: false, reason: 'message_list_missing', error: 'DateMenu._messageList missing or incompatible'};
    }

    const parent = nativeList.get_parent();
    if (
        !parent ||
        typeof parent.get_children !== 'function' ||
        typeof parent.remove_child !== 'function' ||
        typeof parent.insert_child_at_index !== 'function'
    ) {
        return {ok: false, reason: 'parent_incompatible', error: 'DateMenu parent container incompatible'};
    }

    const children = parent.get_children();
    const index = Array.isArray(children) ? children.indexOf(nativeList) : -1;
    if (index < 0) {
        return {ok: false, reason: 'index_not_found', error: 'Could not locate _messageList index in DateMenu container'};
    }

    const snapshot = captureNativeActorSnapshot(nativeList, parent, index);
    let guardSignalId = 0;

    try {
        parent.remove_child(nativeList);
        if (typeof nativeList.add_style_class_name === 'function') {
            nativeList.add_style_class_name(CLEAN_STYLE_CLASS);
        }
        wrapperActor.add_child(nativeList);
        parent.insert_child_at_index(wrapperActor, index);

        if (typeof nativeList.connect === 'function') {
            guardSignalId = nativeList.connect('notify::visible', () => {
                if (shouldForceHideNativeFn?.() && nativeList.visible) {
                    nativeList.visible = false;
                }
            });
        }

        nudgeContainerLayoutSafely(parent);
        return {
            ok: true,
            snapshot,
            nativeList,
            parentBox: parent,
            insertIndex: index,
            guardSignalId,
            error: '',
        };
    } catch (err) {
        if (guardSignalId && typeof nativeList.disconnect === 'function') {
            try { nativeList.disconnect(guardSignalId); } catch (_) {}
        }
        const rollback = restoreNativeActorFromSnapshot(nativeList, wrapperActor, snapshot, sessionState);
        nudgeContainerLayoutSafely(parent);
        return {
            ok: false,
            reason: 'mount_exception',
            error: err?.message || String(err),
            rolledBack: rollback.restored,
            rollbackError: rollback.error,
        };
    }
}
