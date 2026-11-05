'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSonos, coordinatorHost, describeTrack, parseStreamContent, parseDidlItems } = require('../server/sonos.js');

function esc(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const TOPOLOGY = '<ZoneGroupState><ZoneGroups>' +
  '<ZoneGroup Coordinator="RINCON_A" ID="g1">' +
  '<ZoneGroupMember UUID="RINCON_A" Location="http://10.0.0.5:1400/xml/device_description.xml" ZoneName="Living Room"/>' +
  '<ZoneGroupMember UUID="RINCON_B" Location="http://10.0.0.6:1400/xml/device_description.xml" ZoneName="Kitchen"/>' +
  '</ZoneGroup>' +
  '<ZoneGroup Coordinator="RINCON_C" ID="g2">' +
  '<ZoneGroupMember UUID="RINCON_C" Location="http://10.0.0.7:1400/xml/device_description.xml" ZoneName="Bedroom">' +
  '<Satellite UUID="RINCON_D" ZoneName="Bedroom"/></ZoneGroupMember>' +
  '</ZoneGroup></ZoneGroups></ZoneGroupState>';

function didl(inner) {
  return '<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/">' +
    '<item>' + inner + '</item></DIDL-Lite>';
}

test('coordinatorHost follows a grouped room to its group coordinator', () => {
  assert.equal(coordinatorHost(TOPOLOGY, 'kitchen'), '10.0.0.5');
  assert.equal(coordinatorHost(TOPOLOGY, 'Bedroom'), '10.0.0.7');
  assert.equal(coordinatorHost(TOPOLOGY, 'Garage'), null);
});

test('describeTrack reads title and artist, unescaping them', () => {
  assert.deepEqual(describeTrack(didl('<dc:title>Rock &amp; Roll</dc:title><dc:creator>Led Zeppelin</dc:creator>'), ''),
    { title: 'Rock & Roll', artist: 'Led Zeppelin' });
});

test('describeTrack prefers radio stream content and falls back to the station name', () => {
  assert.deepEqual(
    describeTrack(didl('<dc:title>x-sonosapi-stream:s1234</dc:title><r:streamContent>Blur - Parklife</r:streamContent>'), ''),
    { title: 'Parklife', artist: 'Blur' });
  assert.deepEqual(
    describeTrack(didl('<dc:title>x-sonosapi-stream:s1234</dc:title><r:streamContent></r:streamContent>'),
      didl('<dc:title>BBC Radio 6 Music</dc:title>')),
    { title: 'BBC Radio 6 Music', artist: '' });
});

test('parseStreamContent understands the TYPE=SNG form', () => {
  assert.deepEqual(parseStreamContent('TYPE=SNG|TITLE Song 2|ARTIST Blur|ALBUM Blur'), { title: 'Song 2', artist: 'Blur' });
});

function fakeSpeaker(state) {
  const calls = [];
  const call = async (host, service, action, args) => {
    calls.push(host + ' ' + action + (action === 'SetRelativeGroupVolume' ? ' ' + args.Adjustment : ''));
    const responses = {
      GetZoneGroupState: '<ZoneGroupState>' + esc(TOPOLOGY) + '</ZoneGroupState>',
      GetTransportInfo: '<CurrentTransportState>' + state.transport + '</CurrentTransportState>',
      GetPositionInfo: '<TrackMetaData>' + esc(didl('<dc:title>Song 2</dc:title><dc:creator>Blur</dc:creator>')) + '</TrackMetaData>',
      GetMediaInfo: '<CurrentURIMetaData></CurrentURIMetaData>',
      GetCurrentTransportActions: '<Actions>Set, Stop, Pause, Play, Next, Previous</Actions>'
    };
    if (action === 'Pause') {
      state.transport = 'PAUSED_PLAYBACK';
    } else if (action === 'Play') {
      state.transport = 'PLAYING';
    }
    return responses[action] || '<ok/>';
  };
  return { call, calls };
}

test('status reports what the room is playing, asking the coordinator', async () => {
  const speaker = fakeSpeaker({ transport: 'PLAYING' });
  const sonos = createSonos({ room: 'Kitchen', host: '10.0.0.6', call: speaker.call });
  const status = await sonos.status();
  assert.deepEqual(status, {
    configured: true, available: true, state: 'playing', title: 'Song 2', artist: 'Blur',
    canPause: true, canNext: true, recent: true
  });
  assert.ok(speaker.calls.includes('10.0.0.6 GetZoneGroupState'));
  assert.ok(speaker.calls.includes('10.0.0.5 GetTransportInfo'));
});

test('toggle pauses then plays, and stays recent after pausing', async () => {
  const speaker = fakeSpeaker({ transport: 'PLAYING' });
  const sonos = createSonos({ room: 'Kitchen', host: '10.0.0.6', call: speaker.call });
  const paused = await sonos.command('toggle');
  assert.equal(paused.state, 'paused');
  assert.equal(paused.recent, true);
  assert.equal((await sonos.command('toggle')).state, 'playing');
});

test('volume up and down move the group volume on the coordinator', async () => {
  const speaker = fakeSpeaker({ transport: 'PLAYING' });
  const sonos = createSonos({ room: 'Kitchen', host: '10.0.0.6', call: speaker.call });
  assert.equal((await sonos.command('volume-up')).state, 'playing');
  await sonos.command('volume-down');
  assert.ok(speaker.calls.includes('10.0.0.5 SetRelativeGroupVolume 3'));
  assert.ok(speaker.calls.includes('10.0.0.5 SetRelativeGroupVolume -3'));
});

test('controls go away a while after playback stops', async () => {
  let now = 0;
  const speaker = fakeSpeaker({ transport: 'PLAYING' });
  const sonos = createSonos({ room: 'Kitchen', host: '10.0.0.6', call: speaker.call, clock: () => now });
  await sonos.status();
  await sonos.command('toggle');
  now = 16 * 60 * 1000;
  assert.equal((await sonos.status()).recent, false);
});

test('an unreachable speaker reads as unavailable, then is looked up again', async () => {
  let finds = 0;
  const sonos = createSonos({
    room: 'Kitchen',
    call: async () => { throw new Error('EHOSTUNREACH'); },
    find: async () => { finds++; return '10.0.0.9'; }
  });
  assert.deepEqual(await sonos.status(), { configured: true, available: false });
  await sonos.status();
  assert.equal(finds, 2);
});

test('without a room it reports unconfigured', async () => {
  assert.deepEqual(await createSonos({}).status(), { configured: false, available: false });
});

const FAVOURITES = '<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/">' +
  '<item id="FV:2/1" parentID="FV:2"><dc:title>BBC Radio 6 Music</dc:title><upnp:albumArtURI>https://cdn.example/6music.png</upnp:albumArtURI>' +
  '<r:description>TuneIn Station</r:description><res protocolInfo="x-sonosapi-stream:*:*:*">x-sonosapi-stream:s44491?sid=254</res>' +
  '<r:resMD>' + esc('<DIDL-Lite><item id="F00092020s44491"><dc:title>6 Music</dc:title><upnp:class>object.item.audioItem.audioBroadcast</upnp:class></item></DIDL-Lite>') + '</r:resMD></item>' +
  '<item id="FV:2/2" parentID="FV:2"><dc:title>Kitchen Disco &amp; More</dc:title><r:description>Spotify Playlist</r:description>' +
  '<res>x-rincon-cpcontainer:1006206cspotify%3aplaylist%3a123</res>' +
  '<r:resMD>' + esc('<DIDL-Lite><item id="1006206c"><upnp:class>object.container.playlistContainer</upnp:class></item></DIDL-Lite>') + '</r:resMD></item>' +
  '</DIDL-Lite>';

const ALBUMS = '<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">' +
  '<container id="A:ALBUM/Parklife" parentID="A:ALBUM"><dc:title>Parklife</dc:title><dc:creator>Blur</dc:creator>' +
  '<upnp:class>object.container.album.musicAlbum</upnp:class><upnp:albumArtURI>/getaa?u=x</upnp:albumArtURI>' +
  '<res>x-rincon-playlist:RINCON_A#A:ALBUM/Parklife</res></container></DIDL-Lite>';

function fakeLibrary() {
  const speaker = fakeSpeaker({ transport: 'STOPPED' });
  const plain = speaker.call;
  const sent = [];
  speaker.call = async (host, service, action, args) => {
    if (action === 'Browse') {
      speaker.calls.push(host + ' Browse ' + args.ObjectID);
      const results = { 'FV:2': FAVOURITES, 'A:ALBUM:park': ALBUMS };
      if (!results[args.ObjectID]) {
        throw new Error('Browse failed: HTTP 500, UPnP error 701');
      }
      return '<Result>' + esc(results[args.ObjectID]) + '</Result>';
    }
    if (/URI|Queue/.test(action)) {
      sent.push([action, args]);
    }
    return plain(host, service, action, args);
  };
  return { speaker, sent };
}

test('parseDidlItems reads favourites and library albums, making art absolute', () => {
  const [radio, playlist] = parseDidlItems(FAVOURITES, '10.0.0.5');
  assert.equal(radio.kind, 'station');
  assert.equal(radio.subtitle, 'TuneIn Station');
  assert.match(radio.metadata, /audioBroadcast/);
  assert.equal(playlist.title, 'Kitchen Disco & More');
  assert.equal(playlist.kind, 'playlist');
  const [album] = parseDidlItems(ALBUMS, '10.0.0.5');
  assert.deepEqual([album.kind, album.subtitle, album.art], ['album', 'Blur', 'http://10.0.0.5:1400/getaa?u=x']);
});

test('the library lists favourites without how to play them, and copes with no playlists', async () => {
  const { speaker } = fakeLibrary();
  const sonos = createSonos({ room: 'Kitchen', host: '10.0.0.6', call: speaker.call });
  const library = await sonos.browseLibrary();
  assert.deepEqual(library.favourites.map((item) => item.title), ['BBC Radio 6 Music', 'Kitchen Disco & More']);
  assert.deepEqual(library.playlists, []);
  assert.deepEqual(Object.keys(library.favourites[0]).sort(), ['art', 'id', 'kind', 'subtitle', 'title']);
});

test('search matches favourites by name and the music library', async () => {
  const { speaker } = fakeLibrary();
  const sonos = createSonos({ room: 'Kitchen', host: '10.0.0.6', call: speaker.call });
  assert.deepEqual((await sonos.search('park')).items.map((item) => item.id), ['A:ALBUM/Parklife']);
  assert.deepEqual((await sonos.search('disco')).items.map((item) => item.id), ['FV:2/2']);
  assert.deepEqual((await sonos.search('x')).items, []);
});

test('play starts radio directly, queues anything else, and remembers it', async () => {
  const { speaker, sent } = fakeLibrary();
  const saved = [];
  const sonos = createSonos({ room: 'Kitchen', host: '10.0.0.6', call: speaker.call, saveRecent: (items) => saved.push(items) });
  await sonos.browseLibrary();
  await sonos.play('FV:2/1');
  assert.deepEqual(sent.map((s) => s[0]), ['SetAVTransportURI']);
  assert.equal(sent[0][1].CurrentURI, 'x-sonosapi-stream:s44491?sid=254');

  sent.length = 0;
  await sonos.search('park');
  const status = await sonos.play('A:ALBUM/Parklife');
  assert.equal(status.state, 'playing');
  assert.deepEqual(sent.map((s) => s[0]), ['RemoveAllTracksFromQueue', 'AddURIToQueue', 'SetAVTransportURI']);
  assert.equal(sent[1][1].EnqueuedURI, 'x-rincon-playlist:RINCON_A#A:ALBUM/Parklife');
  assert.equal(sent[2][1].CurrentURI, 'x-rincon-queue:RINCON_A#0');
  assert.deepEqual(saved[saved.length - 1].map((item) => item.id), ['A:ALBUM/Parklife', 'FV:2/1']);
  assert.deepEqual((await sonos.browseLibrary()).recent.map((item) => item.title), ['Parklife', 'BBC Radio 6 Music']);
});

test('play refuses IDs that are not from the Sonos library', async () => {
  const { speaker } = fakeLibrary();
  const sonos = createSonos({ room: 'Kitchen', host: '10.0.0.6', call: speaker.call });
  await assert.rejects(sonos.play('http://evil.example/x.mp3'));
  await assert.rejects(sonos.play(''));
});

test('search terms are URL-encoded into the library query', async () => {
  const { speaker } = fakeLibrary();
  const sonos = createSonos({ room: 'Kitchen', host: '10.0.0.6', call: speaker.call });
  await sonos.search('a<b');
  assert.ok(speaker.calls.includes('10.0.0.5 Browse A:ALBUM:a%3Cb'));
});
