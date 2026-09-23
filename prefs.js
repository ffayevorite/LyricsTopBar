import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class SpotifyLyricsPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: _('Lyrics'),
            icon_name: 'audio-headphones-symbolic',
        });
        window.add(page);

        /* ---------------------------------------------------------- Display */

        const display = new Adw.PreferencesGroup({
            title: _('Display'),
            description: _('How the line is drawn in the top bar.'),
        });
        page.add(display);

        /* Position: an enum stored as a string, mapped to a dropdown. */
        const POSITIONS = ['left', 'center', 'right'];
        const position = new Adw.ComboRow({
            title: _('Panel position'),
            subtitle: _('Which box of the top bar the label sits in.'),
            model: Gtk.StringList.new([_('Left'), _('Centre'), _('Right')]),
        });
        display.add(position);

        const syncPositionUp = () =>
            (position.selected = Math.max(0,
                POSITIONS.indexOf(settings.get_string('panel-position'))));
        syncPositionUp();
        position.connect('notify::selected', () =>
            settings.set_string('panel-position', POSITIONS[position.selected]));
        settings.connect('changed::panel-position', syncPositionUp);

        const width = new Adw.SpinRow({
            title: _('Maximum width'),
            subtitle: _('Longer lines are ellipsized at this width, in pixels.'),
            adjustment: new Gtk.Adjustment({
                lower: 120, upper: 1200, step_increment: 20, page_increment: 100,
            }),
        });
        display.add(width);

        const fallback = new Adw.SwitchRow({
            title: _('Fall back to artist and title'),
            subtitle: _('Shown when the track has no lyrics, or before the first line.'),
        });
        display.add(fallback);

        const hide = new Adw.SwitchRow({
            title: _('Hide when empty'),
            subtitle: _('Free the space when Spotify is closed or nothing can be shown.'),
        });
        display.add(hide);

        /* ----------------------------------------------------------- Timing */

        const timing = new Adw.PreferencesGroup({
            title: _('Timing'),
            description: _('Correct lyrics that run ahead of or behind the audio.'),
        });
        page.add(timing);

        const offset = new Adw.SpinRow({
            title: _('Sync offset'),
            subtitle: _('Seconds. Positive values show each line earlier.'),
            digits: 1,
            adjustment: new Gtk.Adjustment({
                lower: -10, upper: 10, step_increment: 0.1, page_increment: 0.5,
            }),
        });
        timing.add(offset);

        const tick = new Adw.SpinRow({
            title: _('Refresh interval'),
            subtitle: _('Milliseconds between updates. Lower is smoother but busier.'),
            adjustment: new Gtk.Adjustment({
                lower: 50, upper: 1000, step_increment: 50, page_increment: 100,
            }),
        });
        timing.add(tick);

        /* ---------------------------------------------------------- Sources */

        const sources = new Adw.PreferencesGroup({
            title: _('Sources'),
            description: _('Lyrics come from the LRCLIB public API (lrclib.net). ' +
                'Only the artist, title, album and duration of the current track are sent.'),
        });
        page.add(sources);

        const unsynced = new Adw.SwitchRow({
            title: _('Accept unsynced lyrics'),
            subtitle: _('Spread plain lyrics evenly over the track. Timing is approximate.'),
        });
        sources.add(unsynced);

        const bind = Gio.SettingsBindFlags.DEFAULT;
        settings.bind('max-width', width, 'value', bind);
        settings.bind('sync-offset', offset, 'value', bind);
        settings.bind('tick-interval', tick, 'value', bind);
        settings.bind('fallback-to-title', fallback, 'active', bind);
        settings.bind('hide-when-empty', hide, 'active', bind);
        settings.bind('show-unsynced', unsynced, 'active', bind);
    }
}
