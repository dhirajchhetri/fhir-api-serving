import fs from 'fs';
import { createRequire } from 'module';
import { CircuitBreaker } from '../../common/resilience/circuit-breaker';
import { OutcomeRow, TaskRow } from './projection';

const nodeRequire = createRequire(__filename);

type SqlDatabase = {
  run(sql: string): void;
  prepare(sql: string): {
    bind(params: Array<string | number>): void;
    step(): boolean;
    getAsObject(): Record<string, string | number | null>;
    free(): void;
    run(params: Array<string | number>): void;
  };
};

export class SqliteAnalyticsEngine {
  readonly name = 'sqlite' as const;
  private db: SqlDatabase | undefined;

  constructor(private readonly breaker = new CircuitBreaker(3, 30_000)) {}

  async init(): Promise<void> {
    const initSqlJs = nodeRequire('sql.js') as (opts?: { wasmBinary?: Buffer }) => Promise<{ Database: new () => SqlDatabase }>;
    const wasmPath = nodeRequire.resolve('sql.js/dist/sql-wasm.wasm');
    const SQL = await initSqlJs({ wasmBinary: fs.readFileSync(wasmPath) });
    this.db = new SQL.Database();
    this.db.run(`CREATE TABLE curated_wound_outcomes (
      tenant_id TEXT, facility_id TEXT, clinician_id TEXT, patient_id TEXT, wound_id TEXT,
      wound_type TEXT, status TEXT, as_of_date TEXT, healed_30d INTEGER,
      area_change_ratio REAL, baseline_area_cm2 REAL, latest_area_cm2 REAL, depth_cm REAL
    )`);
    this.db.run(`CREATE TABLE curated_care_tasks (
      tenant_id TEXT, facility_id TEXT, clinician_id TEXT, patient_id TEXT, task_id TEXT,
      task_type TEXT, status TEXT, due_date TEXT, as_of_date TEXT
    )`);
  }

  async replace(outcomes: OutcomeRow[], tasks: TaskRow[]): Promise<void> {
    const db = this.database();
    db.run('DELETE FROM curated_wound_outcomes');
    db.run('DELETE FROM curated_care_tasks');
    const outcomeStmt = db.prepare(
      `INSERT INTO curated_wound_outcomes VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const row of outcomes) {
      outcomeStmt.run([
        row.tenant_id, row.facility_id, row.clinician_id, row.patient_id, row.wound_id,
        row.wound_type, row.status, row.as_of_date, row.healed_30d, row.area_change_ratio,
        row.baseline_area_cm2, row.latest_area_cm2, row.depth_cm,
      ]);
    }
    outcomeStmt.free();
    const taskStmt = db.prepare(`INSERT INTO curated_care_tasks VALUES (?,?,?,?,?,?,?,?,?)`);
    for (const row of tasks) {
      taskStmt.run([
        row.tenant_id, row.facility_id, row.clinician_id, row.patient_id, row.task_id,
        row.task_type, row.status, row.due_date, row.as_of_date,
      ]);
    }
    taskStmt.free();
  }

  query(sql: string, params: Array<string | number>): Promise<Record<string, unknown>[]> {
    return this.breaker.exec(async () => {
      const stmt = this.database().prepare(sql);
      stmt.bind(params);
      const rows: Record<string, unknown>[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
      return rows;
    });
  }

  private database(): SqlDatabase {
    if (!this.db) throw new Error('sqlite analytics engine is not initialised');
    return this.db;
  }
}
