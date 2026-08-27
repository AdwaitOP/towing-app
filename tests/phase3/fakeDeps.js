'use strict';

// Unit-test fake only. Transactions are serialized and committed atomically,
// but this fake does not model Firestore optimistic conflicts, retries, process
// crashes, or cross-process isolation. Concurrency claims require the emulator.

const Module = require('module');

class FakeTimestamp {
  constructor(milliseconds) { this.milliseconds = milliseconds; }
  toMillis() { return this.milliseconds; }
  toDate() { return new Date(this.milliseconds); }
  static fromMillis(milliseconds) {
    if (!Number.isFinite(milliseconds)) throw new TypeError('Invalid timestamp');
    return new FakeTimestamp(milliseconds);
  }
}

class FakeDocumentSnapshot {
  constructor(ref, value) {
    this.ref = ref;
    this.id = ref.id;
    this.exists = value !== undefined;
    this._value = value;
  }
  data() { return this.exists ? clone(this._value) : undefined; }
}

class FakeDocumentReference {
  constructor(db, path, id) {
    this.db = db;
    this.path = path;
    this.id = id;
  }
  async get() { return this.db._snapshot(this.path, this.id, this.db.data); }
  async set(value, options) { this.db._set(this.path, this.id, value, options, this.db.data); }
  async update(value) { this.db._update(this.path, this.id, value, this.db.data); }
  async delete() { this.db._delete(this.path, this.id, this.db.data); }
}

class FakeQuery {
  constructor(db, path, filters = [], maximum = Infinity) {
    this.db = db;
    this.path = path;
    this.filters = filters;
    this.maximum = maximum;
  }
  where(field, operator, value) {
    if (operator !== '==') throw new Error('FakeQuery supports equality only');
    return new FakeQuery(this.db, this.path, [...this.filters, { field, value }], this.maximum);
  }
  limit(maximum) { return new FakeQuery(this.db, this.path, this.filters, maximum); }
  async get() {
    const collection = this.db.data[this.path] || {};
    const docs = Object.entries(collection)
      .filter(([, value]) => this.filters.every(filter => getField(value, filter.field) === filter.value))
      .slice(0, this.maximum)
      .map(([id, value]) => new FakeDocumentSnapshot(this.db.collection(this.path).doc(id), value));
    return { docs, empty: docs.length === 0, size: docs.length };
  }
}

class FakeCollectionReference extends FakeQuery {
  doc(id) {
    const docId = id || `auto-id-${++this.db.autoId}`;
    return new FakeDocumentReference(this.db, this.path, docId);
  }
}

class FakeFirestore {
  constructor(seed = {}) {
    this.data = clone(seed);
    this.autoId = 0;
    this._transactionTail = Promise.resolve();
  }
  collection(path) { return new FakeCollectionReference(this, path); }
  doc(path) {
    const parts = path.split('/');
    const id = parts.pop();
    return this.collection(parts.join('/')).doc(id);
  }
  seed(path, id, value) {
    if (!this.data[path]) this.data[path] = {};
    this.data[path][id] = clone(value);
  }
  read(path, id) { return clone(this.data[path]?.[id]); }
  async runTransaction(callback) {
    const run = async () => {
      const working = clone(this.data);
      const transaction = {
        get: async ref => this._snapshot(ref.path, ref.id, working),
        set: (ref, value, options) => this._set(ref.path, ref.id, value, options, working),
        update: (ref, value) => this._update(ref.path, ref.id, value, working),
        delete: ref => this._delete(ref.path, ref.id, working),
      };
      const result = await callback(transaction);
      this.data = working;
      return result;
    };
    const result = this._transactionTail.then(run, run);
    this._transactionTail = result.then(() => undefined, () => undefined);
    return result;
  }
  _snapshot(path, id, store) {
    return new FakeDocumentSnapshot(new FakeDocumentReference(this, path, id), store[path]?.[id]);
  }
  _set(path, id, value, options, store) {
    if (!store[path]) store[path] = {};
    const resolved = resolveTransforms(value, store[path][id]);
    store[path][id] = options?.merge ? { ...(store[path][id] || {}), ...resolved } : resolved;
  }
  _update(path, id, value, store) {
    if (!store[path]?.[id]) throw new Error(`NOT_FOUND: ${path}/${id}`);
    store[path][id] = { ...store[path][id], ...resolveTransforms(value, store[path][id]) };
  }
  _delete(path, id, store) { if (store[path]) delete store[path][id]; }
}

class FakeStorage {
  constructor(name = 'unit-test.appspot.com') {
    this.name = name;
    this.files = new Map();
  }
  bucket() {
    return {
      name: this.name,
      file: path => ({
        save: async (buffer, options) => this.files.set(path, { buffer: Buffer.from(buffer), options }),
        download: async () => {
          const record = this.files.get(path);
          if (!record) throw new Error('STORAGE_NOT_FOUND');
          return [Buffer.from(record.buffer)];
        },
      }),
    };
  }
}

class FakeIncrement {
  constructor(amount) { this.amount = amount; }
}

const defaultDb = new FakeFirestore();
const defaultStorage = new FakeStorage();
const defaultAuth = {
  getUserByPhoneNumber: async () => ({ uid: 'unit-user' }),
  createUser: async () => ({ uid: 'unit-user' }),
  createCustomToken: async uid => `token-for-${uid}`,
};

const originalRequire = Module.prototype.require;
Module.prototype.require = function fakeRequire(id) {
  if (id === 'firebase-admin/firestore') {
    return {
      getFirestore: () => defaultDb,
      Timestamp: FakeTimestamp,
      FieldValue: {
        serverTimestamp: () => FakeTimestamp.fromMillis(Date.now()),
        increment: amount => new FakeIncrement(amount),
      },
    };
  }
  if (id === 'firebase-admin/storage') return { getStorage: () => defaultStorage };
  if (id === 'firebase-admin/auth') return { getAuth: () => defaultAuth };
  if (id === 'firebase-admin/app') return { getApps: () => [{}], initializeApp: () => ({}) };
  if (id === 'firebase-functions/v2/https') return { onRequest: (_options, handler) => handler };
  if (id === 'firebase-functions/v2/scheduler') return { onSchedule: (_options, handler) => handler };
  if (id === 'firebase-functions') {
    return { logger: { info() {}, warn() {}, error() {} } };
  }
  if (id === 'pdfkit') return FakePdfDocument;
  return originalRequire.apply(this, arguments);
};

class FakePdfDocument {
  static documents = [];
  constructor() { this.listeners = {}; this.textValues = []; FakePdfDocument.documents.push(this); }
  on(event, callback) { this.listeners[event] = callback; return this; }
  fontSize() { return this; }
  text(value) { this.textValues.push(String(value)); return this; }
  moveDown() { return this; }
  end() {
    this.listeners.data?.(Buffer.from('%PDF-unit-test'));
    this.listeners.end?.();
  }
}

function createMockResponse() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    send(body) { if (!this.statusCode) this.statusCode = 200; this.body = body; return this; },
    json(body) { if (!this.statusCode) this.statusCode = 200; this.body = body; return this; },
    sendStatus(code) { this.statusCode = code; this.body = String(code); return this; },
  };
}

function resolveTransforms(value, current = {}) {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (item instanceof FakeIncrement) return [key, (current?.[key] || 0) + item.amount];
    return [key, clone(item)];
  }));
}

function getField(value, path) {
  return path.split('.').reduce((current, part) => current?.[part], value);
}

function clone(value) {
  if (value instanceof FakeTimestamp) return FakeTimestamp.fromMillis(value.toMillis());
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
  }
  return value;
}

module.exports = {
  FakeFirestore,
  FakeStorage,
  FakeTimestamp,
  FakePdfDocument,
  createMockResponse,
  limitations: [
    'Transactions are serialized rather than conflicted and retried.',
    'There is no cross-process isolation or crash model.',
    'Provider and Storage behavior must be injected explicitly.',
  ],
};
