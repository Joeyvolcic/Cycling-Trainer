//
// RSS podcast feeds (no Spotify needed).
//
// Fetching a feed from the browser is subject to CORS: many podcast hosts do not send
// Access-Control-Allow-Origin, so fetch() fails. Playing the episode audio itself is
// NOT affected (a plain <audio src> does not need CORS). Options when blocked:
//   1. a CORS proxy URL template set by the user (localStorage 'media:cors-proxy'),
//      e.g. "https://my-proxy.example/?url={url}"  ({url} is URL-encoded)
//   2. load the feed .xml as a file (save it from Safari, then pick it)
//   3. paste an episode's audio URL directly
//

class FeedError extends Error {
    constructor(message, kind = 'fetch') {
        super(message);
        this.name = 'FeedError';
        this.kind = kind; // 'cors' | 'http' | 'parse'
    }
}

function text(el, selector) {
    if(!el) return '';
    const node = el.getElementsByTagName(selector)[0];
    return node ? (node.textContent || '').trim() : '';
}

// "01:02:03" | "62:03" | "3723" -> seconds
function parseDuration(value = '') {
    const v = String(value).trim();
    if(!v) return 0;
    if(/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v));
    const parts = v.split(':').map(Number);
    if(parts.some(isNaN)) return 0;
    return parts.reduce((acc, n) => acc * 60 + n, 0);
}

// xml string -> {title, image, episodes: [{id, title, url, type, pubDate, duration, image, description}]}
function parseFeed(xml, DOMParserImpl = globalThis.DOMParser) {
    if(!DOMParserImpl) throw new FeedError('No XML parser available', 'parse');
    const doc = new DOMParserImpl().parseFromString(xml, 'application/xml');
    if(doc.getElementsByTagName('parsererror').length > 0) {
        throw new FeedError('This does not look like a podcast RSS feed.', 'parse');
    }
    const channel = doc.getElementsByTagName('channel')[0];
    if(!channel) throw new FeedError('No <channel> in feed.', 'parse');

    const itunesImage = el => {
        const n = el.getElementsByTagName('itunes:image')[0];
        return n ? (n.getAttribute('href') || '') : '';
    };
    const channelImage = itunesImage(channel) || text(channel.getElementsByTagName('image')[0], 'url');

    const episodes = Array.from(channel.getElementsByTagName('item')).map(item => {
        const enc = item.getElementsByTagName('enclosure')[0];
        const url = enc ? (enc.getAttribute('url') || '') : '';
        return {
            id:          text(item, 'guid') || url,
            title:       text(item, 'title') || 'Untitled episode',
            url,
            type:        enc ? (enc.getAttribute('type') || '') : '',
            pubDate:     text(item, 'pubDate'),
            duration:    parseDuration(text(item, 'itunes:duration')),
            image:       itunesImage(item) || channelImage,
        };
    }).filter(e => e.url);

    return {
        title: text(channel, 'title') || 'Podcast',
        image: channelImage,
        episodes,
    };
}

function proxied(url, template) {
    if(!template) return null;
    if(template.includes('{url}')) return template.replace('{url}', encodeURIComponent(url));
    return template + url;
}

async function fetchFeed(url, {proxyTemplate = '', fetchImpl = globalThis.fetch} = {}) {
    let res;
    try {
        res = await fetchImpl(url);
    } catch(err) {
        // TypeError: Failed to fetch / Load failed  -> almost always CORS (or offline)
        const viaProxy = proxied(url, proxyTemplate);
        if(!viaProxy) {
            throw new FeedError(
                'The podcast host blocks in-browser access (CORS). Set a CORS proxy in Settings, ' +
                'load the feed as an .xml file, or paste an episode audio URL instead.', 'cors');
        }
        try {
            res = await fetchImpl(viaProxy);
        } catch(err2) {
            throw new FeedError('Could not reach the feed, even through the CORS proxy.', 'cors');
        }
    }
    if(!res.ok) throw new FeedError(`Feed request failed (${res.status}).`, 'http');
    return parseFeed(await res.text());
}

export {
    FeedError,
    parseDuration,
    parseFeed,
    proxied,
    fetchFeed,
};
