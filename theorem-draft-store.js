(function(){
  const DB_NAME = 'ivucxTheoremDraftDB';
  const DB_VERSION = 1;
  const STORE_NAME = 'drafts';
  const ACTIVE_KEY = 'active';

  let dbPromise = null;
  let patchQueue = Promise.resolve();

  function isPlainObject(value){
    return !!value && Object.prototype.toString.call(value) === '[object Object]';
  }

  function cloneValue(value){
    if (value == null) return value;
    try{
      return JSON.parse(JSON.stringify(value));
    }catch(err){
      return value;
    }
  }

  function deepMerge(base, patch){
    if (patch === undefined){
      return cloneValue(base);
    }
    if (Array.isArray(patch)){
      return patch.map(item => cloneValue(item));
    }
    if (!isPlainObject(patch)){
      return cloneValue(patch);
    }

    const seed = isPlainObject(base) ? { ...base } : {};
    Object.keys(patch).forEach(key => {
      const patchValue = patch[key];
      if (patchValue === undefined) return;
      seed[key] = deepMerge(seed[key], patchValue);
    });
    return seed;
  }

  function openDb(){
    if (!window.indexedDB) return Promise.resolve(null);
    if (dbPromise) return dbPromise;

    dbPromise = new Promise(resolve => {
      const request = window.indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)){
          db.createObjectStore(STORE_NAME);
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    });

    return dbPromise;
  }

  async function read(){
    const db = await openDb();
    if (!db) return null;

    return new Promise(resolve => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(ACTIVE_KEY);
      request.onsuccess = () => resolve(cloneValue(request.result || null));
      request.onerror = () => resolve(null);
    });
  }

  async function write(record){
    const db = await openDb();
    if (!db) return false;

    return new Promise(resolve => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.put(cloneValue(record), ACTIVE_KEY);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    });
  }

  async function patch(partialOrUpdater){
    patchQueue = patchQueue.then(async () => {
      const current = (await read()) || { version: 1 };
      const partial = typeof partialOrUpdater === 'function'
        ? partialOrUpdater(cloneValue(current))
        : partialOrUpdater;

      if (!partial){
        return current;
      }

      const next = deepMerge(current, partial);
      next.version = 1;
      next.savedAt = new Date().toISOString();
      await write(next);
      return next;
    }).catch(() => null);

    return patchQueue;
  }

  async function clear(){
    patchQueue = patchQueue.then(async () => {
      const db = await openDb();
      if (!db) return false;

      return new Promise(resolve => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.delete(ACTIVE_KEY);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
        tx.onabort = () => resolve(false);
      });
    }).catch(() => false);

    return patchQueue;
  }

  async function destroy(){
    patchQueue = patchQueue.then(async () => {
      const db = await openDb();
      if (db && typeof db.close === 'function'){
        try{
          db.close();
        }catch(err){
          // ignore close failures
        }
      }
      dbPromise = null;
      if (!window.indexedDB) return false;

      return new Promise(resolve => {
        const request = window.indexedDB.deleteDatabase(DB_NAME);
        request.onsuccess = () => resolve(true);
        request.onerror = () => resolve(false);
        request.onblocked = () => resolve(false);
      });
    }).catch(() => false);

    return patchQueue;
  }

  window.ivucxTheoremDraftStore = {
    read,
    write,
    patch,
    clear,
    destroy,
    dbName: DB_NAME,
    storeName: STORE_NAME,
    activeKey: ACTIVE_KEY
  };
})();
