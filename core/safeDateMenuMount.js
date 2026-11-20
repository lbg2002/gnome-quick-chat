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
