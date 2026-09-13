'use strict';

const { GeoPoint } = require('firebase-admin/firestore');

// Do not import Phase 3's fakeDeps: it globally replaces module loading.
class FakeTimestamp {
  constructor(secondsOrMs, nanoseconds) {
    if (typeof nanoseconds === 'number') {
      this.seconds = secondsOrMs;
      this.nanoseconds = nanoseconds;
      this.ms = Math.floor(secondsOrMs * 1000 + nanoseconds / 1e6);
    } else {
      this.ms = secondsOrMs;
      this.seconds = Math.floor(secondsOrMs / 1000);
      this.nanoseconds = Math.floor((secondsOrMs % 1000) * 1e6);
    }
  }
  static fromMillis(ms) { return new FakeTimestamp(ms); }
  toMillis() { return this.ms; }
  toDate() { return new Date(this.ms); }
}

class FakeServerTimestampTransform {
  constructor() {
    this._isServerTimestamp = true;
    this._methodName = 'serverTimestamp';
  }
}

const FakeFieldValue = {
  serverTimestamp: () => new FakeServerTimestampTransform(),
};

function isServerTimestampSentinel(val) {
  return Boolean(
    val &&
    typeof val === 'object' &&
    (val instanceof FakeServerTimestampTransform ||
      val._isServerTimestamp === true ||
      val.constructor?.name === 'ServerTimestampTransform')
  );
}

function resolveTransforms(value, commitTime = Date.now()) {
  if (value === undefined || value === null) return value;
  if (isServerTimestampSentinel(value)) {
    return FakeTimestamp.fromMillis(commitTime);
  }
  if (value instanceof FakeTimestamp) return new FakeTimestamp(value.seconds, value.nanoseconds);
  if (value instanceof GeoPoint) return new GeoPoint(value.latitude, value.longitude);
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map(v => resolveTransforms(v, commitTime));
  if (typeof value === 'object') {
    const copy = {};
    for (const [k, v] of Object.entries(value)) copy[k] = resolveTransforms(v, commitTime);
    return copy;
  }
  return value;
}

function clone(value) {
  if (value === undefined || value === null) return value;
  if (isServerTimestampSentinel(value)) return value;
  if (value instanceof FakeTimestamp) return new FakeTimestamp(value.seconds, value.nanoseconds);
  if (value instanceof GeoPoint) return new GeoPoint(value.latitude, value.longitude);
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map(clone);
  if (typeof value === 'object') {
    const copy = {};
    for (const [k, v] of Object.entries(value)) copy[k] = clone(v);
    return copy;
  }
  return value;
}

function getField(obj, fieldPath) {
  if (!obj || typeof obj !== 'object') return undefined;
  const parts = fieldPath.split('.');
  let current = obj;
  for (const part of parts) {
    if (current === undefined || current === null) return undefined;
    current = current[part];
  }
  return current;
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
  collection(name) { return this.db.collection(`${this.path}/${this.id}/${name}`); }
}

class FakeQuery {
  constructor(db, path, filters = [], maximum = Infinity, cursor = null) {
    this.db = db;
    this.path = path;
    this.filters = filters;
    this.maximum = maximum;
    this.cursor = cursor;
  }
  where(field, operator, value) {
    return new FakeQuery(this.db, this.path, [...this.filters, { field, operator, value }], this.maximum);
  }
  orderBy() { return this; }
  limit(maximum) { return new FakeQuery(this.db, this.path, this.filters, maximum, this.cursor); }
  startAt() { return this; }
  endAt() { return this; }
  startAfter(...args) {
    const id = args.length === 1 && args[0]?.id ? args[0].id : (args.length > 1 ? args[args.length - 1] : args[0]);
    return new FakeQuery(this.db, this.path, this.filters, this.maximum, typeof id === 'string' ? id : null);
  }
  async get() {
    const collection = this.db.data[this.path] || {};
    const docs = Object.entries(collection)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .filter(([id]) => this.cursor === null || id > this.cursor)
      .filter(([, docValue]) => this.filters.every(filter => {
        const val = getField(docValue, filter.field);
        if (filter.operator === '==') return val === filter.value;
        if (filter.operator === '>=') return val >= filter.value;
        if (filter.operator === '<=') return val <= filter.value;
        if (filter.operator === '>') return val > filter.value;
        if (filter.operator === '<') return val < filter.value;
        return false;
      }))
      .slice(0, this.maximum)
      .map(([id, docValue]) => new FakeDocumentSnapshot(this.db.collection(this.path).doc(id), docValue));
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
    this.lastTransactionUpdates = [];
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
        get: async (ref) => this._snapshot(ref.path, ref.id, working),
        set: (ref, value, options) => {
          this.lastTransactionUpdates.push({ type: 'set', ref, value: clone(value) });
          this._set(ref.path, ref.id, value, options, working);
        },
        create: (ref, value) => {
          if (working[ref.path]?.[ref.id] !== undefined) throw new Error('Document exists');
          this.lastTransactionUpdates.push({ type: 'create', ref, value: clone(value) });
          this._set(ref.path, ref.id, value, {}, working);
        },
        update: (ref, value) => {
          this.lastTransactionUpdates.push({ type: 'update', ref, value: clone(value) });
          this._update(ref.path, ref.id, value, working);
        },
        delete: (ref) => {
          this.lastTransactionUpdates.push({ type: 'delete', ref });
          this._delete(ref.path, ref.id, working);
        },
      };
      const result = await callback(transaction);
      this.data = working;
      return result;
    };
    const result = this._transactionTail.then(run, run);
    this._transactionTail = result.catch(() => {});
    return result;
  }
  _snapshot(path, id, source) {
    const value = source[path]?.[id];
    return new FakeDocumentSnapshot(new FakeDocumentReference(this, path, id), value);
  }
  _set(path, id, value, options = {}, target) {
    if (!target[path]) target[path] = {};
    const resolved = resolveTransforms(value);
    if (options.merge && target[path][id]) {
      target[path][id] = { ...target[path][id], ...resolved };
    } else {
      target[path][id] = resolved;
    }
  }
  _update(path, id, value, target) {
    if (!target[path]?.[id]) throw new Error(`Document ${path}/${id} does not exist`);
    target[path][id] = { ...target[path][id], ...resolveTransforms(value) };
  }
  _delete(path, id, target) {
    if (target[path]) delete target[path][id];
  }
}

class FakeTaskQueue {
  constructor() {
    this.enqueuedTasks = [];
    this.taskMap = new Map();
  }
  async enqueue(payload, options = {}) {
    if (options.id && this.taskMap.has(options.id)) {
      const err = new Error(`Task ${options.id} already exists`);
      err.code = 'functions/task-already-exists';
      throw err;
    }
    const task = { payload, options, id: options.id || `auto-task-${this.enqueuedTasks.length + 1}` };
    this.enqueuedTasks.push(task);
    if (options.id) this.taskMap.set(options.id, task);
    return task;
  }
}

module.exports = {
  FakeFirestore,
  FakeTimestamp,
  FakeTaskQueue,
  FakeFieldValue,
  FakeServerTimestampTransform,
  isServerTimestampSentinel,
};
