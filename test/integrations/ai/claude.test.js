/**
 * @jest-environment jsdom
 */
// The SDK is mocked: these tests never call the real API.
const mockCreate = jest.fn();
const mockBetaCreate = jest.fn();

jest.mock('@anthropic-ai/sdk', () => {
    class APIError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
    class AuthenticationError extends APIError {}
    class RateLimitError extends APIError {}
    class BadRequestError extends APIError {}
    class InternalServerError extends APIError {}
    class APIConnectionError extends APIError {}
    class APIConnectionTimeoutError extends APIConnectionError {}
    const Anthropic = jest.fn().mockImplementation((opts) => ({
        opts,
        messages: {create: mockCreate},
        beta: {messages: {create: mockBetaCreate}},
    }));
    return {
        __esModule: true,
        default: Anthropic,
        APIError, AuthenticationError, RateLimitError, BadRequestError,
        InternalServerError, APIConnectionError, APIConnectionTimeoutError,
    };
}, {virtual: false});

import * as sdk from '@anthropic-ai/sdk';
import {
    isConfigured, complete, setKey, clearKey, setModel, getModel, buildParams, AiError,
} from '../../../src/integrations/ai/claude.js';

function message(text, extra = {}) {
    return Object.assign({stop_reason: 'end_turn', content: [{type: 'thinking', thinking: ''}, {type: 'text', text}]}, extra);
}

beforeEach(() => {
    localStorage.clear();
    mockCreate.mockReset();
    mockBetaCreate.mockReset();
    clearKey();
});

test('isConfigured reflects the stored key', () => {
    expect(isConfigured()).toBe(false);
    setKey('  sk-ant-test  ');
    expect(isConfigured()).toBe(true);
    expect(localStorage.getItem('ai:anthropic-key')).toBe('sk-ant-test');
    clearKey();
    expect(isConfigured()).toBe(false);
});

test('model defaults to Opus 5.5 and only accepts known models', () => {
    expect(getModel()).toBe('claude-opus-5-5');
    setModel('gpt-4');
    expect(getModel()).toBe('claude-opus-5-5');
    setModel('claude-haiku-5-5');
    expect(getModel()).toBe('claude-haiku-5-5');
});

describe('buildParams', () => {
    test('Opus: effort set, no thinking param, fallback beta, structured output', () => {
        const schema = {type: 'object', properties: {}, required: [], additionalProperties: false};
        const {params, useFallback} = buildParams({system: 's', prompt: 'p', json: true, schema, effort: 'medium'});
        expect(useFallback).toBe(true);
        expect(params).toEqual({
            model: 'claude-opus-5-5',
            max_tokens: 16000,
            system: 's',
            output_config: {effort: 'medium', format: {type: 'json_schema', schema}},
            messages: [{role: 'user', content: 'p'}],
            betas: ['server-side-fallback-2026-07-01'],
            fallbacks: 'default',
        });
        expect(params.thinking).toBeUndefined();
    });

    test('Haiku: no server-side fallback', () => {
        const {params, useFallback} = buildParams({prompt: 'p', model: 'claude-haiku-5-5'});
        expect(useFallback).toBe(false);
        expect(params.betas).toBeUndefined();
        expect(params.fallbacks).toBeUndefined();
        expect(params.output_config).toEqual({effort: 'low'});
        // last message is the user's: no assistant prefill
        expect(params.messages[params.messages.length - 1].role).toBe('user');
    });
});

describe('complete', () => {
    test('throws no-key without a key', async () => {
        await expect(complete({prompt: 'hi'})).rejects.toMatchObject({code: 'no-key'});
    });

    test('uses beta endpoint with browser opt-in and parses JSON', async () => {
        setKey('sk-ant-test');
        mockBetaCreate.mockResolvedValue(message('{"decision":"keep"}'));
        const out = await complete({prompt: 'p', json: true, schema: {type: 'object'}});
        expect(out).toEqual({decision: 'keep'});
        expect(sdk.default).toHaveBeenCalledWith(expect.objectContaining({apiKey: 'sk-ant-test', dangerouslyAllowBrowser: true}));
        expect(mockCreate).not.toHaveBeenCalled();
    });

    test('plain text for haiku via messages.create', async () => {
        setKey('sk-ant-test');
        setModel('claude-haiku-5-5');
        mockCreate.mockResolvedValue(message('hello'));
        expect(await complete({prompt: 'p'})).toBe('hello');
        expect(mockBetaCreate).not.toHaveBeenCalled();
    });

    test('refusal is checked before content', async () => {
        setKey('sk-ant-test');
        mockBetaCreate.mockResolvedValue(message('{}', {stop_reason: 'refusal', stop_details: {category: 'bio'}}));
        await expect(complete({prompt: 'p', json: true})).rejects.toMatchObject({code: 'refusal'});
    });

    test('max_tokens is reported as truncated', async () => {
        setKey('sk-ant-test');
        mockBetaCreate.mockResolvedValue(message('{"a"', {stop_reason: 'max_tokens'}));
        await expect(complete({prompt: 'p', json: true})).rejects.toMatchObject({code: 'truncated'});
    });

    test('maps typed SDK errors', async () => {
        setKey('sk-ant-test');
        mockBetaCreate.mockRejectedValue(new sdk.AuthenticationError(401, 'bad key'));
        await expect(complete({prompt: 'p'})).rejects.toMatchObject({code: 'auth'});
        mockBetaCreate.mockRejectedValue(new sdk.RateLimitError(429, 'slow down'));
        await expect(complete({prompt: 'p'})).rejects.toMatchObject({code: 'rate-limit'});
        mockBetaCreate.mockRejectedValue(new sdk.APIConnectionTimeoutError(undefined, 'timeout'));
        await expect(complete({prompt: 'p'})).rejects.toMatchObject({code: 'timeout'});
        mockBetaCreate.mockRejectedValue(new sdk.InternalServerError(529, 'overloaded'));
        const err = await complete({prompt: 'p'}).catch((e) => e);
        expect(err).toBeInstanceOf(AiError);
        expect(err.code).toBe('server');
    });

    test('json without schema tolerates code fences', async () => {
        setKey('sk-ant-test');
        mockBetaCreate.mockResolvedValue(message('```json\n{"x": 1}\n```'));
        expect(await complete({prompt: 'p', json: true})).toEqual({x: 1});
    });
});
