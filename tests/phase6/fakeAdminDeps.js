'use strict';

const { Timestamp, FieldValue } = require('firebase-admin/firestore');

class FakeFirestore {
  constructor(initialData = {}) {
    this.data = {};
    for (const [coll, docs] of Object.entries(initialData)) {
      this.data[coll] = {};
      for (const [id, docData] of Object.entries(docs)) {
        this.data[coll][id] = JSON.parse(JSON.stringify(docData, (k, v) => {
          if (v instanceof Timestamp) {
            return { _type: 'Timestamp', seconds: v.seconds, nanoseconds: v.nanoseconds };
          }
          return v;
        }), (k, v) => {
          if (v && v._type === 'Timestamp') {
            return new Timestamp(v.seconds, v.nanoseconds);
          }
          return v;
        });
      }
    }
    this._autoIdCounter = 1;
    this.writeLog = [];
  }

  collection(name) {
    if (!this.data[name]) this.data[name] = {};
    const self = this;
    return {
      doc(id) {
        const docId = id || `auto_${name}_${self._autoIdCounter++}`;
        return {
          id: docId,
          path: `${name}/${docId}`,
          collectionName: name,
        };
      },
    };
  }

  async runTransaction(updateFunction) {
    const stagedWrites = [];
    const tx = {
      get: async (ref) => {
        const coll = this.data[ref.collectionName] || {};
        const docData = coll[ref.id];
        if (!docData) {
          return { exists: false, data: () => undefined, id: ref.id, ref };
        }
        // Deep copy preserving Timestamps
        const copy = JSON.parse(JSON.stringify(docData, (k, v) => {
          if (v instanceof Timestamp) {
            return { _type: 'Timestamp', seconds: v.seconds, nanoseconds: v.nanoseconds };
          }
          return v;
        }), (k, v) => {
          if (v && v._type === 'Timestamp') {
            return new Timestamp(v.seconds, v.nanoseconds);
          }
          return v;
        });
        return { exists: true, data: () => copy, id: ref.id, ref };
      },
      create: (ref, data) => {
        const coll = this.data[ref.collectionName] || {};
        if (coll[ref.id]) {
          const err = new Error(`Document already exists: ${ref.path}`);
          err.code = 6; // ALREADY_EXISTS
          throw err;
        }
        stagedWrites.push({ type: 'create', ref, data });
      },
      update: (ref, data) => {
        const coll = this.data[ref.collectionName] || {};
        if (!coll[ref.id]) {
          const err = new Error(`Document does not exist: ${ref.path}`);
          err.code = 5; // NOT_FOUND
          throw err;
        }
        stagedWrites.push({ type: 'update', ref, data });
      },
      set: (ref, data) => {
        stagedWrites.push({ type: 'set', ref, data });
      },
    };

    const result = await updateFunction(tx);

    // Commit staged writes
    const now = Timestamp.now();
    for (const write of stagedWrites) {
      const { type, ref, data } = write;
      if (!this.data[ref.collectionName]) this.data[ref.collectionName] = {};
      const coll = this.data[ref.collectionName];

      const resolved = JSON.parse(JSON.stringify(data, (k, v) => {
        if (v instanceof Timestamp) {
          return { _type: 'Timestamp', seconds: v.seconds, nanoseconds: v.nanoseconds };
        }
        if (v && (v._methodName === 'serverTimestamp' || v.constructor?.name === 'ServerTimestampTransform')) {
          return { _type: 'Timestamp', seconds: now.seconds, nanoseconds: now.nanoseconds };
        }
        return v;
      }), (k, v) => {
        if (v && v._type === 'Timestamp') {
          return new Timestamp(v.seconds, v.nanoseconds);
        }
        return v;
      });

      if (type === 'create') {
        if (coll[ref.id]) {
          const err = new Error(`Document already exists: ${ref.path}`);
          err.code = 6;
          throw err;
        }
        coll[ref.id] = resolved;
      } else if (type === 'update') {
        if (!coll[ref.id]) {
          const err = new Error(`Document does not exist: ${ref.path}`);
          err.code = 5;
          throw err;
        }
        coll[ref.id] = { ...coll[ref.id], ...resolved };
      } else if (type === 'set') {
        coll[ref.id] = resolved;
      }
      this.writeLog.push({ type, path: ref.path, data: resolved });
    }

    return result;
  }
}

class FakeAuth {
  constructor(users = {}, tokens = {}) {
    this.users = users;
    this.tokens = tokens;
  }

  async verifyIdToken(token, checkRevoked = true) {
    const tokenData = this.tokens[token];
    if (!tokenData) {
      const err = new Error('Invalid token');
      err.code = 'auth/argument-error';
      throw err;
    }
    if (tokenData.revoked && checkRevoked) {
      const err = new Error('Token is revoked');
      err.code = 'auth/id-token-revoked';
      throw err;
    }
    if (tokenData.expired) {
      const err = new Error('Token is expired');
      err.code = 'auth/id-token-expired';
      throw err;
    }
    return { ...tokenData };
  }

  async getUser(uid) {
    const user = this.users[uid];
    if (!user) {
      const err = new Error('User not found');
      err.code = 'auth/user-not-found';
      throw err;
    }
    return { ...user };
  }
}

class FakeStorage {
  constructor(files = {}, bucketName = 'demo-towmitra-admin.appspot.com') {
    this.files = files;
    this.bucketName = bucketName;
  }

  bucket(name) {
    const bName = name || this.bucketName;
    const self = this;
    return {
      name: bName,
      file(filePath) {
        return {
          name: filePath,
          async exists() {
            return [Boolean(self.files[filePath])];
          },
          async getMetadata() {
            const meta = self.files[filePath];
            if (!meta) {
              const err = new Error(`File not found: ${filePath}`);
              err.code = 404;
              throw err;
            }
            return [meta];
          },
        };
      },
    };
  }
}

module.exports = {
  FakeFirestore,
  FakeAuth,
  FakeStorage,
  Timestamp,
  FieldValue,
};
