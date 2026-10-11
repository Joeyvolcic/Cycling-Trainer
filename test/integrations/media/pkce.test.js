import { webcrypto } from 'crypto';
import {
    randomString, generateVerifier, base64url, codeChallenge, buildAuthorizeUrl,
    tokenRequestBody, refreshRequestBody, parseCallback, redirectUriFor, SPOTIFY_SCOPES,
} from '../../../src/integrations/media/pkce.js';

describe('PKCE helpers', () => {
    test('RFC 7636 appendix B test vector', async () => {
        const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
        expect(await codeChallenge(verifier, webcrypto)).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    });

    test('verifier uses only unreserved characters and requested length', () => {
        const v = generateVerifier(64, webcrypto);
        expect(v).toHaveLength(64);
        expect(v).toMatch(/^[A-Za-z0-9\-._~]+$/);
        expect(generateVerifier(64, webcrypto)).not.toBe(v);
    });

    test('verifier length is validated', () => {
        expect(() => generateVerifier(42, webcrypto)).toThrow();
        expect(() => generateVerifier(129, webcrypto)).toThrow();
        expect(generateVerifier(43, webcrypto)).toHaveLength(43);
    });

    test('randomString uses the injected crypto', () => {
        const fake = {getRandomValues: arr => arr.fill(0)};
        expect(randomString(5, fake)).toBe('AAAAA');
    });

    test('base64url strips padding and is url safe', () => {
        expect(base64url(new Uint8Array([0xfb, 0xff]))).toBe('-_8');
        expect(base64url(new Uint8Array([1]))).toBe('AQ');
    });

    test('authorize url carries PKCE params and scopes', () => {
        const url = new URL(buildAuthorizeUrl({
            clientId: 'abc', redirectUri: 'https://app.example/', challenge: 'CH', state: 'spotify_x',
        }));
        expect(url.origin + url.pathname).toBe('https://accounts.spotify.com/authorize');
        const p = url.searchParams;
        expect(p.get('client_id')).toBe('abc');
        expect(p.get('response_type')).toBe('code');
        expect(p.get('code_challenge_method')).toBe('S256');
        expect(p.get('code_challenge')).toBe('CH');
        expect(p.get('redirect_uri')).toBe('https://app.example/');
        expect(p.get('state')).toBe('spotify_x');
        expect(p.get('scope').split(' ')).toEqual(SPOTIFY_SCOPES);
        expect(p.get('scope')).toContain('user-modify-playback-state');
    });

    test('authorize url requires client id', () => {
        expect(() => buildAuthorizeUrl({redirectUri: 'x', challenge: 'c', state: 's'})).toThrow(/Client ID/);
    });

    test('token request bodies', () => {
        const a = new URLSearchParams(tokenRequestBody({clientId: 'id', code: 'C', redirectUri: 'https://r/', verifier: 'V'}));
        expect(a.get('grant_type')).toBe('authorization_code');
        expect(a.get('code_verifier')).toBe('V');
        expect(a.get('redirect_uri')).toBe('https://r/');
        const b = new URLSearchParams(refreshRequestBody({clientId: 'id', refreshToken: 'R'}));
        expect(b.get('grant_type')).toBe('refresh_token');
        expect(b.get('refresh_token')).toBe('R');
        expect(b.get('client_id')).toBe('id');
    });

    test('parseCallback handles search strings, full urls and errors', () => {
        expect(parseCallback('?code=abc&state=spotify_1')).toEqual({code: 'abc', state: 'spotify_1', error: null});
        expect(parseCallback('https://x.test/app/?code=abc&state=s#frag')).toEqual({code: 'abc', state: 's', error: null});
        expect(parseCallback('?error=access_denied&state=s')).toEqual({code: null, state: 's', error: 'access_denied'});
        expect(parseCallback('?page=home')).toBeNull();
        expect(parseCallback('')).toBeNull();
    });

    test('redirect uri drops query and hash', () => {
        expect(redirectUriFor({origin: 'https://a.b', pathname: '/flux/'})).toBe('https://a.b/flux/');
    });
});
