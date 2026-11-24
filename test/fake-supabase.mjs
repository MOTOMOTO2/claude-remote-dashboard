// A stand-in for @supabase/supabase-js, big enough for the query shapes the
// dashboard actually uses: select/order/limit/in, insert().select().single(),
// update().eq(), upsert({ onConflict }), delete().eq(), auth, and realtime
// channels.
//
// And the ways a real one goes wrong, for the outbox: no network at all
// (`offline`), a write that lands but whose answer is lost on the way back
// (`loseAnswer`), a unique key refusing a second copy (23505, on `id` and
// `client_id`), and a table that hasn't had a column added yet
// (`missingColumns`, PGRST204).

export const fake = {
  session: null,
  tables: {
    jobs: [], projects: [], usage_windows: [], job_events: [], hosts: [], settings: [],
    chats: [], chat_messages: [], assistants: [],
    house_devices: [], house_hubs: [], house_commands: [],
    field_sites: [], field_reports: [],
  },
  /** table -> error, so a read can be made to fail the way a real one does. */
  failures: {},
  /** No network: every request fails the way fetch does, and nothing is written. */
  offline: false,
  /** table -> true: the next write to it lands, but its answer never arrives. */
  loseAnswer: {},
  /** table -> [columns]: an insert naming one is refused, as PostgREST does. */
  missingColumns: {},
  inserts: [],
  updates: [],
  upserts: [],
  deletes: [],
  channels: [],
  authCallbacks: [],

  reset() {
    this.tables = {
      jobs: [], projects: [], usage_windows: [], job_events: [], hosts: [], settings: [],
    chats: [], chat_messages: [], assistants: [],
    house_devices: [], house_hubs: [], house_commands: [],
    field_sites: [], field_reports: [],
    };
    this.failures = {};
    this.offline = false;
    this.loseAnswer = {};
    this.missingColumns = {};
    this.inserts = [];
    this.updates = [];
    this.upserts = [];
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

  /** Make every read of one table error until it is called with null. */
  failTable(table, message) {
    if (message) this.failures[table] = { message };
    else delete this.failures[table];
  },

  signIn(session = { user: { id: 'u1' } }) {
    this.session = session;
    for (const cb of this.authCallbacks) cb('SIGNED_IN', session);
  },
};

const ok = (data) => ({ data, error: null });

/** What supabase-js hands back when fetch itself throws. */
const NO_NETWORK = {
  data: null,
  error: { message: 'TypeError: Failed to fetch', details: '', hint: '', code: '' },
  count: null,
  status: 0,
  statusText: '',
};

/** Column defaults the real schema has and the generic `status: 'queued'` gets wrong. */
const DEFAULTS = {
  field_sites: { status: 'unvisited', last_report_at: null },
};

/**
 * What bridge/schema.sql's two triggers do to a report: the server's own
 * receipt time, and the site taking the status of its newest report — newest
 * by when it was recorded, so a late one cannot overwrite a fresher one.
 */
function reportTrigger(report) {
  report.received_at = new Date().toISOString();
  report.recorded_at ??= report.received_at;
  const site = fake.tables.field_sites.find((s) => s.id === report.site_id);
  if (!site) return;
  if (!site.last_report_at || Date.parse(site.last_report_at) <= Date.parse(report.recorded_at)) {
    site.status = report.status;
    site.last_report_at = report.recorded_at;
  }
}

class Query {
  constructor(table) {
    this.table = table;
    this.rows = [...(fake.tables[table] ?? [])];
    this.mode = 'select';
    this.payload = null;
    this.one = false;
    this.error = null;
    // Decided when the request is made, as a real one would be.
    this.offline = fake.offline;
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
    if (this.offline) return this;
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

  /** One row, or several — a room's worth of taps goes in as an array. */
  insert(rows) {
    this.mode = 'insert';
    const given = Array.isArray(rows) ? rows : [rows];
    if (this.offline) { this.rows = []; return this; }

    // One statement: if any row is refused, none of them go in.
    const missing = (fake.missingColumns[this.table] ?? [])
      .find((col) => given.some((row) => col in row));
    if (missing) {
      this.error = { code: 'PGRST204', status: 400,
        message: `Could not find the '${missing}' column of '${this.table}' in the schema cache` };
      this.rows = [];
      return this;
    }
    const table = (fake.tables[this.table] ??= []);
    const clash = given.find((row) => table.some((r) =>
      (row.id != null && r.id === row.id)
      || (row.client_id != null && r.client_id === row.client_id)));
    if (clash) {
      this.error = { code: '23505', status: 409,
        message: `duplicate key value violates unique constraint "${this.table}_pkey"` };
      this.rows = [];
      return this;
    }

    const list = given.map((row) => {
      const stored = {
        id: `new-${fake.inserts.length + 1}`, status: 'queued', ...(DEFAULTS[this.table] ?? {}), ...row,
      };
      if (this.table === 'field_reports') reportTrigger(stored);
      fake.inserts.push(stored);
      (fake.tables[this.table] ??= []).push(stored);
      return stored;
    });
    this.rows = list;
    Promise.resolve().then(() => {
      for (const stored of list) fake.emit(this.table, 'INSERT', stored);
    });
    return this;
  }

  /** Insert or merge on one key — how a per-owner settings row is written. */
  upsert(row, opts = {}) {
    this.mode = 'upsert';
    if (this.offline) return this;
    const key = opts.onConflict ?? 'id';
    const table = (fake.tables[this.table] ??= []);
    const found = table.find((r) => r[key] === row[key]);
    if (found) Object.assign(found, row);
    else table.push({ ...row });
    fake.upserts.push({ table: this.table, row, onConflict: key });
    this.rows = [found ?? row];
    return this;
  }

  update(patch) { this.mode = 'update'; this.payload = patch; return this; }
  delete() { this.mode = 'delete'; return this; }
  single() { this.one = true; return this; }

  then(resolve) {
    if (this.offline) return Promise.resolve({ ...NO_NETWORK }).then(resolve);
    if (this.mode !== 'select' && fake.loseAnswer[this.table]) {
      // It landed; the phone just never heard.
      delete fake.loseAnswer[this.table];
      return Promise.resolve({ ...NO_NETWORK }).then(resolve);
    }
    if (this.error) {
      const { status, ...error } = this.error;
      return Promise.resolve({ data: null, error, status }).then(resolve);
    }
    const failure = fake.failures[this.table];
    if (failure) return Promise.resolve({ data: null, error: failure }).then(resolve);
    const data = this.one ? (this.rows[0] ?? null) : this.rows;
    return Promise.resolve({ ...ok(data), status: this.mode === 'insert' ? 201 : 200 }).then(resolve);
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
