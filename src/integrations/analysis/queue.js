//
// Persistent upload retry queue. Jobs live in IndexedDB (see store.js) together with a
// copy of the FIT blob, so an upload survives being offline, page reloads and the
// the rider deleting the ride from the activity list.
//

const BASE_BACKOFF = 30 * 1000;            // 30s
const MAX_BACKOFF = 6 * 60 * 60 * 1000;    // 6h

const Status = {
    pending:    'pending',
    uploading:  'uploading',
    done:       'done',
    needsSetup: 'needs-setup',
    failed:     'failed',
};

function backoff(attempts) {
    return Math.min(BASE_BACKOFF * Math.pow(2, Math.max(0, attempts - 1)), MAX_BACKOFF);
}

function UploadQueue(deps = {}) {
    const store = deps.store;
    const uploaders = deps.uploaders;
    const now = deps.now ?? (() => Date.now());
    const onChange = deps.onChange ?? (() => {});
    const schedule = deps.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    const cancel = deps.cancel ?? ((t) => clearTimeout(t));

    let running = null;
    let timer = null;

    async function save(job) {
        job.updatedAt = now();
        await store.put(job);
        try { onChange(job); } catch(e) { console.error(':analysis :queue :onChange', e); }
        return job;
    }

    // {activityId, service, name, blob, timestamp} -> job
    async function enqueue(args = {}, {force = false} = {}) {
        const id = `${args.activityId}:${args.service}`;
        const existing = await store.get(id);
        if(existing && existing.status === Status.done && !force) return existing;
        if(existing && existing.status === Status.uploading) return existing;

        const job = Object.assign({
            id,
            remote: {},
            createdAt: now(),
        }, existing ?? {}, {
            activityId: args.activityId,
            service: args.service,
            name: args.name ?? existing?.name,
            blob: args.blob ?? existing?.blob,
            timestamp: args.timestamp ?? existing?.timestamp ?? now(),
            status: Status.pending,
            remote: (existing && existing.status !== Status.done) ? (existing.remote ?? {}) : {},
            attempts: 0,
            nextAttemptAt: now(),
            lastError: '',
        });
        if(!job.blob) throw new Error(`:analysis :queue no file for activity ${args.activityId}`);
        return save(job);
    }

    function isDue(job, t) {
        if(job.status === Status.pending) return (job.nextAttemptAt ?? 0) <= t;
        // config may have been fixed since; cheap to re-check
        if(job.status === Status.needsSetup) return uploaders.resolve(job.service) !== null;
        // interrupted mid-upload (tab closed): try again
        if(job.status === Status.uploading) return (job.updatedAt ?? 0) + 5 * 60 * 1000 <= t;
        return false;
    }

    async function runJob(job) {
        const adapter = uploaders.resolve(job.service);
        if(!adapter) {
            job.status = Status.needsSetup;
            job.lastError = 'Service is not connected';
            return save(job);
        }
        job.status = Status.uploading;
        job.route = adapter.route;
        job.attempts = (job.attempts ?? 0) + 1;
        await save(job);

        try {
            const res = await adapter.upload(job, {
                progress: async (remote) => {
                    job.remote = Object.assign({}, job.remote, remote);
                    await save(job);
                },
            });
            job.remote = Object.assign({}, job.remote, res?.remote ?? {});
            job.status = Status.done;
            job.lastError = res?.remote?.warning ?? '';
            job.blob = null; // free space, the activity keeps its own copy
            job.completedAt = now();
        } catch(e) {
            job.lastError = e?.message ?? String(e);
            if(e?.needsSetup) {
                job.status = Status.needsSetup;
            } else if(e?.retryable === false) {
                job.status = Status.failed;
            } else {
                job.status = Status.pending;
                job.nextAttemptAt = now() + backoff(job.attempts);
            }
        }
        return save(job);
    }

    async function processOnce() {
        const t = now();
        const jobs = (await store.getAll()) ?? [];
        const due = jobs
            .filter(j => isDue(j, t))
            .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
        for(const job of due) {
            await runJob(job);
        }
        reschedule();
        return due.length;
    }

    // single flight
    function process() {
        if(running) return running;
        running = processOnce().finally(() => { running = null; });
        return running;
    }

    async function reschedule() {
        if(timer) { cancel(timer); timer = null; }
        const jobs = (await store.getAll()) ?? [];
        const next = jobs
            .filter(j => j.status === Status.pending)
            .map(j => j.nextAttemptAt ?? 0);
        if(next.length === 0) return;
        const wait = Math.max(1000, Math.min(...next) - now());
        timer = schedule(() => { timer = null; process(); }, wait);
    }

    async function retry(id) {
        const job = await store.get(id);
        if(!job || job.status === Status.done || job.status === Status.uploading) return job;
        job.status = Status.pending;
        job.nextAttemptAt = now();
        await save(job);
        return process();
    }

    async function remove(id) {
        await store.remove(id);
    }

    async function list() {
        return ((await store.getAll()) ?? []).sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    }

    async function forActivity(activityId) {
        return (await list()).filter(j => j.activityId === activityId);
    }

    return Object.freeze({
        enqueue,
        process,
        retry,
        remove,
        list,
        forActivity,
    });
}

export { UploadQueue, Status, backoff };
