# Kitchen Dashboard

An always-on landscape page for an old Fire HD 8 tablet. The left half shows the time,
date and weather. The right half shows, when there's something to show, which bins go
out tonight (afternoons and evenings before a collection), what the kitchen Sonos is playing with
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

After an update, restart the server and the tablet reloads itself, once nothing is open
and no timers are set. To force that without a restart, for example after changing only
`js/` or `css/`, send the server a SIGHUP (`kill -HUP <pid>`).

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

## Set the weather location and widgets

Copy `widgets.example.json` to `widgets.json` and restart the server:

```json
{
  "weather": { "name": "Cambridge", "latitude": 52.2053, "longitude": 0.1218 },
  "bins": { "url": "https://servicelayer3c.azure-api.net/wastecalendar/calendar/ical/200004201579" },
  "sonos": { "room": "Kitchen" },
  "timetable": { "name": "Robbie", "file": "robbie_timetable.json" },
  "solar": { "apiKey": "...", "sn": "..." },
  "hive": { "username": "you@example.com", "password": "...", "boostTemperature": 21 }
}
```

Leave out `bins`, `sonos`, `timetable`, `solar` or `hive` to turn that widget off. Like `calendars.json`, `widgets.json`
is ignored by git and never served.

- **Weather** is for the `latitude` and `longitude` given (`name` is only used in the
  server's startup log). Without a `weather` section, or without `widgets.json`, it's Cambridge, UK.
- **Bins** reads the council's iCal feed (checked hourly) and, from noon to midnight
  on the day before any collection, shows whether it's blue, blue and green, or black.
  It goes by the feed's dates rather than a fixed weekday, so it follows collections
  that bank holidays move. Food waste is ignored because it goes every week.
- **Sonos** finds the speakers on the local network by itself, so the server must be on
  the same network and allowed to send multicast. If discovery fails, add the IP
  address of any Sonos speaker as `"host": "192.168.1.50"`. `room` is the room name in
  the Sonos app. If the kitchen is grouped with other rooms, the buttons, volume included,
  control the whole group. The widget shows while the room is playing and for 15 minutes after it
  stops, so it can be resumed. Next is greyed out for radio, which has no next track.

### Popups along the bottom

`timetable`, `solar` and `hive` each add a button at the bottom left, beside the Timer button. Tapping one covers the
dashboard with a full-screen popup, which goes back to the dashboard after two minutes
or when Close is tapped.

- **Timetable** shows a school day from `file`, a list of lessons written by
  `scripts/timetable.py` (`uv run scripts/timetable.py > robbie_timetable.json`). It
  shows today until the last lesson ends, then the next day in the file. Lessons that
  are over are dimmed, the current one is highlighted, and breaks and lunch are marked.
  The scraper only fetches this week and next, so run it again each week. The file is
  read on every tap, so a new one shows without restarting the server. `name` labels
  the button.
- **Solar** shows what the panels, house, battery and grid are doing now, today's
  totals so far, and a graph of solar, house use, export and import since midnight,
  from the FoxESS Cloud. Get an API key at
  [foxesscloud.com](https://www.foxesscloud.com) under User Profile > API Management.
  `sn` is the inverter's serial number, listed under Devices. FoxESS limits each inverter to
  about 1,440 API calls a day. Each update takes three, and the server reuses figures for
  four minutes, so a popup left open uses about 45 calls an hour. Their cloud only
  updates every five minutes anyway.
- **Heating** shows each Hive heating zone's temperature, what it's set to and whether
  it's calling for heat, and whether the hot water is on. Each has boost buttons
  (heating for 30 minutes, 1 or 2 hours to `boostTemperature`, 21° if left out; hot water
  for 30 minutes or an hour), and Stop boost while one is running, which goes back to
  the schedule or setting from before. `username` and `password` are the ones for the
  Hive app. Hive texts a code for each new sign-in, so sign in once by hand on the
  computer the server runs on:

  ```sh
  npm run hive-login
  ```

  It asks for the code and has Hive remember that computer, so the server can sign
  itself back in from then on without one. The sign-in is kept in `hive-auth.json`,
  which is ignored by git, never served, and works like a password. If the popup says
  Hive needs signing in again, run it again. The server reads Hive at most every 30
  seconds, and only while the popup is open.

### Kitchen timers

The Timer button at the bottom left is always there. It opens a grid of common times
(5, 10, 15, 25, 30 and 45 minutes, and 1, 1½ and 2 hours; 25 is picked out because
it's the one used most) and a slider for anything from 1 minute to 4 hours. The slider is
logarithmic, so the short times people set most get as much travel as the long ones. Tapping a
time starts it and goes back to the dashboard.

Up to three run at once, listed soonest first under the calendar. Each keeps its own colour
(amber, teal or violet) while it runs, fills its card with that colour for its last minute,
and when done flashes red and beeps every couple of seconds until Dismiss is tapped (the
beeping stops by itself after ten minutes; the flashing doesn't). Finishing closes any
popup so the dashboard is in view.

Each card has +5, which adds five minutes to what's left, or on a finished timer runs it
for five more from now, for "not quite done yet". Every tap adds five, so a double tap
adds ten, and the card shows how much has been added. The cards hold still for a couple
of seconds after a +5 so the second tap lands on the same one, then go back to soonest first.

Timers live on the tablet, not the server, and are kept in the browser's storage, so a
reload keeps them. Browsers only allow sound after a tap on the page, so after a reload
a timer can't beep until someone touches the screen; it still flashes. In Fully Kiosk
Browser, also check that the tablet's media volume is up.

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

1. Open the page.
2. Keep the screen on: Settings > Device Options > tap Serial Number 7 times, then
   Developer Options > Stay Awake. This only applies while it's charging.
3. For true full screen, use a kiosk browser such as Fully Kiosk Browser instead of Silk.

### If it says "Can't get the weather"

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
