# Spotify Lyrics — GNOME Shell extension

Prints the line Spotify is currently playing in the centre of the top bar.

## How it works

1. Playback state (track metadata, play/pause, position) is read from Spotify
   over MPRIS on the session bus (`org.mpris.MediaPlayer2.spotify`).
2. When the track changes, a synced lyrics document is requested from the
   [LRCLIB](https://lrclib.net/docs) public API. Only artist, title, album and
   duration are sent; there is no account or API key.
3. The position is anchored from MPRIS and extrapolated from the monotonic
   clock between reads, with a drift check every two seconds so seeks and
   pauses are picked up quickly without hammering D-Bus.
4. A timer (200 ms by default) binary-searches the parsed LRC for the line
   matching the current position and writes it to the panel label.

Nothing is written to disk: lyrics live in memory for the session only.

## Install

    make install     # symlinks into ~/.local/share/gnome-shell/extensions
    make enable

On X11 the shell can be restarted with Alt+F2, `r`, Enter. On Wayland you have
to log out and back in before a newly installed extension can be enabled.

## Starting at login

Once enabled, GNOME loads the extension automatically at every login — that is
all "start at boot" means for a shell extension, so there is no autostart file
or service to add. Enable it once:

    make enable      # or: gnome-extensions enable spotify-lyrics@onnichar.github.io

On Wayland the first enable only takes effect after the next login; from then
on it starts with every session.

## Settings

Open from the panel menu, or `gnome-extensions prefs spotify-lyrics@onnichar.github.io`.

| Setting | Meaning |
| --- | --- |
| Panel position | Which box of the top bar holds the label: left, centre or right. |
| Maximum width | Fixed pixel width of the label; longer lines are ellipsized. |
| Fall back to artist and title | What to show when a track has no lyrics. |
| Hide when empty | Free the panel space instead of showing nothing. |
| Sync offset | Seconds of correction; positive shows lines earlier. |
| Refresh interval | Milliseconds between label updates. |
| Accept unsynced lyrics | Spread plain lyrics evenly; timing is approximate. |

The panel menu also has one-click ±0.5 s nudges for tracks that drift.

## Notes and limits

- The label uses a *fixed* width (the "Maximum width" setting), not a maximum,
  so the panel never shifts as the line length changes. Short lines are centred
  inside that fixed box.
- Spotify's MPRIS `Position` is not signalled, hence the polling and drift
  correction. Some builds briefly report `0`; that value is ignored.
- LRCLIB is community-contributed, so coverage is uneven. Tracks with no
  synced document fall back to the title, or to nothing.
- In the centre box the label is inserted at index 0, so it sits to the left of
  the clock. Change the "Panel position" setting to move it out of the centre.

## Files

| File | Purpose |
| --- | --- |
| `extension.js` | MPRIS tracking, position model, panel indicator. |
| `lrclib.js` | Async LRCLIB client (exact match, then search fallback). |
| `lrc.js` | LRC parser, plain-lyrics spreading, line lookup. |
| `prefs.js` | Adwaita preferences window. |
| `schemas/` | GSettings schema. |
