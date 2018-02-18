import {DB} from 'sharedb';
import pg from 'pg';

// Postgres-backed ShareDB database

class PostgresDB {
  constructor(options) {
    DB.call(this, options);

    this.closed = false;

    this.pg_config = options;
  }

  close(callback) {
    this.closed = true;
    if (callback) callback();
  }

  // Persists an op and snapshot if it is for the next version. Calls back with
  // callback(err, succeeded)
  commit(collection, id, op, snapshot, options, callback) {
    /*
     * op: CreateOp {
     *   src: '24545654654646',
     *   seq: 1,
     *   v: 0,
     *   create: { type: 'http://sharejs.org/types/JSONv0', data: { ... } },
     *   m: { ts: 12333456456 } }
     * }
     * snapshot: PostgresSnapshot
     */
    pg.connect(this.pg_config, (err, client, done) => {
      if (err) {
        done(client);
        callback(err);
        return;
      }
      function commit() {
        client.query('COMMIT', err => {
          done(err);
          if (err) {
            callback(err);
          } else {
            callback(null, true);
          }
        })
      }
      client.query(
        'SELECT max(version) AS max_version FROM ops WHERE collection = $1 AND doc_id = $2',
        [collection, id],
        (err, res) => {
          let max_version = res.rows[0].max_version;
          if (max_version == null)
            max_version = 0;
          if (snapshot.v !== max_version + 1) {
            return callback(null, false);
          }
          client.query('BEGIN', err => {
            client.query(
              'INSERT INTO ops (collection, doc_id, version, operation) VALUES ($1, $2, $3, $4)',
              [collection, id, snapshot.v, op],
              (err, res) => {
                if (err) {
                  // TODO: if err is "constraint violation", callback(null, false) instead
                  rollback(client, done);
                  callback(err);
                  return;
                }
                if (snapshot.v === 1) {
                  client.query(
                    'INSERT INTO snapshots (collection, doc_id, doc_type, version, data) VALUES ($1, $2, $3, $4, $5)',
                    [collection, id, snapshot.type, snapshot.v, snapshot.data],
                    (err, res) => {
                      // TODO:
                      // if the insert was successful and did insert, callback(null, true)
                      // if the insert was successful and did not insert, callback(null, false)
                      // if there was an error, rollback and callback(error)
                      if (err) {
                        rollback(client, done);
                        callback(err);
                        return;
                      }
                      commit();
                    }
                  )
                } else {
                  client.query(
                    'UPDATE snapshots SET doc_type = $3, version = $4, data = $5 WHERE collection = $1 AND doc_id = $2 AND version = ($4 - 1)',
                    [collection, id, snapshot.type, snapshot.v, snapshot.data],
                    (err, res) => {
                      // TODO:
                      // if any rows were updated, success
                      // if 0 rows were updated, rollback and not success
                      // if error, rollback and not success
                      if (err) {
                        rollback(client, done);
                        callback(err);
                        return;
                      }
                      commit();
                    }
                  )
                }
              }
            )
          })
        }
      )
    })
  }

  // Get the named document from the database. The callback is called with (err,
  // snapshot). A snapshot with a version of zero is returned if the docuemnt
  // has never been created in the database.
  getSnapshot(collection, id, fields, options, callback) {
    pg.connect(this.pg_config, (err, client, done) => {
      if (err) {
        done(client);
        callback(err);
        return;
      }
      client.query(
        'SELECT version, data, doc_type FROM snapshots WHERE collection = $1 AND doc_id = $2 LIMIT 1',
        [collection, id],
        (err, res) => {
          done();
          if (err) {
            callback(err);
            return;
          }
          if (res.rows.length) {
            const row = res.rows[0];
            var snapshot = new PostgresSnapshot(
              id,
              row.version,
              row.doc_type,
              row.data,
              undefined // TODO: metadata
            )
            callback(null, snapshot);
          } else {
            var snapshot = new PostgresSnapshot(
              id,
              0,
              null,
              undefined,
              undefined
            )
            callback(null, snapshot);
          }
        }
      )
    })
  }

  // Get operations between [from, to) noninclusively. (Ie, the range should
  // contain start but not end).
  //
  // If end is null, this function should return all operations from start onwards.
  //
  // The operations that getOps returns don't need to have a version: field.
  // The version will be inferred from the parameters if it is missing.
  //
  // Callback should be called as callback(error, [list of ops]);
  getOps(collection, id, from, to, options, callback) {
    pg.connect(this.pg_config, (err, client, done) => {
      if (err) {
        done(client);
        callback(err);
        return;
      }
      client.query(
        'SELECT version, operation FROM ops WHERE collection = $1 AND doc_id = $2 AND version >= $3 AND version < $4',
        [collection, id, from, to],
        (err, res) => {
          done();
          if (err) {
            callback(err);
            return;
          }
          callback(null, res.rows.map(row => row.operation));
        }
      )
    })
  }
}

export default PostgresDB;

PostgresDB.prototype = Object.create(DB.prototype);

function rollback(client, done) {
  client.query('ROLLBACK', err => done(err))
}

function PostgresSnapshot(id, version, type, data, meta) {
  this.id = id;
  this.v = version;
  this.type = type;
  this.data = data;
  this.m = meta;
}