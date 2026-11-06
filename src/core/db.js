// IndexedDB para persistencia local

const DB_NAME = 'CaminoMTB';
const DB_VERSION = 1;

class Database {
  constructor() {
    this.db = null;
  }
  
  async open() {
    if (this.db) return this.db;
    
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve(this.db);
      };
      
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        
        // Almacén de caminos completados
        if (!db.objectStoreNames.contains('caminos')) {
          db.createObjectStore('caminos', { keyPath: 'id' });
        }
        
        // Almacén de etapas completadas
        if (!db.objectStoreNames.contains('etapas')) {
          const store = db.createObjectStore('etapas', { keyPath: 'id' });
          store.createIndex('caminoId', 'caminoId', { unique: false });
          store.createIndex('completedAt', 'completedAt', { unique: false });
        }
        
        // Almacén de tracks grabados
        if (!db.objectStoreNames.contains('tracks')) {
          const store = db.createObjectStore('tracks', { keyPath: 'id' });
          store.createIndex('etapaId', 'etapaId', { unique: false });
          store.createIndex('recordedAt', 'recordedAt', { unique: false });
        }
        
        // Almacén de POIs (albergues, farmacias, etc.)
        if (!db.objectStoreNames.contains('pois')) {
          const store = db.createObjectStore('pois', { keyPath: 'id' });
          store.createIndex('type', 'type', { unique: false });
          store.createIndex('caminoId', 'caminoId', { unique: false });
        }
        
        // Almacén de mapas offline (teselas)
        if (!db.objectStoreNames.contains('tiles')) {
          db.createObjectStore('tiles', { keyPath: 'key' });
        }
        
        // Almacén clave-valor para configuración y borradores
        if (!db.objectStoreNames.contains('kv')) {
          db.createObjectStore('kv', { keyPath: 'key' });
        }
      };
    });
  }
  
  async put(storeName, data) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const request = store.put(data);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
  }
  
  async get(storeName, key) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const request = store.get(key);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
  }
  
  async getAll(storeName) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const request = store.getAll();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
  }
  
  async getByIndex(storeName, indexName, value) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const index = store.index(indexName);
      const request = index.getAll(value);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
  }
  
  async del(storeName, key) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const request = store.delete(key);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }
  
  // Métodos de conveniencia para KV store
  async kvSet(key, value) {
    return this.put('kv', { key, value });
  }
  
  async kvGet(key) {
    const result = await this.get('kv', key);
    return result ? result.value : null;
  }
  
  async kvDel(key) {
    return this.del('kv', key);
  }
}

export const DB = new Database();