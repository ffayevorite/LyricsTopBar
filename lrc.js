/* lrc.js — parser for LRC timestamp documents.
 *
 * An LRC line looks like "[01:23.45] some text", and a single line may carry
 * several timestamps when the same text repeats. Metadata tags such as
 * [ar:...] or [offset:...] are handled separately from timed lines.
 */

const TIME_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const META_TAG = /^\[([a-z]+):(.*)\]$/i;

/* Returns {lines: [{time, text}], offset} sorted by time.
 * `offset` is the LRC-declared correction in seconds, following the tag
 * convention where a positive value makes every line appear earlier. It is
 * meant to be added to the playback position, not to the line times. */
export function parseLrc(text) {
    const lines = [];
    let offset = 0;

    for (const raw of text.split(/\r?\n/)) {
        const trimmed = raw.trim();
        if (!trimmed)
            continue;

        const meta = trimmed.match(META_TAG);
        if (meta && !/^\d+$/.test(meta[1])) {
            if (meta[1].toLowerCase() === 'offset') {
                const ms = parseInt(meta[2].trim(), 10);
                if (Number.isFinite(ms))
                    offset = ms / 1000;
            }
            continue;
        }

        TIME_TAG.lastIndex = 0;
        const stamps = [];
        let match;
        while ((match = TIME_TAG.exec(trimmed)) !== null) {
            const [, mm, ss, frac] = match;
            /* A two-digit fraction is centiseconds, three digits milliseconds. */
            const fractional = frac
                ? parseInt(frac, 10) / Math.pow(10, frac.length)
                : 0;
            stamps.push(parseInt(mm, 10) * 60 + parseInt(ss, 10) + fractional);
        }
        if (stamps.length === 0)
            continue;

        const body = trimmed.replace(TIME_TAG, '').trim();
        for (const time of stamps)
            lines.push({time, text: body});
    }

    lines.sort((a, b) => a.time - b.time);
    return {lines, offset};
}

/* Turns untimed lyrics into evenly spaced lines across `duration` seconds.
 * A rough approximation, only used when the user opts into plain lyrics. */
export function spreadPlain(text, duration) {
    const body = text.split(/\r?\n/).map(l => l.trim()).filter(l => l);
    if (body.length === 0 || duration <= 0)
        return [];

    const step = duration / body.length;
    return body.map((text, i) => ({time: i * step, text}));
}

/* Index of the last line whose time is <= position, or -1 before the first.
 * Binary search keeps the per-tick cost flat on long documents. */
export function lineAt(lines, position) {
    let lo = 0;
    let hi = lines.length - 1;
    let found = -1;

    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (lines[mid].time <= position) {
            found = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return found;
}
