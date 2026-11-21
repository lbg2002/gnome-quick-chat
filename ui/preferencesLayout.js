import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';

export function compactPreferenceRow(row) {
    if (row instanceof Adw.ActionRow || row instanceof Adw.ExpanderRow) {
        row.set_title_lines(1);
        row.set_subtitle_lines(2);
    }
}

function nameFactory() {
    const factory = new Gtk.SignalListItemFactory();
    factory.connect('setup', (_, item) => {
        item.child = new Gtk.Label({
            xalign: 0,
            ellipsize: Pango.EllipsizeMode.END,
            single_line_mode: true,
            max_width_chars: 24,
        });
    });
    factory.connect('bind', (_, item) => {
        const name = item.item.string;
        item.child.label = name;
        item.child.tooltip_text = name;
    });
    return factory;
}

export function compactNameCombo(row) {
    row.factory = nameFactory();
    row.list_factory = nameFactory();
}
