'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSonos, coordinatorHost, describeTrack, parseStreamContent } = require('../server/sonos.js');

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
