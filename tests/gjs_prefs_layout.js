// Run with a private GTK display server and GSETTINGS_BACKEND=memory.
import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';
import {compactNameCombo, compactPreferenceRow} from '../ui/preferencesLayout.js';

Adw.init();
const longName = '超长模型与服务商名称'.repeat(60) + '-long-provider-model-id'.repeat(60);
const longSubtitle = '使用相同的设置测试中文副标题和连续的标识符。'.repeat(40);
const window = new Adw.PreferencesWindow({default_width: 540, default_height: 550});
const page = new Adw.PreferencesPage({title: '界面与权限'});
const group = new Adw.PreferencesGroup({title: '模型与后端'});
const action = new Adw.ActionRow({title: longName, subtitle: longSubtitle});
const expander = new Adw.ExpanderRow({title: longName, subtitle: longSubtitle, expanded: true});
const entry = new Adw.EntryRow({title: '手动填写模型', text: longName});
const combo = new Adw.ComboRow({title: '选择 Provider', model: Gtk.StringList.new([longName])});
for (const row of [action, expander, entry, combo]) compactPreferenceRow(row);
compactNameCombo(combo);
expander.add_row(entry);
group.add(action);
group.add(expander);
group.add(combo);
page.add(group);
window.add(page);
window.present();

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function *widgets(widget) {
    yield widget;
    for (let child = widget.get_first_child(); child; child = child.get_next_sibling()) {
        yield* widgets(child);
    }
}

await new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
    resolve();
    return GLib.SOURCE_REMOVE;
}));

try {
    assert(window.get_width() === 540, 'test window expanded for the long text: ' + window.get_width());
    for (const row of [action, expander, entry, combo]) {
        const [min] = row.measure(Gtk.Orientation.HORIZONTAL, -1);
        assert(min <= 480 && row.get_width() > 0 && row.get_width() <= 540,
            `row exceeds the width budget: minimum ${min}, allocated ${row.get_width()}`);
    }
    assert(action.get_title_lines() === 1 && expander.get_title_lines() === 1, 'title line cap');
    assert(action.get_subtitle_lines() === 2 && expander.get_subtitle_lines() === 2, 'subtitle line cap');
    const label = [...widgets(combo)].find(widget => widget instanceof Gtk.Label &&
        widget.label === longName && widget.get_mapped());
    assert(label?.ellipsize === Pango.EllipsizeMode.END, 'selected combo item should ellipsize');
    assert(label.get_layout().is_ellipsized(), 'long selected name should be visually truncated');
    assert(label.tooltip_text === longName, 'full model name should remain available');
    assert(entry.text === longName, 'editable value was altered');
    print('GTK/Adw layout passed at 540 px: ActionRow, ExpanderRow, EntryRow, ComboRow.');
} finally {
    window.destroy();
}
