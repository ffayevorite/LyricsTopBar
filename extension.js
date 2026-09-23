/* extension.js — Spotify Lyrics for GNOME Shell 45+
 *
 * Reads playback state from Spotify over MPRIS, fetches a synced lyrics
 * document for the current track, and prints the line that matches the
 * playback position in the centre of the top bar.
 */

import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {LrclibClient} from './lrclib.js';
import {parseLrc, spreadPlain, lineAt} from './lrc.js';

const BUS_NAME = 'org.mpris.MediaPlayer2.spotify';
const OBJECT_PATH = '/org/mpris/MediaPlayer2';
const PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';

/* How often the real MPRIS position is read back, in seconds. Between reads
 * the position is extrapolated from the monotonic clock, which keeps the
 * D-Bus traffic low while still following seeks within a second. */
const RESYNC_SECONDS = 2;
const DRIFT_TOLERANCE = 0.5;

const PlayerIface = `
<node>
  <interface name="org.mpris.MediaPlayer2.Player">
    <property name="Metadata" type="a{sv}" access="read"/>
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="Position" type="x" access="read"/>
    <method name="PlayPause"/>
    <method name="Next"/>
    <method name="Previous"/>
  </interface>
</node>`;

const PlayerProxy = Gio.DBusProxy.makeProxyWrapper(PlayerIface);

const LyricsIndicator = GObject.registerClass(
class LyricsIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.5, 'Spotify Lyrics', false);

        this._extension = extension;
        this._settings = extension.getSettings();

        this._label = new St.Label({
            text: '',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'spotify-lyrics-label',
        });
        this._label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this.add_child(this._label);

        this._statusItem = new PopupMenu.PopupMenuItem(_('Waiting for Spotify…'), {
            reactive: false,
            style_class: 'spotify-lyrics-status',
        });
        this.menu.addMenuItem(this._statusItem);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const earlier = new PopupMenu.PopupMenuItem(_('Shift lyrics 0.5 s earlier'));
        earlier.connect('activate', () => this._nudgeOffset(0.5));
        this.menu.addMenuItem(earlier);

        const later = new PopupMenu.PopupMenuItem(_('Shift lyrics 0.5 s later'));
        later.connect('activate', () => this._nudgeOffset(-0.5));
        this.menu.addMenuItem(later);

        this._resetItem = new PopupMenu.PopupMenuItem(_('Reset timing'));
        this._resetItem.connect('activate', () => this._settings.set_double('sync-offset', 0));
        this.menu.addMenuItem(this._resetItem);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const refresh = new PopupMenu.PopupMenuItem(_('Re-fetch lyrics'));
        refresh.connect('activate', () => this._extension.refetch());
        this.menu.addMenuItem(refresh);

        const prefs = new PopupMenu.PopupMenuItem(_('Settings'));
        prefs.connect('activate', () => this._extension.openPreferences());
        this.menu.addMenuItem(prefs);

        this._widthId = this._settings.connect('changed::max-width',
            () => this._applyWidth());
        this._applyWidth();
    }

    _nudgeOffset(delta) {
        const current = this._settings.get_double('sync-offset');
        this._settings.set_double('sync-offset',
            Math.max(-10, Math.min(10, current + delta)));
    }

    _applyWidth() {
        /* Fixed width, not max-width: the label always reserves the same space
         * so the panel centre box never shifts as the line length changes.
         * Short lines are centred inside that fixed box. */
        const width = this._settings.get_int('max-width');
        this._label.set_style(
            `width: ${width}px; min-width: ${width}px; text-align: left;`);
    }

    setText(text) {
        this._label.text = text ?? '';
    }

    setStatus(text) {
        this._statusItem.label.text = text;
    }

    destroy() {
        if (this._widthId) {
            this._settings.disconnect(this._widthId);
            this._widthId = null;
        }
        super.destroy();
    }
});

export default class SpotifyLyricsExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._client = new LrclibClient(
            `gnome-shell-spotify-lyrics/${this.metadata.version} (${this.metadata.url})`);

        this._addIndicator();

        this._proxy = null;
        this._lines = [];
        this._lrcOffset = 0;
        this._trackId = null;
        this._track = null;
        this._status = 'Stopped';
        this._lastIndex = -2;
        this._anchorPosition = 0;
        this._anchorClock = 0;
        this._sinceResync = 0;
        this._fetchGeneration = 0;

        this._settingsIds = [
            this._settings.connect('changed::tick-interval', () => this._restartTicker()),
            this._settings.connect('changed::sync-offset', () => {
                this._lastIndex = -2;
                this._render();
            }),
            this._settings.connect('changed::hide-when-empty', () => this._render()),
            this._settings.connect('changed::fallback-to-title', () => {
                this._lastIndex = -2;
                this._render();
            }),
            this._settings.connect('changed::show-unsynced', () => this.refetch()),
            this._settings.connect('changed::panel-position', () => this._addIndicator()),
            this._settings.connect('changed::panel-index', () => this._addIndicator()),
        ];

        this._watchId = Gio.bus_watch_name(
            Gio.BusType.SESSION, BUS_NAME, Gio.BusNameWatcherFlags.NONE,
            () => this._onPlayerAppeared(),
            () => this._onPlayerVanished());

        this._restartTicker();
        this._render();
    }

    disable() {
        this._stopTicker();

        if (this._watchId) {
            Gio.bus_unwatch_name(this._watchId);
            this._watchId = null;
        }
        for (const id of this._settingsIds ?? [])
            this._settings.disconnect(id);
        this._settingsIds = null;

        this._disconnectProxy();

        this._client?.destroy();
        this._client = null;

        this._indicator?.destroy();
        this._indicator = null;

        this._settings = null;
        this._lines = [];
        this._track = null;
    }

    /* (Re)creates the indicator in the configured panel box. Called on enable
     * and whenever `panel-position` changes; the old button is destroyed and a
     * fresh one built, since a status-area button cannot be reparented. */
    _addIndicator() {
        this._indicator?.destroy();

        let box = this._settings.get_string('panel-position');
        if (!['left', 'center', 'right'].includes(box))
            box = 'center';

        this._indicator = new LyricsIndicator(this);
        Main.panel.addToStatusArea(
            this.uuid, this._indicator, this._settings.get_int('panel-index'), box);

        /* A rebuild drops the cached line index, so force a redraw. */
        this._lastIndex = -2;
        this._render();
    }

    /* ---------------------------------------------------------------- MPRIS */

    _onPlayerAppeared() {
        this._disconnectProxy();

        this._proxy = new PlayerProxy(Gio.DBus.session, BUS_NAME, OBJECT_PATH,
            (proxy, error) => {
                if (error) {
                    console.error(`${this.uuid}: cannot reach Spotify: ${error.message}`);
                    return;
                }
                this._propsId = proxy.connect('g-properties-changed',
                    () => this._onPropertiesChanged());
                this._onPropertiesChanged();
                this._resyncPosition();
            });
    }

    _onPlayerVanished() {
        this._disconnectProxy();
        this._lines = [];
        this._track = null;
        this._trackId = null;
        this._status = 'Stopped';
        this._lastIndex = -2;
        this._indicator?.setStatus(_('Spotify is not running'));
        this._render();
    }

    _disconnectProxy() {
        if (this._proxy && this._propsId) {
            this._proxy.disconnect(this._propsId);
            this._propsId = null;
        }
        this._proxy = null;
    }

    _onPropertiesChanged() {
        if (!this._proxy)
            return;

        this._status = this._proxy.PlaybackStatus ?? 'Stopped';

        const metadata = this._proxy.Metadata;
        if (!metadata) {
            this._render();
            return;
        }

        const unpack = key => metadata[key]?.deepUnpack?.();
        const artists = unpack('xesam:artist');
        const track = {
            id: unpack('mpris:trackid') ?? '',
            title: unpack('xesam:title') ?? '',
            artist: Array.isArray(artists) ? artists.join(', ') : (artists ?? ''),
            album: unpack('xesam:album') ?? '',
            duration: Number(unpack('mpris:length') ?? 0) / 1e6,
        };

        /* Spotify reuses trackid across restarts, so compare the whole tuple. */
        const key = `${track.id}\u0000${track.artist}\u0000${track.title}`;
        if (key !== this._trackId) {
            this._trackId = key;
            this._track = track;
            this._lines = [];
            this._lrcOffset = 0;
            this._lastIndex = -2;
            this._anchorPosition = 0;
            this._anchorClock = GLib.get_monotonic_time() / 1e6;
            this._resyncPosition();
            this._fetchLyrics(track);
        }

        this._render();
    }

    _resyncPosition() {
        if (!this._proxy)
            return;

        Gio.DBus.session.call(
            BUS_NAME, OBJECT_PATH, 'org.freedesktop.DBus.Properties', 'Get',
            new GLib.Variant('(ss)', [PLAYER_IFACE, 'Position']),
            new GLib.VariantType('(v)'), Gio.DBusCallFlags.NONE, 2000, null,
            (connection, result) => {
                try {
                    const [variant] = connection.call_finish(result).deepUnpack();
                    this._anchorPosition = Number(variant.deepUnpack()) / 1e6;
                    this._anchorClock = GLib.get_monotonic_time() / 1e6;
                } catch (e) {
                    if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        console.debug(`${this.uuid}: position read failed: ${e.message}`);
                }
            });
    }

    _position() {
        if (this._status !== 'Playing')
            return this._anchorPosition;
        const now = GLib.get_monotonic_time() / 1e6;
        return this._anchorPosition + (now - this._anchorClock);
    }

    /* --------------------------------------------------------------- Lyrics */

    refetch() {
        if (this._track) {
            this._lines = [];
            this._lastIndex = -2;
            this._fetchLyrics(this._track);
        }
    }

    _fetchLyrics(track) {
        if (!track.title || !track.artist) {
            this._indicator?.setStatus(_('No track information'));
            return;
        }

        const generation = ++this._fetchGeneration;
        this._indicator?.setStatus(_('Looking up lyrics…'));

        this._client.fetch(track).then(result => {
            if (generation !== this._fetchGeneration)
                return;

            if (result?.syncedLyrics) {
                const {lines, offset} = parseLrc(result.syncedLyrics);
                this._lines = lines;
                this._lrcOffset = offset;
                this._indicator?.setStatus(`${lines.length} ${_('synced lines')}`);
            } else if (result?.plainLyrics && this._settings.get_boolean('show-unsynced')) {
                this._lines = spreadPlain(result.plainLyrics, track.duration);
                this._lrcOffset = 0;
                this._indicator?.setStatus(_('Unsynced lyrics (approximate timing)'));
            } else {
                this._lines = [];
                this._indicator?.setStatus(_('No lyrics found for this track'));
            }

            this._lastIndex = -2;
            this._render();
        }).catch(e => {
            if (generation !== this._fetchGeneration)
                return;
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            console.warn(`${this.uuid}: lyrics lookup failed: ${e.message}`);
            this._indicator?.setStatus(_('Lyrics lookup failed'));
            this._lines = [];
            this._render();
        });
    }

    /* --------------------------------------------------------------- Output */

    _restartTicker() {
        this._stopTicker();
        const interval = this._settings.get_int('tick-interval');
        this._tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, interval, () => {
            this._tick(interval / 1000);
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopTicker() {
        if (this._tickId) {
            GLib.Source.remove(this._tickId);
            this._tickId = null;
        }
    }

    _tick(elapsed) {
        if (this._proxy && this._status === 'Playing') {
            this._sinceResync += elapsed;
            if (this._sinceResync >= RESYNC_SECONDS) {
                this._sinceResync = 0;
                this._checkDrift();
            }
        }
        this._render();
    }

    /* Re-anchors only when the player has drifted away from the prediction,
     * which happens on seeks, buffering and after a pause. */
    _checkDrift() {
        if (!this._proxy)
            return;

        const predicted = this._position();
        Gio.DBus.session.call(
            BUS_NAME, OBJECT_PATH, 'org.freedesktop.DBus.Properties', 'Get',
            new GLib.Variant('(ss)', [PLAYER_IFACE, 'Position']),
            new GLib.VariantType('(v)'), Gio.DBusCallFlags.NONE, 2000, null,
            (connection, result) => {
                try {
                    const [variant] = connection.call_finish(result).deepUnpack();
                    const actual = Number(variant.deepUnpack()) / 1e6;
                    /* Spotify sometimes reports a frozen 0; ignore that. */
                    if (actual <= 0 && predicted > 1)
                        return;
                    if (Math.abs(actual - predicted) > DRIFT_TOLERANCE) {
                        this._anchorPosition = actual;
                        this._anchorClock = GLib.get_monotonic_time() / 1e6;
                        this._lastIndex = -2;
                    }
                } catch (e) {
                    if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        console.debug(`${this.uuid}: drift check failed: ${e.message}`);
                }
            });
    }

    _render() {
        if (!this._indicator)
            return;

        const hideWhenEmpty = this._settings.get_boolean('hide-when-empty');
        const text = this._currentText();

        this._indicator.setText(text);
        this._indicator.visible = text !== '' || !hideWhenEmpty;
    }

    _currentText() {
        if (!this._proxy || this._status === 'Stopped' || !this._track)
            return '';

        if (this._lines.length > 0) {
            const position = this._position()
                + this._lrcOffset
                + this._settings.get_double('sync-offset');
            const index = lineAt(this._lines, position);

            if (index !== this._lastIndex)
                this._lastIndex = index;

            /* Before the first timestamp, or on an intentionally blank line,
             * fall through to the track title rather than flashing empty. */
            const line = index >= 0 ? this._lines[index].text : '';
            if (line)
                return line;
        }

        if (this._settings.get_boolean('fallback-to-title'))
            return `${this._track.artist} — ${this._track.title}`;

        return '';
    }
}
