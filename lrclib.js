/* lrclib.js — thin async client for the LRCLIB public lyrics API.
 *
 * LRCLIB is a free, key-less service (https://lrclib.net/docs). It returns
 * either `syncedLyrics` (an LRC document with [mm:ss.xx] timestamps) or
 * `plainLyrics`. Nothing is cached on disk: results live in memory for the
 * lifetime of the shell session only.
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

const BASE = 'https://lrclib.net/api';
const TIMEOUT = 10;

export class LrclibClient {
    constructor(userAgent) {
        this._session = new Soup.Session({
            user_agent: userAgent,
            timeout: TIMEOUT,
        });
        this._cancellable = null;
    }

    destroy() {
        this.abort();
        this._session.abort();
        this._session = null;
    }

    abort() {
        this._cancellable?.cancel();
        this._cancellable = null;
    }

    /* Resolves to a parsed JSON object, or null when the request 404s. */
    async _get(path, params) {
        const query = Object.entries(params)
            .filter(([, v]) => v !== null && v !== undefined && v !== '')
            .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
            .join('&');

        const msg = Soup.Message.new('GET', `${BASE}/${path}?${query}`);
        const cancellable = this._cancellable;

        const bytes = await this._session.send_and_read_async(
            msg, GLib.PRIORITY_DEFAULT, cancellable);

        if (msg.get_status() === Soup.Status.NOT_FOUND)
            return null;
        if (msg.get_status() !== Soup.Status.OK)
            throw new Error(`LRCLIB returned HTTP ${msg.get_status()}`);

        const text = new TextDecoder().decode(bytes.get_data());
        return JSON.parse(text);
    }

    /* track: {artist, title, album, duration} — duration in seconds.
     * Tries the exact-match endpoint first, then falls back to a search. */
    async fetch(track) {
        this.abort();
        this._cancellable = new Gio.Cancellable();

        const exact = await this._get('get', {
            artist_name: track.artist,
            track_name: track.title,
            album_name: track.album,
            duration: track.duration > 0 ? Math.round(track.duration) : null,
        });
        if (exact)
            return exact;

        const hits = await this._get('search', {
            artist_name: track.artist,
            track_name: track.title,
        });
        if (!Array.isArray(hits) || hits.length === 0)
            return null;

        /* Prefer a hit with synced lyrics and a plausible duration. */
        const scored = hits
            .map(h => {
                let score = 0;
                if (h.syncedLyrics)
                    score += 100;
                if (track.duration > 0 && h.duration)
                    score -= Math.abs(h.duration - track.duration);
                return {hit: h, score};
            })
            .sort((a, b) => b.score - a.score);

        return scored[0].hit;
    }
}
