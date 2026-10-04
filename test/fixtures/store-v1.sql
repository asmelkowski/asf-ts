-- Original schema from bd82062e27407e6cec6799ef22d632a123186d33.
PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, identity TEXT NOT NULL, status TEXT NOT NULL, error TEXT, pid INTEGER, owner TEXT, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS actions(run TEXT NOT NULL REFERENCES runs(id), id TEXT NOT NULL, identity TEXT NOT NULL, status TEXT NOT NULL, result TEXT, error TEXT, PRIMARY KEY(run,id));
      CREATE TABLE IF NOT EXISTS budgets(id TEXT PRIMARY KEY, max INTEGER NOT NULL, soft REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS invocations(id TEXT PRIMARY KEY, run TEXT NOT NULL, action TEXT NOT NULL, turn INTEGER NOT NULL, status TEXT NOT NULL, receipt TEXT, session TEXT, kind TEXT NOT NULL, paid INTEGER NOT NULL, budget TEXT REFERENCES budgets(id), created INTEGER NOT NULL, UNIQUE(run,action,turn), FOREIGN KEY(run,action) REFERENCES actions(run,id));
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, run TEXT NOT NULL, binding TEXT NOT NULL, native TEXT NOT NULL, busy TEXT);
      CREATE TABLE IF NOT EXISTS reports(invocation TEXT NOT NULL REFERENCES invocations(id), key TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(invocation,key));
      CREATE TABLE IF NOT EXISTS ledger(invocation TEXT PRIMARY KEY REFERENCES invocations(id), data TEXT NOT NULL, usd REAL, complete INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS events(cursor INTEGER PRIMARY KEY AUTOINCREMENT, run TEXT NOT NULL, action TEXT, invocation TEXT, turn INTEGER, source TEXT, time INTEGER NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS event_run ON events(run,cursor);
      CREATE TRIGGER IF NOT EXISTS ledger_immutable BEFORE UPDATE ON ledger BEGIN SELECT RAISE(ABORT,'immutable ledger'); END;
      CREATE TRIGGER IF NOT EXISTS ledger_no_delete BEFORE DELETE ON ledger BEGIN SELECT RAISE(ABORT,'immutable ledger'); END;
      CREATE TRIGGER IF NOT EXISTS report_no_delete BEFORE DELETE ON reports BEGIN SELECT RAISE(ABORT,'immutable report'); END;
      CREATE TRIGGER IF NOT EXISTS receipt_immutable BEFORE UPDATE OF receipt ON invocations WHEN OLD.receipt IS NOT NULL BEGIN SELECT RAISE(ABORT,'immutable receipt'); END;
      CREATE TRIGGER IF NOT EXISTS report_immutable BEFORE UPDATE ON reports BEGIN SELECT RAISE(ABORT,'immutable report'); END;
      PRAGMA user_version=1;
