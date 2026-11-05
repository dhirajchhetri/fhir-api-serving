import {
  AthenaClient,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
  StartQueryExecutionCommand,
} from '@aws-sdk/client-athena';
import { CircuitBreaker } from '../../common/resilience/circuit-breaker';
import { DomainError } from '../../domain/errors';

export interface AthenaDriver {
  start(sql: string): Promise<string>;
  state(executionId: string): Promise<string>;
  results(executionId: string): Promise<{ columns: string[]; rows: string[][] }>;
}

export class AthenaAnalyticsEngine {
  readonly name = 'athena' as const;

  constructor(
    private readonly driver: AthenaDriver,
    private readonly breaker = new CircuitBreaker(3, 30_000),
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  query(sql: string, _params: Array<string | number>): Promise<Record<string, unknown>[]> {
    const rendered = bind(sql, _params);
    return this.breaker.exec(async () => {
      const executionId = await this.driver.start(rendered);
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const state = await this.driver.state(executionId);
        if (state === 'SUCCEEDED') break;
        if (state === 'FAILED' || state === 'CANCELLED') {
          throw new DomainError(`athena query ${state.toLowerCase()}`, 'unavailable', 503);
        }
        await this.sleep(20);
      }
      const result = await this.driver.results(executionId);
      return result.rows.map((row) => {
        const record: Record<string, unknown> = {};
        result.columns.forEach((column, index) => {
          record[column] = coerce(row[index]);
        });
        return record;
      });
    });
  }
}

export function athenaDriverFromClient(input: {
  client: AthenaClient;
  database: string;
  workgroup: string;
  outputLocation: string;
}): AthenaDriver {
  return {
    async start(sql) {
      const started = await input.client.send(new StartQueryExecutionCommand({
        QueryString: sql,
        QueryExecutionContext: { Database: input.database },
        WorkGroup: input.workgroup,
        ResultConfiguration: { OutputLocation: input.outputLocation },
      }));
      if (!started.QueryExecutionId) throw new Error('athena did not return an execution id');
      return started.QueryExecutionId;
    },
    async state(executionId) {
      const execution = await input.client.send(new GetQueryExecutionCommand({ QueryExecutionId: executionId }));
      return execution.QueryExecution?.Status?.State ?? 'UNKNOWN';
    },
    async results(executionId) {
      const page = await input.client.send(new GetQueryResultsCommand({ QueryExecutionId: executionId }));
      const rows = page.ResultSet?.Rows ?? [];
      const columns = (rows[0]?.Data ?? []).map((cell) => cell.VarCharValue ?? '');
      const data = rows.slice(1).map((row) => (row.Data ?? []).map((cell) => cell.VarCharValue ?? ''));
      return { columns, rows: data };
    },
  };
}

/** Athena prepared statements differ from SQLite placeholders, so literals are escaped here. */
export function bind(sql: string, params: Array<string | number>): string {
  let index = 0;
  return sql.replace(/\?/g, () => {
    const value = params[index];
    index += 1;
    if (typeof value === 'number') return String(value);
    return `'${String(value).replace(/'/g, "''")}'`;
  });
}

function coerce(value: string): string | number {
  if (value !== '' && /^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}
