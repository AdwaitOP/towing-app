'use strict';

const { GeoPoint } = require('firebase-admin/firestore');

// Do not import Phase 3's fakeDeps: it globally replaces module loading.
class FakeTimestamp {
  constructor(ms) { this.ms = ms; }
  static fromMillis(ms) { return new FakeTimestamp(ms); }
  toMillis() { return this.ms; }
  toDate() { return new Date(this.ms); }
}

function clone(value) {
  if (value === undefined || value === null) return value;
  if (value instanceof FakeTimestamp) return new FakeTimestamp(value.toMillis());
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
  limit(maximum) { return new FakeQuery(this.db, this.path, this.filters, maximum); }
  startAfter(snapshot) { return new FakeQuery(this.db, this.path, this.filters, this.maximum, snapshot.id); }
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
        set: (ref, value, options) => this._set(ref.path, ref.id, value, options, working),
        create: (ref, value) => {
          if (working[ref.path]?.[ref.id] !== undefined) throw new Error('Document exists');
          this._set(ref.path, ref.id, value, {}, working);
        },
        update: (ref, value) => this._update(ref.path, ref.id, value, working),
        delete: (ref) => this._delete(ref.path, ref.id, working),
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
    if (options.merge && target[path][id]) {
      target[path][id] = { ...target[path][id], ...clone(value) };
    } else {
      target[path][id] = clone(value);
    }
  }
  _update(path, id, value, target) {
    if (!target[path]?.[id]) throw new Error(`Document ${path}/${id} does not exist`);
    target[path][id] = { ...target[path][id], ...clone(value) };
  }
  _delete(path, id, target) {
    if (target[path]) delete target[path][id];
  }
}

module.exports = {
  FakeFirestore,
  FakeTimestamp,
};
