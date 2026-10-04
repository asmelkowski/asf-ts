import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { encode, parse, clip, positive, boundedJson, hash } from "./util.js";
import {
  validateAccounting,
  knownUsd,
  strongestAccounting,
} from "./accounting.js";
import type { Accounting, Json, NativeSession, Receipt } from "./types.js";
import { WorkflowTimeoutError } from "./composition.js";

import type { Inspection, RunSummary, EventRow } from "./inspection.js";
export type { EventRow } from "./inspection.js";

type Row = Record<string, string | number | null>;
export interface ActionRow {
  id: string;
  identity: string;
  status: string;
  result: string | null;
  error: string | null;
}
export interface InvocationRow {
  id: string;
  turn: number;
  status: string;
  receipt: string | null;
  session: string | null;
}
export interface Budget {
  id: string;
  maxDispatches: number;
  softUsd: number;
}
export interface WorkflowBinding {
  definitionIdentity: string;
  inputIdentity: string;
  input: Json;
  parentInvocation: string | null;
  attempt: number;
  maxDispatches: number | null;
  timeoutMs: number;
}
export interface WorkflowRow {
  id: string;
  parent: string | null;
  definition: string;
  binding: string;
  deadline: number;
  status: string;
  raw: string | null;
  result: string | null;
  error: string | null;
}
export interface WorkflowInspection {
  offset: number;
  limit: number;
  counts: {
    documents: number;
    definitions: number;
    workflows: number;
    actions: number;
  };
  documents: { identity: string; value: Json }[];
  definitions: {
    identity: string;
    value: Json;
    documentIdentity: string | null;
  }[];
  workflows: (Omit<WorkflowRow, "binding" | "raw" | "result"> & {
    binding: WorkflowBinding;
    raw: Json | null;
    result: Json | null;
    dispatchesUsed: number;
  })[];
  actions: {
    id: string;
    kind: string;
    workflow: string | null;
    metadata: Json | null;
  }[];
}
export class Store {
  readonly db: DatabaseSync;
  constructor(
    readonly path: string,
    readonly readOnly = false,
  ) {
    if (!readOnly) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path, { readOnly });
    this.db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
    const version = Number(
      this.db.prepare("PRAGMA user_version").get()?.user_version,
    );
    if (version !== 0 && version !== 1)
      throw new Error(`Unsupported database version ${version}`);
    if (readOnly) {
      if (version !== 1) throw new Error("Not an ASF database");
      return;
    }
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, identity TEXT NOT NULL, status TEXT NOT NULL, error TEXT, pid INTEGER, owner TEXT, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS actions(run TEXT NOT NULL REFERENCES runs(id), id TEXT NOT NULL, identity TEXT NOT NULL, status TEXT NOT NULL, result TEXT, error TEXT, PRIMARY KEY(run,id));
      CREATE TABLE IF NOT EXISTS budgets(id TEXT PRIMARY KEY, max INTEGER NOT NULL, soft REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS invocations(id TEXT PRIMARY KEY, run TEXT NOT NULL, action TEXT NOT NULL, turn INTEGER NOT NULL, status TEXT NOT NULL, receipt TEXT, session TEXT, kind TEXT NOT NULL, paid INTEGER NOT NULL, budget TEXT REFERENCES budgets(id), created INTEGER NOT NULL, UNIQUE(run,action,turn), FOREIGN KEY(run,action) REFERENCES actions(run,id));
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, run TEXT NOT NULL, binding TEXT NOT NULL, native TEXT NOT NULL, busy TEXT);
      CREATE TABLE IF NOT EXISTS reports(invocation TEXT NOT NULL REFERENCES invocations(id), key TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(invocation,key));
      CREATE TABLE IF NOT EXISTS ledger(invocation TEXT PRIMARY KEY REFERENCES invocations(id), data TEXT NOT NULL, usd REAL, complete INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS events(cursor INTEGER PRIMARY KEY AUTOINCREMENT, run TEXT NOT NULL, action TEXT, invocation TEXT, turn INTEGER, source TEXT, time INTEGER NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS event_run ON events(run,cursor);
      CREATE TABLE IF NOT EXISTS workflow_documents(run TEXT NOT NULL REFERENCES runs(id), identity TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(run,identity));
      CREATE TABLE IF NOT EXISTS workflow_definitions(run TEXT NOT NULL REFERENCES runs(id), identity TEXT NOT NULL, value TEXT NOT NULL, document TEXT, PRIMARY KEY(run,identity), FOREIGN KEY(run,document) REFERENCES workflow_documents(run,identity));
      CREATE TABLE IF NOT EXISTS workflows(run TEXT NOT NULL REFERENCES runs(id), id TEXT NOT NULL, parent TEXT, definition TEXT NOT NULL, binding TEXT NOT NULL, deadline INTEGER NOT NULL, status TEXT NOT NULL, raw TEXT, result TEXT, error TEXT, PRIMARY KEY(run,id), FOREIGN KEY(run,parent) REFERENCES workflows(run,id), FOREIGN KEY(run,definition) REFERENCES workflow_definitions(run,identity));
      CREATE TABLE IF NOT EXISTS action_owners(run TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, workflow TEXT, metadata TEXT, PRIMARY KEY(run,id), FOREIGN KEY(run,id) REFERENCES actions(run,id), FOREIGN KEY(run,workflow) REFERENCES workflows(run,id));
      CREATE TABLE IF NOT EXISTS workflow_usage(run TEXT NOT NULL, workflow TEXT NOT NULL, invocation TEXT NOT NULL REFERENCES invocations(id), PRIMARY KEY(run,workflow,invocation), FOREIGN KEY(run,workflow) REFERENCES workflows(run,id));
      CREATE TRIGGER IF NOT EXISTS workflow_binding_immutable BEFORE UPDATE OF binding,deadline,definition,parent ON workflows BEGIN SELECT RAISE(ABORT,'immutable workflow binding'); END;
      CREATE TRIGGER IF NOT EXISTS workflow_raw_immutable BEFORE UPDATE OF raw ON workflows WHEN OLD.raw IS NOT NULL BEGIN SELECT RAISE(ABORT,'immutable workflow raw result'); END;
      CREATE TRIGGER IF NOT EXISTS workflow_result_immutable BEFORE UPDATE OF result ON workflows WHEN OLD.result IS NOT NULL BEGIN SELECT RAISE(ABORT,'immutable workflow result'); END;
      CREATE TRIGGER IF NOT EXISTS workflow_document_immutable BEFORE UPDATE ON workflow_documents BEGIN SELECT RAISE(ABORT,'immutable workflow document'); END;
      CREATE TRIGGER IF NOT EXISTS workflow_definition_immutable BEFORE UPDATE ON workflow_definitions BEGIN SELECT RAISE(ABORT,'immutable workflow definition'); END;
      CREATE TRIGGER IF NOT EXISTS action_owner_immutable BEFORE UPDATE ON action_owners BEGIN SELECT RAISE(ABORT,'immutable action owner'); END;
      CREATE TRIGGER IF NOT EXISTS workflow_usage_immutable BEFORE UPDATE ON workflow_usage BEGIN SELECT RAISE(ABORT,'immutable workflow usage'); END;
      CREATE TRIGGER IF NOT EXISTS workflow_usage_no_delete BEFORE DELETE ON workflow_usage BEGIN SELECT RAISE(ABORT,'immutable workflow usage'); END;
      CREATE TRIGGER IF NOT EXISTS ledger_immutable BEFORE UPDATE ON ledger BEGIN SELECT RAISE(ABORT,'immutable ledger'); END;
      CREATE TRIGGER IF NOT EXISTS ledger_no_delete BEFORE DELETE ON ledger BEGIN SELECT RAISE(ABORT,'immutable ledger'); END;
      CREATE TRIGGER IF NOT EXISTS report_no_delete BEFORE DELETE ON reports BEGIN SELECT RAISE(ABORT,'immutable report'); END;
      CREATE TRIGGER IF NOT EXISTS receipt_immutable BEFORE UPDATE OF receipt ON invocations WHEN OLD.receipt IS NOT NULL BEGIN SELECT RAISE(ABORT,'immutable receipt'); END;
      CREATE TRIGGER IF NOT EXISTS report_immutable BEFORE UPDATE ON reports BEGIN SELECT RAISE(ABORT,'immutable report'); END;
      PRAGMA user_version=1;`);
  }
  close(): void {
    this.db.close();
  }
  workflow(run: string, id: string): WorkflowRow | undefined {
    return this.db
      .prepare("SELECT * FROM workflows WHERE run=? AND id=?")
      .get(run, id) as unknown as WorkflowRow | undefined;
  }
  assertNamespace(run: string, id: string, owner: string | null): void {
    const rows = this.db
      .prepare("SELECT id FROM workflows WHERE run=?")
      .all(run);
    const expected =
      rows
        .map((row) => String(row.id))
        .filter((prefix) => id.startsWith(prefix + "/"))
        .sort((a, b) => b.length - a.length)[0] ?? null;
    if (expected !== owner)
      throw new Error("Workflow namespace belongs to another scope");
  }
  bindWorkflow(
    run: string,
    id: string,
    binding: WorkflowBinding,
    definition: Json,
    document?: Json,
  ): WorkflowRow {
    return this.transaction(() => {
      this.assertNamespace(run, id, binding.parentInvocation);
      const old = this.workflow(run, id);
      const encoded = encode(binding);
      if (old) {
        if (old.binding !== encoded)
          throw new Error("Workflow definition, input, or limits changed");
        return old;
      }
      const occupied = this.db
        .prepare("SELECT id FROM actions WHERE run=?")
        .all(run)
        .some(
          (row) => String(row.id) === id || String(row.id).startsWith(id + "/"),
        );
      if (occupied)
        throw new Error(
          "Workflow namespace already contains unrelated actions",
        );
      const existing = this.db
        .prepare(
          "SELECT * FROM workflow_definitions WHERE run=? AND identity=?",
        )
        .get(run, binding.definitionIdentity);
      let documentIdentity: string | null = null;
      if (!existing) {
        if (document !== undefined) {
          documentIdentity = createHash("sha256")
            .update(encode(document, 1024 * 1024))
            .digest("hex");
          this.db
            .prepare("INSERT OR IGNORE INTO workflow_documents VALUES(?,?,?)")
            .run(run, documentIdentity, encode(document, 1024 * 1024));
        } else if (binding.parentInvocation) {
          documentIdentity = this.db
            .prepare(
              "SELECT d.document FROM workflows w JOIN workflow_definitions d ON d.run=w.run AND d.identity=w.definition WHERE w.run=? AND w.id=?",
            )
            .get(run, binding.parentInvocation)?.document as string | null;
        }
        this.db
          .prepare("INSERT INTO workflow_definitions VALUES(?,?,?,?)")
          .run(
            run,
            binding.definitionIdentity,
            encode(definition),
            documentIdentity,
          );
      } else if (existing.value !== encode(definition))
        throw new Error("Workflow definition identity collision");
      const parentDeadline = binding.parentInvocation
        ? this.workflow(run, binding.parentInvocation)?.deadline
        : undefined;
      const deadline = Math.min(
        Date.now() + binding.timeoutMs,
        parentDeadline ?? Infinity,
      );
      this.db
        .prepare(
          "INSERT INTO workflows VALUES(?,?,?,?,?,?,'pending',NULL,NULL,NULL)",
        )
        .run(
          run,
          id,
          binding.parentInvocation,
          binding.definitionIdentity,
          encoded,
          deadline,
        );
      return this.workflow(run, id)!;
    });
  }
  startWorkflow(run: string, id: string): void {
    this.transaction(() => {
      this.db
        .prepare(
          "UPDATE workflows SET status='running',error=NULL WHERE run=? AND id=?",
        )
        .run(run, id);
      this.event(run, id, null, null, "workflow.started", {});
    });
  }
  private workflowAncestors(run: string, owner: string | null): WorkflowRow[] {
    const rows: WorkflowRow[] = [];
    while (owner) {
      if (rows.length >= 32 || rows.some((row) => row.id === owner))
        throw new Error("Workflow ancestry exceeds its bound");
      const row = this.workflow(run, owner);
      if (!row) throw new Error("Unknown workflow owner");
      rows.push(row);
      owner = row.parent;
    }
    return rows;
  }
  checkWorkflow(run: string, owner: string | null): void {
    for (const row of this.workflowAncestors(run, owner)) {
      if (row.deadline <= Date.now())
        throw new WorkflowTimeoutError("Workflow deadline expired");
      if (row.status !== "running")
        throw new Error("Workflow scope is no longer active");
    }
  }
  workflowRaw(run: string, id: string, value: unknown): void {
    const raw = encode(value, 1024 * 1024);
    this.db
      .prepare(
        "UPDATE workflows SET raw=? WHERE run=? AND id=? AND raw IS NULL",
      )
      .run(raw, run, id);
  }
  finishWorkflow(run: string, id: string, value: Json): void {
    this.transaction(() => {
      this.checkWorkflow(run, id);
      this.db
        .prepare(
          "UPDATE workflows SET status='completed',result=?,error=NULL WHERE run=? AND id=?",
        )
        .run(encode(value, 1024 * 1024), run, id);
      this.event(run, id, null, null, "workflow.completed", {});
    });
  }
  failWorkflow(run: string, id: string, status: string, error: string): void {
    this.transaction(() => {
      this.db
        .prepare("UPDATE workflows SET status=?,error=? WHERE run=? AND id=?")
        .run(status, error, run, id);
      this.event(run, id, null, null, `workflow.${status}`, {
        error: clip(error, 4096),
      });
    });
  }
  workflowBlocked(run: string, id: string): boolean {
    return this.db
      .prepare(
        "SELECT a.id FROM actions a JOIN action_owners o ON o.run=a.run AND o.id=a.id WHERE a.run=? AND a.status='pending'",
      )
      .all(run)
      .some((row) => String(row.id).startsWith(id + "/"));
  }
  workflowInspect(run: string, offset = 0, limit = 100): WorkflowInspection {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > 1000000 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 200
    )
      throw new Error("Invalid workflow inspection window");
    const exists = this.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='workflows'",
      )
      .get();
    if (!exists)
      return {
        offset,
        limit,
        counts: { documents: 0, definitions: 0, workflows: 0, actions: 0 },
        documents: [],
        definitions: [],
        workflows: [],
        actions: [],
      };
    this.db.exec("BEGIN");
    try {
      const count = (table: string): number =>
        Number(
          this.db
            .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE run=?`)
            .get(run)?.n,
        );
      const result: WorkflowInspection = {
        offset,
        limit,
        counts: {
          documents: count("workflow_documents"),
          definitions: count("workflow_definitions"),
          workflows: count("workflows"),
          actions: count("action_owners"),
        },
        documents: this.db
          .prepare(
            "SELECT identity,value FROM workflow_documents WHERE run=? ORDER BY rowid LIMIT ? OFFSET ?",
          )
          .all(run, limit, offset)
          .map((row) => ({
            identity: String(row.identity),
            value: parse<Json>(row.value),
          })),
        definitions: this.db
          .prepare(
            "SELECT identity,value,document FROM workflow_definitions WHERE run=? ORDER BY rowid LIMIT ? OFFSET ?",
          )
          .all(run, limit, offset)
          .map((row) => ({
            identity: String(row.identity),
            value: parse<Json>(row.value),
            documentIdentity: row.document as string | null,
          })),
        workflows: (
          this.db
            .prepare(
              "SELECT * FROM workflows WHERE run=? ORDER BY rowid LIMIT ? OFFSET ?",
            )
            .all(run, limit, offset) as unknown as WorkflowRow[]
        ).map((row) => ({
          ...row,
          binding: parse<WorkflowBinding>(row.binding),
          raw: row.raw === null ? null : parse<Json>(row.raw),
          result: row.result === null ? null : parse<Json>(row.result),
          dispatchesUsed: Number(
            this.db
              .prepare(
                "SELECT COUNT(*) AS n FROM workflow_usage WHERE run=? AND workflow=?",
              )
              .get(run, row.id)?.n,
          ),
        })),
        actions: this.db
          .prepare(
            "SELECT id,kind,workflow,metadata FROM action_owners WHERE run=? ORDER BY rowid LIMIT ? OFFSET ?",
          )
          .all(run, limit, offset)
          .map((row) => ({
            id: String(row.id),
            kind: String(row.kind),
            workflow: row.workflow as string | null,
            metadata: row.metadata === null ? null : parse<Json>(row.metadata),
          })),
      };
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  claim(run: string, identity: string): string {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM runs WHERE id=?").get(run) as
        | Row
        | undefined;
      if (row && row.identity !== identity)
        throw new Error("Workflow identity changed");
      if (row?.pid) {
        let alive = true;
        try {
          process.kill(Number(row.pid), 0);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ESRCH") alive = false;
        }
        if (alive)
          throw new Error(
            "Run already executing (PID reuse is conservatively locked)",
          );
      }
      const owner = randomUUID();
      this.db
        .prepare(
          "INSERT INTO runs VALUES(?,?,?,NULL,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,error=NULL,pid=excluded.pid,owner=excluded.owner",
        )
        .run(run, identity, "running", process.pid, owner, Date.now());
      // Abandoned reservations are never retried, including command sends.
      this.db
        .prepare(
          "UPDATE invocations SET status='uncertain' WHERE run=? AND status='reserved'",
        )
        .run(run);
      this.event(run, null, null, null, "run.started", {});
      return owner;
    });
  }
  release(run: string, owner: string, error?: string): void {
    this.transaction(() => {
      const changed = this.db
        .prepare(
          "UPDATE runs SET pid=NULL,owner=NULL,status=?,error=? WHERE id=? AND owner=?",
        )
        .run(
          error !== undefined ? "failed" : "completed",
          error ?? null,
          run,
          owner,
        );
      if (changed.changes !== 1) throw new Error("Lost run ownership");
      this.event(
        run,
        null,
        null,
        null,
        error !== undefined ? "run.failed" : "run.completed",
        error !== undefined ? { error: clip(error, 4096) } : {},
      );
    });
  }
  action(
    run: string,
    id: string,
    identity: string,
    kind?: string,
    workflow: string | null = null,
    metadata?: Json,
  ): ActionRow {
    if (kind !== undefined) this.assertNamespace(run, id, workflow);
    this.db
      .prepare(
        "INSERT OR IGNORE INTO actions VALUES(?,?,?,'pending',NULL,NULL)",
      )
      .run(run, id, identity);
    const a = this.db
      .prepare("SELECT * FROM actions WHERE run=? AND id=?")
      .get(run, id) as unknown as ActionRow;
    if (a.identity !== identity)
      throw new Error(`Action request changed: ${id}`);
    if (kind !== undefined) {
      const owned = this.db
        .prepare("SELECT kind,workflow FROM action_owners WHERE run=? AND id=?")
        .get(run, id);
      if (owned && (owned.kind !== kind || owned.workflow !== workflow))
        throw new Error("Action kind or workflow owner changed");
      if (this.workflow(run, id))
        throw new Error("Action ID belongs to a workflow invocation");
      this.db
        .prepare("INSERT OR IGNORE INTO action_owners VALUES(?,?,?,?,?)")
        .run(
          run,
          id,
          kind,
          workflow,
          metadata === undefined ? null : encode(metadata),
        );
    }
    return a;
  }
  finishAction(run: string, id: string, result: unknown, error?: string): void {
    this.transaction(() => {
      this.db
        .prepare(
          "UPDATE actions SET status=?,result=?,error=? WHERE run=? AND id=?",
        )
        .run(
          error !== undefined ? "failed" : "completed",
          result === undefined ? null : encode(result, 1024 * 1024),
          error ?? null,
          run,
          id,
        );
      this.event(
        run,
        id,
        null,
        null,
        error !== undefined ? "action.failed" : "action.completed",
        error !== undefined ? { error: clip(error, 4096) } : {},
      );
    });
  }
  invocation(
    run: string,
    action: string,
    turn: number,
  ): InvocationRow | undefined {
    return this.db
      .prepare("SELECT * FROM invocations WHERE run=? AND action=? AND turn=?")
      .get(run, action, turn) as unknown as InvocationRow | undefined;
  }
  session(id: string, run: string, binding: string): NativeSession {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id=?").get(id) as
      | Row
      | undefined;
    if (!row || row.run !== run || row.binding !== binding)
      throw new Error("Session is not owned by this run/model/workdir/policy");
    if (row.busy) throw new Error("Session busy or uncertain");
    return parse<NativeSession>(row.native);
  }
  reserve(
    run: string,
    action: string,
    turn: number,
    session: string | undefined,
    budget?: Budget,
    paid = true,
    kind: "model" | "command" | "local" = "model",
    expectedSession?: NativeSession,
    workflow: string | null = null,
  ): string {
    return this.transaction(() => {
      this.assertNamespace(run, action, workflow);
      this.checkWorkflow(run, workflow);
      if (kind === "model")
        for (const row of this.workflowAncestors(run, workflow)) {
          const binding = parse<WorkflowBinding>(row.binding);
          const used = Number(
            this.db
              .prepare(
                "SELECT COUNT(*) AS n FROM workflow_usage WHERE run=? AND workflow=?",
              )
              .get(run, row.id)?.n,
          );
          if (binding.maxDispatches !== null && used >= binding.maxDispatches)
            throw new Error("Workflow dispatch limit exhausted");
        }
      if (paid) {
        const bad = this.db
          .prepare(
            `SELECT 1 FROM invocations i LEFT JOIN ledger l ON l.invocation=i.id WHERE i.run=? AND (i.status='uncertain' OR l.complete=0 OR EXISTS(SELECT 1 FROM reports p WHERE p.invocation=i.id AND json_extract(p.data,'$.status')='incomplete')) LIMIT 1`,
          )
          .get(run);
        if (bad)
          throw new Error(
            "Incomplete accounting/uncertain send blocks dispatch",
          );
      }
      if (budget && paid) {
        positive(budget.maxDispatches, 100000);
        if (!Number.isFinite(budget.softUsd) || budget.softUsd <= 0)
          throw new Error("Invalid budget");
        this.db
          .prepare("INSERT OR IGNORE INTO budgets VALUES(?,?,?)")
          .run(budget.id, budget.maxDispatches, budget.softUsd);
        const b = this.db
          .prepare("SELECT * FROM budgets WHERE id=?")
          .get(budget.id) as Row;
        if (b.max !== budget.maxDispatches || b.soft !== budget.softUsd)
          throw new Error("Budget configuration changed");
        const counts = this.db
          .prepare(
            "SELECT COUNT(*) AS n,COALESCE(SUM(l.usd),0) AS usd FROM invocations i LEFT JOIN ledger l ON l.invocation=i.id WHERE budget=?",
          )
          .get(budget.id) as Row;
        const incomplete = this.db
          .prepare(
            `SELECT 1 FROM invocations i LEFT JOIN ledger l ON l.invocation=i.id LEFT JOIN runs r ON r.id=i.run WHERE budget=? AND (l.complete=0 OR EXISTS(SELECT 1 FROM reports p WHERE p.invocation=i.id AND json_extract(p.data,'$.status')='incomplete') OR i.status='uncertain' OR (i.status='reserved' AND (r.pid IS NULL OR r.pid!=?))) LIMIT 1`,
          )
          .get(budget.id, process.pid);
        if (
          Number(counts.n) >= budget.maxDispatches ||
          Number(counts.usd) >= budget.softUsd ||
          incomplete
        )
          throw new Error(
            "Dispatch budget exhausted or has unresolved accounting",
          );
      }
      const id = randomUUID();
      if (session) {
        const changed = this.db
          .prepare(
            "UPDATE sessions SET busy=? WHERE id=? AND run=? AND busy IS NULL AND native=?",
          )
          .run(id, session, run, encode(expectedSession));
        if (changed.changes !== 1)
          throw new Error("Session busy, advanced, or unowned");
      }
      this.db
        .prepare(
          "INSERT INTO invocations VALUES(?,?,?,?,'reserved',NULL,?,?,?,?,?)",
        )
        .run(
          id,
          run,
          action,
          turn,
          session ?? null,
          kind,
          paid ? 1 : 0,
          paid ? (budget?.id ?? null) : null,
          Date.now(),
        );
      if (kind === "model")
        for (const row of this.workflowAncestors(run, workflow))
          this.db
            .prepare("INSERT INTO workflow_usage VALUES(?,?,?)")
            .run(run, row.id, id);
      this.event(run, action, id, turn, "invocation.reserved", { paid, kind });
      return id;
    });
  }
  report(invocation: string, key: string, data: Accounting): void {
    validateAccounting(data);
    const encoded = encode(data, 16 * 1024);
    const normalizedKey = reportKey(key);
    this.transaction(() => {
      const old = this.db
        .prepare("SELECT data FROM reports WHERE invocation=? AND key=?")
        .get(invocation, normalizedKey);
      if (old) {
        if (old.data !== encoded)
          throw new Error("Conflicting duplicate accounting report");
        return;
      }
      const n = this.db
        .prepare("SELECT COUNT(*) AS n FROM reports WHERE invocation=?")
        .get(invocation);
      if (Number(n?.n) >= 1000)
        throw new Error("Accounting report limit exceeded");
      this.db
        .prepare("INSERT INTO reports VALUES(?,?,?)")
        .run(invocation, normalizedKey, encoded);
      const row = this.db
        .prepare("SELECT run,action,turn FROM invocations WHERE id=?")
        .get(invocation) as Row;
      this.event(
        String(row.run),
        String(row.action),
        invocation,
        Number(row.turn),
        "usage",
        parse<Json>(encoded),
        normalizedKey,
      );
    });
  }
  lastReport(invocation: string): Accounting | undefined {
    // Reports are cumulative, never additive. Preserve both the strongest known
    // subtotal and any incomplete evidence, even when it was an earlier report.
    return strongestAccounting(
      this.db
        .prepare("SELECT data FROM reports WHERE invocation=? ORDER BY rowid")
        .all(invocation)
        .map((row) => parse<Accounting>(row.data)),
    );
  }
  reconcileAccounting(invocation: string, terminal: Accounting): Accounting {
    validateAccounting(terminal);
    const observed = this.lastReport(invocation);
    const strongest = strongestAccounting(
      [observed, terminal].filter(
        (value): value is Accounting => value !== undefined,
      ),
    )!;
    const observedUsd = observed ? knownUsd(observed) : null;
    const terminalUsd = knownUsd(terminal);
    return observedUsd !== null &&
      (terminalUsd === null || terminalUsd < observedUsd)
      ? {
          ...strongest,
          status: "incomplete",
          reason: "Terminal cost lost/regressed from a durable usable report",
        }
      : strongest;
  }

  receipt(
    run: string,
    action: string,
    invocation: string,
    turn: number,
    receipt: Receipt,
    binding: string,
    priorSession?: string,
  ): string | undefined {
    validateAccounting(receipt.accounting);
    return this.transaction(() => {
      const retained = {
        ...receipt,
        accounting: this.reconcileAccounting(invocation, receipt.accounting),
      };
      const session = retained.session
        ? (priorSession ?? randomUUID())
        : priorSession;
      if (retained.session && session)
        this.db
          .prepare(
            "INSERT INTO sessions VALUES(?,?,?,?,NULL) ON CONFLICT(id) DO UPDATE SET native=excluded.native,busy=NULL",
          )
          .run(session, run, binding, encode(retained.session));
      // A missing new baseline deliberately leaves continuation locked.
      this.db
        .prepare(
          "UPDATE invocations SET status='received',receipt=?,session=? WHERE id=? AND status='reserved'",
        )
        .run(encode(retained, 1024 * 1024), session ?? null, invocation);
      this.db
        .prepare("INSERT INTO ledger VALUES(?,?,?,?)")
        .run(
          invocation,
          encode(retained.accounting, 16 * 1024),
          knownUsd(retained.accounting),
          retained.accounting.status === "complete" ? 1 : 0,
        );
      this.event(run, action, invocation, turn, "invocation.received", {
        status: retained.status,
        accounting: parse<Json>(encode(retained.accounting)),
      });
      return session;
    });
  }
  uncertain(
    run: string,
    action: string,
    id: string,
    turn: number,
    accounting: Accounting,
    error: string,
  ): void {
    this.transaction(() => {
      this.db
        .prepare("UPDATE invocations SET status='uncertain' WHERE id=?")
        .run(id);
      this.db
        .prepare("INSERT OR IGNORE INTO ledger VALUES(?,?,?,0)")
        .run(id, encode(accounting), knownUsd(accounting));
      this.event(run, action, id, turn, "invocation.uncertain", {
        error: clip(error, 4096),
      });
    });
  }
  event(
    run: string,
    action: string | null,
    invocation: string | null,
    turn: number | null,
    type: string,
    data: Json,
    source?: string,
  ): void {
    let payload = encode(boundedJson(data), 8192);
    if (Buffer.byteLength(payload) > 8192)
      payload = encode({ truncated: true, preview: clip(payload, 4000) });
    this.db
      .prepare(
        "INSERT INTO events(run,action,invocation,turn,source,time,type,data) VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(
        run,
        action,
        invocation,
        turn,
        source ? clip(source, 256) : null,
        Date.now(),
        clip(type, 100),
        payload,
      );
  }
  events(run: string, after = 0, limit = 100): EventRow[] {
    if (!Number.isSafeInteger(after) || after < 0)
      throw new Error("Invalid cursor");
    positive(limit, 200);
    return (
      this.db
        .prepare(
          "SELECT * FROM events WHERE run=? AND cursor>? ORDER BY cursor LIMIT ?",
        )
        .all(run, after, limit) as Row[]
    ).map((r) => ({
      v: 1,
      attempt: 1,
      cursor: Number(r.cursor),
      runId: String(r.run),
      actionId: r.action as string | null,
      invocationId: r.invocation as string | null,
      turn: r.turn as number | null,
      sourceId: r.source as string | null,
      observedAt: Number(r.time),
      type: String(r.type),
      data: parse<Json>(r.data),
    }));
  }
  /** Bounded run summaries only; no content or native state. */
  runs(offset = 0, limit = 100): RunSummary[] {
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new Error("Invalid offset");
    positive(limit, 200);
    return this.db
      .prepare(
        "SELECT id,status,error,created FROM runs ORDER BY created DESC,id DESC LIMIT ? OFFSET ?",
      )
      .all(limit, offset) as unknown as RunSummary[];
  }
  inspect(run: string, offset = 0, limit = 100): Inspection {
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new Error("Invalid offset");
    positive(limit, 200);
    // Deferred read transaction: one WAL snapshot, including on readonly handles.
    this.db.exec("BEGIN");
    try {
      const result: Inspection = {
        run: this.db
          .prepare("SELECT * FROM runs WHERE id=?")
          .get(run) as unknown as Inspection["run"],
        actions: this.db
          .prepare(
            "SELECT * FROM actions WHERE run=? ORDER BY rowid LIMIT ? OFFSET ?",
          )
          .all(run, limit, offset) as unknown as Inspection["actions"],
        invocations: this.db
          .prepare(
            "SELECT i.*,l.data AS accounting FROM invocations i LEFT JOIN ledger l ON l.invocation=i.id WHERE run=? ORDER BY i.created,i.rowid LIMIT ? OFFSET ?",
          )
          .all(run, limit, offset) as unknown as Inspection["invocations"],
        reports: this.db
          .prepare(
            "SELECT p.invocation,p.key,p.data FROM reports p JOIN invocations i ON i.id=p.invocation WHERE i.run=? ORDER BY i.created,p.rowid LIMIT ? OFFSET ?",
          )
          .all(run, limit, offset) as unknown as Inspection["reports"],
        budgets: this.db
          .prepare(
            `SELECT b.id,b.max,b.soft,COUNT(*) AS reserved,SUM(l.usd) AS knownUsd,SUM(CASE WHEN l.complete=1 AND i.status!='uncertain' AND NOT EXISTS(SELECT 1 FROM reports p WHERE p.invocation=i.id AND json_extract(p.data,'$.status')='incomplete') THEN 0 ELSE 1 END) AS unresolved FROM budgets b JOIN invocations i ON i.budget=b.id LEFT JOIN ledger l ON l.invocation=i.id WHERE b.id IN (SELECT budget FROM invocations WHERE run=?) GROUP BY b.id LIMIT 200`,
          )
          .all(run) as unknown as Inspection["budgets"],
        totals: this.db
          .prepare(
            `SELECT COUNT(*) AS invocations, SUM(CASE WHEN i.kind='model' THEN 1 ELSE 0 END) AS modelDispatches, SUM(l.usd) AS knownUsd, SUM(CASE WHEN l.complete=1 AND i.status!='uncertain' AND NOT EXISTS(SELECT 1 FROM reports p WHERE p.invocation=i.id AND json_extract(p.data,'$.status')='incomplete') THEN 0 ELSE 1 END) AS unresolved FROM invocations i LEFT JOIN ledger l ON l.invocation=i.id WHERE run=?`,
          )
          .get(run) as unknown as Inspection["totals"],
        costsByKind: this.db
          .prepare(
            `SELECT kind,SUM(usd) AS knownUsd FROM (SELECT json_extract(l.data,'$.kind') AS kind,json_extract(l.data,'$.usd') AS usd FROM ledger l JOIN invocations i ON i.id=l.invocation WHERE i.run=? UNION ALL SELECT json_extract(j.value,'$.kind'),json_extract(j.value,'$.usd') FROM ledger l JOIN invocations i ON i.id=l.invocation,json_each(l.data,'$.additional') j WHERE i.run=?) GROUP BY kind`,
          )
          .all(run, run) as unknown as Inspection["costsByKind"],
        offset,
        limit,
      };
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
}

function reportKey(key: string): string {
  const limit = 256;
  if (Buffer.byteLength(key) <= limit) return key;
  const suffix = `#sha256:${hash(key)}`;
  return `${clip(key, limit - Buffer.byteLength(suffix))}${suffix}`;
}
