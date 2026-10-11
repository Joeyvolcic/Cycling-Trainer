/**
 * @jest-environment jsdom
 */
import {
    toSpotifyUri, isSpoken, toNowPlaying, liveProgress, formatTime, resumeInfo, resumeChapter,
    webPlaybackSupport, escapeHtml, pickImage,
} from '../../../src/integrations/media/model.js';
import { parseFeed, parseDuration, proxied, fetchFeed } from '../../../src/integrations/media/rss.js';

describe('media model helpers', () => {
    test('spotify links to uris', () => {
        expect(toSpotifyUri('https://open.spotify.com/playlist/37i9dQZF1DX76Wlfdnj7AP?si=abc')).toBe('spotify:playlist:37i9dQZF1DX76Wlfdnj7AP');
        expect(toSpotifyUri('https://open.spotify.com/intl-de/show/abc123')).toBe('spotify:show:abc123');
        expect(toSpotifyUri('spotify:playlist:xyz')).toBe('spotify:playlist:xyz');
        expect(toSpotifyUri('hello')).toBeNull();
    });

    test('spoken content detection', () => {
        expect(isSpoken({currently_playing_type: 'episode', item: {}})).toBe(true);
        expect(isSpoken({currently_playing_type: 'track', item: {type: 'track'}})).toBe(false);
        expect(isSpoken({item: {type: 'chapter'}})).toBe(true);
        expect(isSpoken(null)).toBe(false);
    });

    test('now playing model for tracks and episodes', () => {
        const track = toNowPlaying({
            is_playing: true, progress_ms: 1000, currently_playing_type: 'track', context: {uri: 'spotify:playlist:p'},
            device: {id: 'd', name: 'iPad', volume_percent: 50},
            item: {type: 'track', name: 'Song', uri: 'spotify:track:t', duration_ms: 200000,
                   artists: [{name: 'A'}, {name: 'B'}], album: {images: [{url: 'big', width: 640}, {url: 'small', width: 64}]}},
        }, 0);
        expect(track).toMatchObject({title: 'Song', subtitle: 'A, B', art: 'big', spoken: false, contextUri: 'spotify:playlist:p', isPlaying: true});
        const ep = toNowPlaying({is_playing: false, currently_playing_type: 'episode',
            item: {type: 'episode', name: 'Ep', show: {name: 'Show', images: [{url: 's', width: 300}]}, images: []}}, 0);
        expect(ep).toMatchObject({title: 'Ep', subtitle: 'Show', art: 's', spoken: true});
        expect(toNowPlaying(null).active).toBe(false);
    });

    test('live progress interpolation', () => {
        const np = {isPlaying: true, progressMs: 1000, durationMs: 5000, fetchedAt: 0};
        expect(liveProgress(np, 2000)).toBe(3000);
        expect(liveProgress(np, 10000)).toBe(5000);
        expect(liveProgress(Object.assign({}, np, {isPlaying: false}), 2000)).toBe(1000);
    });

    test('formatTime', () => {
        expect(formatTime(0)).toBe('0:00');
        expect(formatTime(61000)).toBe('1:01');
        expect(formatTime(3723000)).toBe('1:02:03');
    });

    test('resume info and chapter selection', () => {
        expect(resumeInfo({duration_ms: 1000, resume_point: {fully_played: false, resume_position_ms: 250}}))
            .toEqual({positionMs: 250, fullyPlayed: false, fraction: 0.25});
        const chapters = [
            {uri: 'c1', resume_point: {fully_played: true, resume_position_ms: 0}},
            {uri: 'c2', resume_point: {fully_played: false, resume_position_ms: 5000}},
            {uri: 'c3', resume_point: {fully_played: false, resume_position_ms: 0}},
        ];
        expect(resumeChapter(chapters)).toEqual({chapter: chapters[1], positionMs: 5000});
        expect(resumeChapter([chapters[0], chapters[2]]).chapter.uri).toBe('c3');
        expect(resumeChapter([])).toBeNull();
    });

    test('web playback support', () => {
        expect(webPlaybackSupport({userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)'}).supported).toBe(false);
        // iPadOS 13+ reports a desktop Mac user agent
        expect(webPlaybackSupport({userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 5}).reason).toBe('ios');
        expect(webPlaybackSupport({userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 0}).supported).toBe(true);
        expect(webPlaybackSupport({userAgent: 'Linux; Android 14'}).supported).toBe(false);
        expect(webPlaybackSupport({userAgent: 'Windows NT 10.0', hasEME: false}).reason).toBe('eme');
    });

    test('escapeHtml and pickImage', () => {
        expect(escapeHtml('<a href="x">&\'')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
        expect(pickImage([], 64)).toBe('');
        expect(pickImage([{url: 'a', width: 640}, {url: 'b', width: 64}], 64)).toBe('b');
    });
});

describe('rss', () => {
    const xml = `<?xml version="1.0"?>
    <rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
      <channel>
        <title>Ride Cast</title>
        <itunes:image href="https://img/show.jpg"/>
        <item>
          <title>Episode 2</title>
          <guid>ep-2</guid>
          <pubDate>Tue, 01 Oct 2024 10:00:00 GMT</pubDate>
          <itunes:duration>01:02:03</itunes:duration>
          <enclosure url="https://cdn/ep2.mp3" type="audio/mpeg" length="1"/>
        </item>
        <item>
          <title>No audio</title>
        </item>
        <item>
          <title>Episode 1</title>
          <itunes:duration>1800</itunes:duration>
          <itunes:image href="https://img/ep1.jpg"/>
          <enclosure url="https://cdn/ep1.mp3" type="audio/mpeg"/>
        </item>
      </channel>
    </rss>`;

    test('parses feed', () => {
        const feed = parseFeed(xml);
        expect(feed.title).toBe('Ride Cast');
        expect(feed.image).toBe('https://img/show.jpg');
        expect(feed.episodes).toHaveLength(2);
        expect(feed.episodes[0]).toMatchObject({id: 'ep-2', url: 'https://cdn/ep2.mp3', duration: 3723, image: 'https://img/show.jpg'});
        expect(feed.episodes[1]).toMatchObject({id: 'https://cdn/ep1.mp3', duration: 1800, image: 'https://img/ep1.jpg'});
    });

    test('rejects non-feeds', () => {
        expect(() => parseFeed('<html><body>nope</body></html>')).toThrow();
    });

    test('durations', () => {
        expect(parseDuration('62:03')).toBe(3723);
        expect(parseDuration('')).toBe(0);
        expect(parseDuration('abc')).toBe(0);
    });

    test('proxy template', () => {
        expect(proxied('https://f/x?y=1', 'https://p/?url={url}')).toBe('https://p/?url=https%3A%2F%2Ff%2Fx%3Fy%3D1');
        expect(proxied('https://f/x', 'https://p/')).toBe('https://p/https://f/x');
        expect(proxied('https://f/x', '')).toBeNull();
    });

    test('CORS failure explains and falls back to proxy', async () => {
        const blocked = jest.fn(async () => { throw new TypeError('Failed to fetch'); });
        await expect(fetchFeed('https://f/x', {fetchImpl: blocked})).rejects.toMatchObject({kind: 'cors'});

        const viaProxy = jest.fn(async (url) => {
            if(url.startsWith('https://p/')) return {ok: true, text: async () => xml};
            throw new TypeError('Failed to fetch');
        });
        const feed = await fetchFeed('https://f/x', {fetchImpl: viaProxy, proxyTemplate: 'https://p/?url={url}'});
        expect(feed.episodes).toHaveLength(2);
        expect(viaProxy).toHaveBeenCalledTimes(2);
    });
});
