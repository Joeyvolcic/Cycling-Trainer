//
// Separate IndexedDB database for the upload retry queue, so we don't have to bump the
// version of the shared 'store' database (other integrations add stores there too).
//
// UploadJob = {
//     id: `${activityId}:${service}`,
//     activityId, service, name, blob, timestamp,
//     status: 'pending' | 'uploading' | 'processing' | 'done' | 'needs-setup' | 'failed',
//     attempts: Int, nextAttemptAt: Int (ms), lastError: String,
//     remote: {uploadId?, activityId?, url?},
//     createdAt, updatedAt,
// }
//

const DB_NAME = 'flux-analysis';
const DB_VERSION = 1;
const UPLOADS = 'uploads';

function promisify(req) {
    return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function UploadStore(args = {}) {
    let dbPromise;

    function factory() {
        return args.indexedDB ?? globalThis.indexedDB;
    }

    function open() {
        if(dbPromise) return dbPromise;
        dbPromise = new Promise((resolve, reject) => {
            const idb = factory();
            if(!idb) return reject(new Error('IndexedDB not available'));
            const req = idb.open(args.name ?? DB_NAME, DB_VERSION);
            req.onupgradeneeded = () => {
                const db = req.result;
                if(!db.objectStoreNames.contains(UPLOADS)) {
                    db.createObjectStore(UPLOADS, {keyPath: 'id'});
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
        return dbPromise;
    }

    async function tx(method, param, mode = 'readonly') {
        const db = await open();
        const store = db.transaction(UPLOADS, mode).objectStore(UPLOADS);
        return promisify(param === undefined ? store[method]() : store[method](param));
    }

    return Object.freeze({
        open,
        put:    (job) => tx('put', job, 'readwrite'),
        get:    (id)  => tx('get', id),
        getAll: ()    => tx('getAll'),
        remove: (id)  => tx('delete', id, 'readwrite'),
        clear:  ()    => tx('clear', undefined, 'readwrite'),
    });
}

export { UploadStore };
