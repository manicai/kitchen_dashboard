'use strict';

// Talks to Sonos speakers on the local network over their UPnP control API
// (port 1400, no account or key needed). Only does what the dashboard shows:
// what's playing in one room, play/pause, next track and volume, and starting
// something from Sonos favourites, Sonos playlists or the local music library.

const dgram = require('node:dgram');
const http = require('node:http');

const PORT = 1400;
const SOAP_TIMEOUT_MS = 5 * 1000;
const DISCOVERY_MS = 2 * 1000;
const COORDINATOR_CACHE_MS = 60 * 1000;
const STATUS_CACHE_MS = 2 * 1000;
// After playback stops, controls stay up this long so it can be resumed.
const RECENT_MS = 15 * 60 * 1000;
// How far one press of volume up or down moves it, out of 100.
const VOLUME_STEP = 3;

const AV = { path: '/MediaRenderer/AVTransport/Control', urn: 'urn:schemas-upnp-org:service:AVTransport:1' };
// Group volume, so a grouped room turns the whole group up, as the Sonos app does.
const GROUP_VOLUME = { path: '/MediaRenderer/GroupRenderingControl/Control', urn: 'urn:schemas-upnp-org:service:GroupRenderingControl:1' };
const TOPOLOGY = { path: '/ZoneGroupTopology/Control', urn: 'urn:schemas-upnp-org:service:ZoneGroupTopology:1' };
const CONTENT = { path: '/MediaServer/ContentDirectory/Control', urn: 'urn:schemas-upnp-org:service:ContentDirectory:1' };

// How many of each list the music picker gets. The speakers page at 100 anyway.
const BROWSE_LIMIT = 100;
const SEARCH_LIMIT = 15;
const RECENT_LIMIT = 8;
const LIBRARY_CACHE_MS = 60 * 1000;
// Played by replacing what's playing, not through the queue: radio and other streams.
const STREAM_URI = /^(x-sonosapi-stream|x-sonosapi-radio|x-sonosapi-hls|x-rincon-mp3radio|hls-radio|aac):/i;
// Object IDs the picker may ask to play: favourites, Sonos playlists and the music library.
const PLAYABLE_ID = /^(FV:2\/|SQ:\d|A:)/;

function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function unescapeXml(text) {
  return String(text)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// Text of the first <tag> in `xml`, unescaped. Tags may carry a namespace prefix.
function tagText(xml, tag) {
  const match = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '>').exec(xml);
  return match ? unescapeXml(match[1]).trim() : '';
}

function attributes(text) {
  const attrs = {};
  const re = /([\w:]+)="([^"]*)"/g;
  let match;
  while ((match = re.exec(text))) {
    attrs[match[1]] = unescapeXml(match[2]);
  }
  return attrs;
}

// The host and UUID of `room`'s group coordinator, which is the speaker that has
// to be asked about and told what to play when rooms are grouped.
function findCoordinator(zoneGroupState, room) {
  const wanted = room.trim().toLowerCase();
  const groupRe = /<ZoneGroup\b([^>]*)>([\s\S]*?)<\/ZoneGroup>/g;
  let group;
  while ((group = groupRe.exec(zoneGroupState))) {
    const coordinator = attributes(group[1]).Coordinator;
    const members = [];
    const memberRe = /<ZoneGroupMember\b([^>]*?)\/?>/g;
    let member;
    while ((member = memberRe.exec(group[2]))) {
      members.push(attributes(member[1]));
    }
    if (members.some((m) => (m.ZoneName || '').trim().toLowerCase() === wanted)) {
      const lead = members.find((m) => m.UUID === coordinator);
      return lead && lead.Location ? { host: new URL(lead.Location).hostname, uuid: coordinator } : null;
    }
  }
  return null;
}

function coordinatorHost(zoneGroupState, room) {
  const found = findCoordinator(zoneGroupState, room);
  return found ? found.host : null;
}

// Radio and some services put the track in streamContent, either as
// "Artist - Title" or as "TYPE=SNG|TITLE x|ARTIST y|ALBUM z".
function parseStreamContent(text) {
  if (/^TYPE=SNG\|/.test(text)) {
    const fields = {};
    text.split('|').forEach((part) => {
      const space = part.indexOf(' ');
      if (space > 0) {
        fields[part.slice(0, space)] = part.slice(space + 1).trim();
      }
    });
    return { title: fields.TITLE || '', artist: fields.ARTIST || '' };
  }
  const split = text.indexOf(' - ');
  return split > 0 ?
    { title: text.slice(split + 3).trim(), artist: text.slice(0, split).trim() } :
    { title: text, artist: '' };
}

function looksLikeUri(text) {
  return /^[a-z][\w+.-]*:\S*$/i.test(text) && !/\s/.test(text);
}

// Title and artist from GetPositionInfo's TrackMetaData (DIDL-Lite), falling back
// to the station or source name from GetMediaInfo.
function describeTrack(trackMetaDidl, mediaMetaDidl) {
  const stream = tagText(trackMetaDidl, 'r:streamContent');
  let title = tagText(trackMetaDidl, 'dc:title');
  let artist = tagText(trackMetaDidl, 'dc:creator') || tagText(trackMetaDidl, 'upnp:artist');

  if (stream && !/^ZPSTR_/.test(stream)) {
    const parsed = parseStreamContent(stream);
    title = parsed.title;
    artist = parsed.artist || artist;
  }
  if (!title || looksLikeUri(title)) {
    title = tagText(mediaMetaDidl, 'dc:title');
    if (looksLikeUri(title)) {
      title = '';
    }
  }
  return { title, artist };
}

function soapEnvelope(service, action, args) {
  const body = Object.keys(args).map((key) => '<' + key + '>' + escapeXml(args[key]) + '</' + key + '>').join('');
  return '<?xml version="1.0" encoding="utf-8"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
    's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>' +
    '<u:' + action + ' xmlns:u="' + service.urn + '">' + body + '</u:' + action + '>' +
    '</s:Body></s:Envelope>';
}

function soap(host, service, action, args) {
  const payload = soapEnvelope(service, action, args || {});
  return new Promise((resolve, reject) => {
    const req = http.request({
      host,
      port: PORT,
      path: service.path,
      method: 'POST',
      timeout: SOAP_TIMEOUT_MS,
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        'Content-Length': Buffer.byteLength(payload),
        SOAPACTION: '"' + service.urn + '#' + action + '"'
      }
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        text += chunk;
      });
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(text);
        } else {
          const code = tagText(text, 'errorCode');
          reject(new Error(action + ' failed: HTTP ' + res.statusCode + (code ? ', UPnP error ' + code : '')));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error(action + ' timed out')));
    req.on('error', reject);
    req.end(payload);
  });
}

// Finds any Sonos speaker by SSDP; it doesn't matter which, as each one knows
// the whole household's layout.
function discover() {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    const message = Buffer.from([
      'M-SEARCH * HTTP/1.1',
      'HOST: 239.255.255.250:1900',
      'MAN: "ssdp:discover"',
      'MX: 1',
      'ST: urn:schemas-upnp-org:device:ZonePlayer:1',
      '', ''
    ].join('\r\n'));
    let done = false;
    function finish(err, host) {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timer);
      socket.close();
      if (err) {
        reject(err);
      } else {
        resolve(host);
      }
    }
    const timer = setTimeout(() => finish(new Error('No Sonos speaker answered')), DISCOVERY_MS);
    socket.on('message', (msg, rinfo) => {
      if (/sonos/i.test(String(msg))) {
        finish(null, rinfo.address);
      }
    });
    socket.on('error', (err) => finish(err));
    socket.bind(() => {
      socket.send(message, 1900, '239.255.255.250', (err) => {
        if (err) {
          finish(err);
        }
      });
    });
  });
}

// The items and containers in a ContentDirectory Browse result, each with what
// the picker shows and what's needed to play it. `art` is made absolute against
// `host`, since the speaker serves library artwork itself.
function parseDidlItems(didl, host) {
  const items = [];
  const re = /<(item|container)\b([^>]*)>([\s\S]*?)<\/\1>/g;
  let match;
  while ((match = re.exec(didl))) {
    const attrs = attributes(match[2]);
    const inner = match[3];
    const resMD = tagText(inner, 'r:resMD');
    const upnpClass = tagText(resMD || inner, 'upnp:class');
    let art = tagText(inner, 'upnp:albumArtURI');
    if (art && art.charAt(0) === '/') {
      art = 'http://' + host + ':' + PORT + art;
    }
    items.push({
      id: attrs.id || '',
      title: tagText(inner, 'dc:title'),
      subtitle: tagText(inner, 'dc:creator') || tagText(inner, 'upnp:artist') || tagText(inner, 'r:description'),
      kind: kindOf(upnpClass, attrs.id || ''),
      art: /^https?:\/\//i.test(art) ? art : '',
      uri: tagText(inner, 'res'),
      // Favourites carry their own metadata; anything else is described by itself.
      metadata: resMD || '<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
        'xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/" ' +
        'xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/">' + match[0] + '</DIDL-Lite>'
    });
  }
  return items;
}

function kindOf(upnpClass, id) {
  if (/audioBroadcast/i.test(upnpClass)) {
    return 'station';
  }
  if (/musicAlbum/i.test(upnpClass)) {
    return 'album';
  }
  if (/musicArtist|person/i.test(upnpClass)) {
    return 'artist';
  }
  if (/playlist/i.test(upnpClass) || /^SQ:/.test(id)) {
    return 'playlist';
  }
  if (/audioItem|musicTrack/i.test(upnpClass)) {
    return 'track';
  }
  return '';
}

// What the browser is sent about an item: nothing it would need to play it.
function publicItem(item) {
  return { id: item.id, title: item.title, subtitle: item.subtitle, kind: item.kind, art: item.art };
}

function matches(item, query) {
  return (item.title + ' ' + item.subtitle).toLowerCase().indexOf(query.toLowerCase()) !== -1;
}

function createSonos({ room, host, call = soap, find = discover, clock = Date.now,
  loadRecent = () => [], saveRecent = () => {} }) {
  let seedHost = host || null;
  let coordinator = null;
  let coordinatorUuid = '';
  let coordinatorAt = 0;
  let recentlyPicked = [];
  try {
    recentlyPicked = (loadRecent() || []).filter((item) => item && item.id && item.uri).slice(0, RECENT_LIMIT);
  } catch (err) {
    console.error('Sonos: could not read recently played: ' + err.message);
  }
  // Every item the picker has been shown, by ID, so playing one needn't look it up again.
  let known = new Map();
  let library = null;
  let libraryAt = 0;
  let cached = null;
  let cachedAt = 0;
  let pending = null;
  let lastPlayingAt = 0;

  function forget() {
    coordinator = null;
    cached = null;
    if (!host) {
      seedHost = null;
    }
  }

  async function resolveCoordinator() {
    if (coordinator && clock() - coordinatorAt < COORDINATOR_CACHE_MS) {
      return coordinator;
    }
    if (!seedHost) {
      seedHost = await find();
    }
    const response = await call(seedHost, TOPOLOGY, 'GetZoneGroupState');
    const found = findCoordinator(tagText(response, 'ZoneGroupState'), room);
    if (!found) {
      throw new Error('No Sonos room called "' + room + '"');
    }
    coordinator = found.host;
    coordinatorUuid = found.uuid;
    coordinatorAt = clock();
    return coordinator;
  }

  async function read() {
    const target = await resolveCoordinator();
    const args = { InstanceID: 0 };
    const [transport, position, media, actions] = await Promise.all([
      call(target, AV, 'GetTransportInfo', args),
      call(target, AV, 'GetPositionInfo', args),
      call(target, AV, 'GetMediaInfo', args),
      call(target, AV, 'GetCurrentTransportActions', args)
    ]);
    const raw = tagText(transport, 'CurrentTransportState');
    const state = raw === 'PLAYING' || raw === 'TRANSITIONING' ? 'playing' :
      raw === 'PAUSED_PLAYBACK' ? 'paused' : 'stopped';
    const allowed = tagText(actions, 'Actions').split(/\s*,\s*/);
    const track = describeTrack(tagText(position, 'TrackMetaData'), tagText(media, 'CurrentURIMetaData'));

    if (state === 'playing') {
      lastPlayingAt = clock();
    }
    return {
      configured: true,
      available: true,
      state,
      title: track.title,
      artist: track.artist,
      canPause: allowed.indexOf('Pause') !== -1,
      canNext: allowed.indexOf('Next') !== -1,
      recent: state === 'playing' || (lastPlayingAt > 0 && clock() - lastPlayingAt < RECENT_MS)
    };
  }

  async function status() {
    if (!room) {
      return { configured: false, available: false };
    }
    if (cached && clock() - cachedAt < STATUS_CACHE_MS) {
      return cached;
    }
    if (!pending) {
      pending = read().then((result) => {
        cached = result;
        cachedAt = clock();
        return result;
      }, (err) => {
        forget();
        console.error('Sonos: ' + err.message);
        return { configured: true, available: false };
      }).finally(() => {
        pending = null;
      });
    }
    return pending;
  }

  // `name` is "toggle", "next", "volume-up" or "volume-down". Resolves to the new status.
  async function command(name) {
    const current = await status();
    if (!current.available) {
      throw new Error('Sonos is not available');
    }
    const target = await resolveCoordinator();
    const args = { InstanceID: 0 };
    try {
      if (name === 'volume-up' || name === 'volume-down') {
        await call(target, GROUP_VOLUME, 'SetRelativeGroupVolume',
          { InstanceID: 0, Adjustment: name === 'volume-up' ? VOLUME_STEP : -VOLUME_STEP });
      } else if (name === 'next') {
        await call(target, AV, 'Next', args);
      } else if (current.state !== 'playing') {
        await call(target, AV, 'Play', { InstanceID: 0, Speed: 1 });
      } else {
        await call(target, AV, current.canPause ? 'Pause' : 'Stop', args);
      }
    } catch (err) {
      forget();
      throw err;
    }
    cached = null;
    await pending; // A read started before the command would be stale.
    cached = null;
    return status();
  }

  async function browse(target, objectId, flag, count) {
    const response = await call(target, CONTENT, 'Browse', {
      ObjectID: objectId,
      BrowseFlag: flag || 'BrowseDirectChildren',
      Filter: '*',
      StartingIndex: 0,
      RequestedCount: count || BROWSE_LIMIT,
      SortCriteria: ''
    });
    const items = parseDidlItems(tagText(response, 'Result'), target).filter((item) => item.id && item.uri);
    if (known.size > 2000) {
      known = new Map();
    }
    items.forEach((item) => known.set(item.id, item));
    return items;
  }

  // A household may not have favourites, playlists or a music library, and a
  // speaker refuses to browse what isn't there, so each list fails on its own.
  async function browseOrEmpty(target, objectId, count) {
    try {
      return await browse(target, objectId, 'BrowseDirectChildren', count);
    } catch (err) {
      if (/timed out|ECONN|EHOST|ENET/.test(err.message)) {
        throw err;
      }
      return [];
    }
  }

  async function withCoordinator(work) {
    if (!room) {
      throw new Error('Sonos is not configured');
    }
    try {
      return await work(await resolveCoordinator());
    } catch (err) {
      forget();
      throw err;
    }
  }

  async function favouritesAndPlaylists(target) {
    if (library && clock() - libraryAt < LIBRARY_CACHE_MS) {
      return library;
    }
    const [favourites, playlists] = await Promise.all([
      browseOrEmpty(target, 'FV:2'),
      browseOrEmpty(target, 'SQ:')
    ]);
    library = { favourites, playlists };
    libraryAt = clock();
    return library;
  }

  // What the music picker opens on: what was last started from it, then
  // Sonos favourites and Sonos playlists.
  async function browseLibrary() {
    return withCoordinator(async (target) => {
      const lists = await favouritesAndPlaylists(target);
      return {
        recent: recentlyPicked.map(publicItem),
        favourites: lists.favourites.map(publicItem),
        playlists: lists.playlists.map(publicItem)
      };
    });
  }

  // Favourites and playlists by name, then albums, artists and tracks in the
  // music library. Streaming services can't be searched from here.
  async function search(query) {
    const term = String(query || '').trim().slice(0, 80);
    if (term.length < 2) {
      return { items: [] };
    }
    return withCoordinator(async (target) => {
      const lists = await favouritesAndPlaylists(target);
      const encoded = encodeURIComponent(term);
      const [albums, artists, tracks] = await Promise.all([
        browseOrEmpty(target, 'A:ALBUM:' + encoded, SEARCH_LIMIT),
        browseOrEmpty(target, 'A:ALBUMARTIST:' + encoded, SEARCH_LIMIT),
        browseOrEmpty(target, 'A:TRACKS:' + encoded, SEARCH_LIMIT)
      ]);
      const own = lists.favourites.concat(lists.playlists).filter((item) => matches(item, term));
      const seen = {};
      const items = own.concat(albums, artists, tracks).filter((item) => {
        const fresh = !seen[item.id];
        seen[item.id] = true;
        return fresh;
      });
      return { items: items.slice(0, 40).map(publicItem) };
    });
  }

  function remember(item) {
    recentlyPicked = [item].concat(recentlyPicked.filter((old) => old.uri !== item.uri)).slice(0, RECENT_LIMIT);
    try {
      saveRecent(recentlyPicked);
    } catch (err) {
      console.error('Sonos: could not save recently played: ' + err.message);
    }
  }

  async function lookUp(target, id) {
    if (known.has(id)) {
      return known.get(id);
    }
    const recent = recentlyPicked.find((item) => item.id === id);
    if (recent) {
      return recent;
    }
    const found = await browse(target, id, 'BrowseMetadata', 1);
    if (!found.length) {
      throw new Error('Nothing in the Sonos library called ' + id);
    }
    return found[0];
  }

  // Replaces whatever the room is playing with `id`, which must be something
  // the speaker listed: the browser never says what URI to play.
  async function play(id) {
    if (!PLAYABLE_ID.test(String(id || ''))) {
      throw new Error('Not something Sonos can play: ' + id);
    }
    await withCoordinator(async (target) => {
      const item = await lookUp(target, id);
      if (STREAM_URI.test(item.uri) || item.kind === 'station') {
        await call(target, AV, 'SetAVTransportURI', { InstanceID: 0, CurrentURI: item.uri, CurrentURIMetaData: item.metadata });
      } else {
        await call(target, AV, 'RemoveAllTracksFromQueue', { InstanceID: 0 });
        await call(target, AV, 'AddURIToQueue', {
          InstanceID: 0,
          EnqueuedURI: item.uri,
          EnqueuedURIMetaData: item.metadata,
          DesiredFirstTrackNumberEnqueued: 0,
          EnqueueAsNext: 0
        });
        await call(target, AV, 'SetAVTransportURI',
          { InstanceID: 0, CurrentURI: 'x-rincon-queue:' + coordinatorUuid + '#0', CurrentURIMetaData: '' });
      }
      await call(target, AV, 'Play', { InstanceID: 0, Speed: 1 });
      remember(item);
    });
    cached = null;
    await pending;
    cached = null;
    return status();
  }

  return { status, command, browseLibrary, search, play };
}

module.exports = { createSonos, coordinatorHost, describeTrack, parseStreamContent, parseDidlItems, unescapeXml };
