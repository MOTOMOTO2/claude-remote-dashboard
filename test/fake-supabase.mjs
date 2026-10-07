// A stand-in for @supabase/supabase-js, big enough for the query shapes the
// dashboard actually uses: select/order/limit/in, insert().select().single(),
// update().eq(), delete().eq(), auth, and realtime channels.

export const fake = {
  session: null,
  tables: { jobs: [], projects: [], usage_windows: [], job_events: [], hosts: [] },
  inserts: [],
  updates: [],
  deletes: [],
  channels: [],
  authCallbacks: [],

  reset() {
    this.tables = { jobs: [], projects: [], usage_windows: [], job_events: [], hosts: [] };
    this.inserts = [];
    this.updates = [];
    this.deletes = [];
    this.channels = [];
    this.authCallbacks = [];
    this.session = null;
  },

  /** Push a realtime row to whatever subscribed to that table. */
  emit(table, eventType, row, old = null) {
    for (const ch of this.channels) {
      for (const h of ch.handlers) {
        if (h.filter.table !== table) continue;
        if (h.filter.event !== '*' && h.filter.event !== eventType) continue;
        h.cb({ eventType, table, new: row, old });
      }
    }
  },

  signIn(session = { user: { id: 'u1' } }) {
    this.session = session;
    for (const cb of this.authCallbacks) cb('SIGNED_IN', session);
  },
};

const ok = (data) => ({ data, error: null });

class Query {
  constructor(table) {
    this.table = table;
    this.rows = [...(fake.tables[table] ?? [])];
    this.mode = 'select';
    this.payload = null;
    this.one = false;
  }

  select() { return this; }

  order(col, opts = {}) {
    const dir = opts.ascending === false ? -1 : 1;
    this.rows.sort((a, b) => {
      const x = a[col] ?? '';
      const y = b[col] ?? '';
      return x < y ? -dir : x > y ? dir : 0;
    });
    return this;
  }

  limit(n) { this.rows = this.rows.slice(0, n); return this; }

  in(col, values) {
    this.rows = this.rows.filter((r) => values.includes(r[col]));
    return this;
  }

  eq(col, value) {
    this.rows = this.rows.filter((r) => r[col] === value);
    if (this.mode === 'update') {
      fake.updates.push({ table: this.table, where: [col, value], patch: this.payload });
      for (const r of fake.tables[this.table]) {
        if (r[col] === value) Object.assign(r, this.payload);
      }
    }
    if (this.mode === 'delete') {
      fake.deletes.push({ table: this.table, where: [col, value] });
      fake.tables[this.table] = fake.tables[this.table].filter((r) => r[col] !== value);
    }
    return this;
  }

  insert(row) {
    this.mode = 'insert';
    const stored = { id: `new-${fake.inserts.length + 1}`, status: 'queued', ...row };
    fake.inserts.push(stored);
    fake.tables[this.table].push(stored);
    this.rows = [stored];
    Promise.resolve().then(() => fake.emit(this.table, 'INSERT', stored));
    return this;
  }

  update(patch) { this.mode = 'update'; this.payload = patch; return this; }
  delete() { this.mode = 'delete'; return this; }
  single() { this.one = true; return this; }

  then(resolve) {
    const data = this.one ? (this.rows[0] ?? null) : this.rows;
    return Promise.resolve(ok(data)).then(resolve);
  }
}

export function createClient() {
  return {
    from: (table) => new Query(table),

    auth: {
      getSession: async () => ok({ session: fake.session }),
      getUser: async () => ok({ user: fake.session?.user ?? null }),
      signInWithPassword: async ({ email }) => {
        if (!email.includes('@')) return { data: null, error: { message: 'Invalid email' } };
        fake.signIn();
        return ok({});
      },
      signOut: async () => {
        fake.session = null;
        for (const cb of fake.authCallbacks) cb('SIGNED_OUT', null);
        return ok({});
      },
      onAuthStateChange: (cb) => {
        fake.authCallbacks.push(cb);
        return { data: { subscription: { unsubscribe() {} } } };
      },
    },

    channel(name) {
      const ch = {
        name,
        handlers: [],
        on(_type, filter, cb) { this.handlers.push({ filter, cb }); return this; },
        subscribe(cb) { cb?.('SUBSCRIBED'); return this; },
      };
      fake.channels.push(ch);
      return ch;
    },

    removeChannel(ch) {
      fake.channels = fake.channels.filter((c) => c !== ch);
    },
  };
}
