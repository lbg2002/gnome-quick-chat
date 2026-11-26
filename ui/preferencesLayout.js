import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';

export function compactPreferenceRow(row) {
    if (row instanceof Adw.ActionRow || row instanceof Adw.ExpanderRow) {
        row.set_title_lines(0);
        row.set_subtitle_lines(0);
    }
}

function nameFactory(maxWidthChars = 24, vMargin = 2) {
    const factory = new Gtk.SignalListItemFactory();
    factory.connect('setup', (_, item) => {
        item.child = new Gtk.Label({
            xalign: 0,
            valign: Gtk.Align.CENTER,
            wrap: true,
            wrap_mode: Pango.WrapMode.WORD_CHAR,
            max_width_chars: maxWidthChars,
            margin_top: vMargin,
            margin_bottom: vMargin,
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
    row.factory = nameFactory(24, 2);
    row.list_factory = nameFactory(36, 3);
}
