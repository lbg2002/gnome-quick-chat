/**
 * GNOME DateMenu safe extension mount. Never moves, hides, or reconnects
 * signals on native calendar/notification actors. Only our actor is touched.
 * Pure JS so the ownership/rollback contract is testable without GNOME.
 */
export function mountChatAsDateMenuSibling(menuBox, wrapperActor) {
    if (!menuBox || typeof menuBox.add_child !== 'function' ||
        !wrapperActor || typeof wrapperActor.get_parent !== 'function') {
        return {ok: false, reason: 'menu_box_incompatible'};
    }
    if (wrapperActor.get_parent()) {
        return {ok: false, reason: 'wrapper_already_parented'};
    }
    try {
        // Place the chat first so it remains reachable above the native calendar
        // on small screens. All original children keep their parent and order.
        if (typeof menuBox.insert_child_at_index === 'function') {
            menuBox.insert_child_at_index(wrapperActor, 0);
        } else {
            menuBox.add_child(wrapperActor);
        }
        if (wrapperActor.get_parent() !== menuBox) {
            return {ok: false, reason: 'unexpected_parent'};
        }
        return {ok: true, parentBox: menuBox, reason: ''};
    } catch (error) {
        if (wrapperActor.get_parent?.() === menuBox) {
            try { menuBox.remove_child(wrapperActor); } catch (_) {}
        }
        return {ok: false, reason: error?.message || String(error)};
    }
}

export function unmountChatDateMenuSibling(menuBox, wrapperActor) {
    if (!menuBox || !wrapperActor) return false;
    if (wrapperActor.get_parent?.() !== menuBox) return false;
    try {
        menuBox.remove_child(wrapperActor);
        return true;
    } catch (_) {
        return false;
    }
}

/**
 * Preserve GNOME's right calendar column while placing its existing native
 * notification list under Quick Chat's left tab header. Unlike the old mount,
 * this performs no visible-signal interception, no layout-manager mutation,
 * no animation and no style mutation of the native actor. Any failure rolls
 * back both actors before returning to caller.
 */
export function mountChatAsLeftColumn(dateMenu, wrapperActor) {
    const nativeList = dateMenu?._messageList;
    const parent = nativeList?.get_parent?.();
    if (!nativeList || !parent || !wrapperActor ||
        wrapperActor.get_parent?.() ||
        typeof parent.get_children !== 'function' ||
        typeof parent.remove_child !== 'function' ||
        typeof parent.insert_child_at_index !== 'function' ||
        typeof wrapperActor.add_child !== 'function') {
        return {ok: false, reason: 'native_column_unavailable'};
    }
    const index = parent.get_children().indexOf(nativeList);
    if (index < 0) return {ok: false, reason: 'native_column_not_found'};
    const nativeVisible = Boolean(nativeList.visible);
    try {
        parent.remove_child(nativeList);
        wrapperActor.add_child(nativeList);
        parent.insert_child_at_index(wrapperActor, index);
        return {
            ok: true, parentBox: parent, nativeList,
            index, nativeVisible,
        };
    } catch (error) {
        // Roll back even a partial actor move; NEVER leave the DateMenu broken.
        try {
            if (wrapperActor.get_parent?.() === parent) parent.remove_child(wrapperActor);
            if (nativeList.get_parent?.() === wrapperActor) wrapperActor.remove_child(nativeList);
            if (!nativeList.get_parent?.()) {
                try { parent.insert_child_at_index(nativeList, index); }
                catch (_) { parent.add_child(nativeList); }
            }
            nativeList.visible = nativeVisible;
        } catch (restoreError) {
            return {ok:false,reason:'rollback_failed',error:String(restoreError)};
        }
        return {ok:false,reason:'mount_failed',error:String(error)};
    }
}

export function restoreChatLeftColumn(snapshot, wrapperActor, {hasNotifications = true} = {}) {
    if (!snapshot?.ok || !wrapperActor) return false;
    const {parentBox, nativeList, index, nativeVisible} = snapshot;
    try {
        if (wrapperActor.get_parent?.() === parentBox) parentBox.remove_child(wrapperActor);
        if (nativeList.get_parent?.() === wrapperActor) wrapperActor.remove_child(nativeList);
        if (!nativeList.get_parent?.()) parentBox.insert_child_at_index(nativeList, index);
        nativeList.visible = hasNotifications && nativeVisible;
        return nativeList.get_parent?.() === parentBox;
    } catch (_) {
        return false;
    }
}
