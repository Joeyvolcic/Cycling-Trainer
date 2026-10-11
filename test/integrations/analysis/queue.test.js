/**
 * @jest-environment jsdom
 */

import indexedDB from 'fake-indexeddb';
import { UploadStore } from '../../../src/integrations/analysis/store.js';
import { UploadQueue, Status, backoff } from '../../../src/integrations/analysis/queue.js';
import { UploadError } from '../../../src/integrations/analysis/uploaders.js';

let dbCount = 0;

function setup(adapterUpload, {resolvable = true} = {}) {
    let t = 1000000;
    const store = UploadStore({indexedDB, name: `test-queue-${dbCount++}`});
    const adapter = {route: 'test', upload: jest.fn(adapterUpload)};
    const uploaders = {resolve: jest.fn(() => resolvable ? adapter : null)};
    const changes = [];
    const queue = UploadQueue({
        store, uploaders,
        now: () => t,
        onChange: (job) => changes.push({...job}),
        schedule: () => 1,
        cancel: () => {},
    });
    return {queue, store, adapter, uploaders, changes, advance: (ms) => { t += ms; }};
}

const job = {activityId: 'a1', service: 'strava', name: 'Ride', blob: 'FITDATA'};

describe('UploadQueue', () => {
    test('successful upload marks done and drops the blob', async () => {
        const {queue, store, adapter} = setup(async () => ({remote: {activityId: '42'}}));
        await queue.enqueue(job);
        await queue.process();
        const saved = await store.get('a1:strava');
        expect(adapter.upload).toHaveBeenCalledTimes(1);
        expect(saved.status).toBe(Status.done);
        expect(saved.remote.activityId).toBe('42');
        expect(saved.blob).toBe(null);
    });

    test('network failure is retried with backoff and nothing is lost', async () => {
        let calls = 0;
        const {queue, store, adapter, advance} = setup(async () => {
            calls++;
            if(calls < 3) throw new UploadError('offline', {retryable: true});
            return {remote: {}};
        });
        await queue.enqueue(job);
        await queue.process();
        let saved = await store.get('a1:strava');
        expect(saved.status).toBe(Status.pending);
        expect(saved.blob).toBe('FITDATA');
        expect(saved.attempts).toBe(1);

        // not due yet
        await queue.process();
        expect(adapter.upload).toHaveBeenCalledTimes(1);

        advance(backoff(1));
        await queue.process();
        saved = await store.get('a1:strava');
        expect(saved.attempts).toBe(2);
        expect(saved.status).toBe(Status.pending);

        advance(backoff(2));
        await queue.process();
        saved = await store.get('a1:strava');
        expect(saved.status).toBe(Status.done);
        expect(adapter.upload).toHaveBeenCalledTimes(3);
    });

    test('auth failure parks the job as needs-setup', async () => {
        const {queue, store} = setup(async () => {
            throw new UploadError('401', {retryable: false, needsSetup: true});
        });
        await queue.enqueue(job);
        await queue.process();
        expect((await store.get('a1:strava')).status).toBe(Status.needsSetup);
    });

    test('unconfigured service parks as needs-setup without calling upload', async () => {
        const {queue, store, adapter} = setup(async () => ({}), {resolvable: false});
        await queue.enqueue(job);
        await queue.process();
        expect(adapter.upload).not.toHaveBeenCalled();
        expect((await store.get('a1:strava')).status).toBe(Status.needsSetup);
    });

    test('permanent rejection is failed and can be retried manually', async () => {
        let fail = true;
        const {queue, store} = setup(async () => {
            if(fail) throw new UploadError('bad file', {retryable: false});
            return {remote: {}};
        });
        await queue.enqueue(job);
        await queue.process();
        expect((await store.get('a1:strava')).status).toBe(Status.failed);
        fail = false;
        await queue.retry('a1:strava');
        expect((await store.get('a1:strava')).status).toBe(Status.done);
    });

    test('progress is persisted so a resumed upload is not duplicated', async () => {
        let calls = 0;
        const {queue, store, advance} = setup(async (j, {progress}) => {
            calls++;
            if(!j.remote.uploadId) await progress({uploadId: 'u1'});
            if(calls === 1) throw new UploadError('still processing', {retryable: true});
            return {remote: {activityId: '7'}};
        });
        await queue.enqueue(job);
        await queue.process();
        expect((await store.get('a1:strava')).remote.uploadId).toBe('u1');
        advance(backoff(1));
        await queue.process();
        const saved = await store.get('a1:strava');
        expect(saved.status).toBe(Status.done);
        expect(saved.remote).toEqual({uploadId: 'u1', activityId: '7'});
    });

    test('enqueue does not re-upload a finished job unless forced', async () => {
        const {queue, adapter} = setup(async () => ({remote: {}}));
        await queue.enqueue(job);
        await queue.process();
        const again = await queue.enqueue(job);
        expect(again.status).toBe(Status.done);
        await queue.process();
        expect(adapter.upload).toHaveBeenCalledTimes(1);
    });

    test('backoff is capped', () => {
        expect(backoff(1)).toBe(30000);
        expect(backoff(2)).toBe(60000);
        expect(backoff(100)).toBe(6 * 60 * 60 * 1000);
    });
});
