'use strict';

// Talks to Sonos speakers on the local network over their UPnP control API
// (port 1400, no account or key needed). Only does what the dashboard shows:
// what's playing in one room, play/pause and next track.

const dgram = require('node:dgram');
const http = require('node:http');

const PORT = 1400;
const SOAP_TIMEOUT_MS = 5 * 1000;
const DISCOVERY_MS = 2 * 1000;
const COORDINATOR_CACHE_MS = 60 * 1000;
const STATUS_CACHE_MS = 2 * 1000;
// After playback stops, controls stay up this long so it can be resumed.
const RECENT_MS = 15 * 60 * 1000;

const AV = { path: '/MediaRenderer/AVTransport/Control', urn: 'urn:schemas-upnp-org:service:AVTransport:1' };
const TOPOLOGY = { path: '/ZoneGroupTopology/Control', urn: 'urn:schemas-upnp-org:service:ZoneGroupTopology:1' };

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

// The host serving `room`'s group coordinator, which is the speaker that has to
// be asked about and told what to play when rooms are grouped.
function coordinatorHost(zoneGroupState, room) {
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
      return lead && lead.Location ? new URL(lead.Location).hostname : null;
    }
  }
  return null;
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
  const body = Object.keys(args).map((key) => '<' + key + '>' + args[key] + '</' + key + '>').join('');
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

function createSonos({ room, host, call = soap, find = discover, clock = Date.now }) {
  let seedHost = host || null;
  let coordinator = null;
  let coordinatorAt = 0;
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
    const found = coordinatorHost(tagText(response, 'ZoneGroupState'), room);
    if (!found) {
      throw new Error('No Sonos room called "' + room + '"');
    }
    coordinator = found;
    coordinatorAt = clock();
    return found;
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

  // `name` is "toggle" or "next". Resolves to the new status.
  async function command(name) {
    const current = await status();
    if (!current.available) {
      throw new Error('Sonos is not available');
    }
    const target = await resolveCoordinator();
    const args = { InstanceID: 0 };
    try {
      if (name === 'next') {
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

  return { status, command };
}

module.exports = { createSonos, coordinatorHost, describeTrack, parseStreamContent, unescapeXml };
