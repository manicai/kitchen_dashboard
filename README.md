# Kitchen Dashboard

An always-on landscape page for an old Fire HD 8 tablet. The left half shows the time,
date and weather. The right half shows, when there's something to show, which bins go
out tonight (Thursday afternoons and evenings), what the kitchen Sonos is playing with
play/pause, next-track and volume buttons, and what's on today. With nothing to show there, the
clock and weather spread across the whole screen. Weather comes from [Open-Meteo](https://open-meteo.com), which needs
no API key and is free for non-commercial use.

## Run it

```sh
npm install
npm run serve        # http://<this-computer's-ip>:8000
```

The dashboard depends on this server, so it has to run on something that stays on,
such as a Raspberry Pi or NAS, set to the same time zone as the tablet. A static host
won't work, because calendar providers don't let browsers read their feeds directly.

The weather location is stored only on the tablet.

## Add calendars

Create `calendars.json` next to this file, using `calendars.example.json` as a
starting point, then restart the server:

```json
[
  { "name": "Family", "url": "https://calendar.google.com/calendar/ical/.../basic.ics" },
  { "name": "Bins", "url": "webcal://example.com/bins.ics" }
]
```

`name` is shown beside each event when you have more than one calendar. In Google
Calendar, the address is under Settings > your calendar > "Public address in iCal format".

`calendars.json` is ignored by git and never served, because feed addresses can work
like passwords. Event titles are visible to anyone on your network who opens the page.

Feeds are fetched at most every 15 minutes. Finished events drop off the list through
the day, and an amber note names any calendar that can't be updated.

## Add the bin and Sonos widgets

Copy `widgets.example.json` to `widgets.json` and restart the server:

```json
{
  "bins": { "url": "https://servicelayer3c.azure-api.net/wastecalendar/calendar/ical/200004201579" },
  "sonos": { "room": "Kitchen" }
}
```

Leave out either section to turn that widget off. Like `calendars.json`, `widgets.json`
is ignored by git and never served.

- **Bins** reads the council's iCal feed (checked hourly) and, from noon to midnight on
  Thursdays, shows whether Friday is blue, blue and green, or black. Food waste is
  ignored because it goes every week. If a bank holiday moves the collection, it says
  so and gives the next date.
- **Sonos** finds the speakers on the local network by itself, so the server must be on
  the same network and allowed to send multicast. If discovery fails, add the IP
  address of any Sonos speaker as `"host": "192.168.1.50"`. `room` is the room name in
  the Sonos app. If the kitchen is grouped with other rooms, the buttons, volume included,
  control the whole group. The widget shows while the room is playing and for 15 minutes after it
  stops, so it can be resumed. Next is greyed out for radio, which has no next track.

### Choosing music

The quaver button (on the Sonos card, or bottom left when nothing is playing) opens a
music picker listing what was last started from it, your Sonos favourites and your Sonos
playlists. Tapping one replaces what the room (or its group) is playing.

Search covers favourites and playlists by name, plus albums, artists and tracks in a
music library shared to Sonos from a computer or NAS. Streaming services such as Spotify
can't be searched from here, because Sonos only exposes them to its own apps, so add
anything you want from them to Sonos favourites in the Sonos app.

"Played recently" is only what was started from this picker, kept in `sonos-recent.json`
next to this file. The Sonos app's own recents aren't available on the local network.

The microphone button appears only where the browser offers voice recognition on this
page. Expect it to be missing on the Fire tablet: browsers only allow the microphone on
HTTPS pages, this page is plain HTTP, and Fire tablets lack the Google speech service
that Chromium-based browsers use for it.

## Set up the tablet

1. Open the page and search for your town. To change it later, tap "Updated" and the time at the bottom right.
2. Keep the screen on: Settings > Device Options > tap Serial Number 7 times, then
   Developer Options > Stay Awake. This only applies while it's charging.
3. For true full screen, use a kiosk browser such as Fully Kiosk Browser instead of Silk.

### If it says "Can't search right now" or "Can't get the weather"

Check the Wi-Fi first. If that's fine, check the Fire OS version under Settings >
Device Options > System Updates. Open-Meteo's HTTPS certificate relies on a root
certificate that Android only gained in 7.1.1, so Fire OS 5 (Android 5.1) may refuse
the connection. Fire OS 6 and later (Android 7.1 or newer) should be fine.

## Develop

```sh
npm install
npm run check        # ES5 syntax check and unit tests
```

- `server/`: serves the page and fetches calendars. Runs on Node, so modern syntax is fine.
- `js/core.js`: pure browser logic (formatting, forecast and event shaping), covered by `test/`.
- `js/app.js`: timers, network, storage and DOM.
- `css/dashboard.css`: sized in rem from the screen's short side, so it scales as one piece.

New files the browser needs must be added to `PUBLIC_FILES` in `server/index.js`.

Browser support is the main constraint for `js/` and `css/`. Keep to ES5 and `XMLHttpRequest` (no `fetch`,
`let` or arrow functions in `js/`), and to flexbox with margins (no CSS grid, flex
`gap` or custom properties). `npm run lint:es5` catches syntax only, not newer APIs or CSS.

## License

Licensed under the GNU General Public License v3.0. See [LICENSE](LICENSE).
