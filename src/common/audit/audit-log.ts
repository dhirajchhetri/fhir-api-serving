import { randomUUID } from 'crypto';

export interface AuditRecord {
  id: string;
  at: string;
  actorSub: string;
  actorRole: string;
  tenantId: string;
  action: string;
  resourceType: string;
  resourceIds: string[];
  purpose: string;
  outcome: 'allow' | 'deny';
  queryKeys: string[];
}

export interface AuditSink {
  write(record: AuditRecord): Promise<void>;
  readAll(tenantId: string): Promise<AuditRecord[]>;
}

export class MemoryAuditSink implements AuditSink {
  readonly records: AuditRecord[] = [];

  async write(record: AuditRecord): Promise<void> {
    this.records.push(record);
  }

  async readAll(tenantId: string): Promise<AuditRecord[]> {
    return this.records.filter((record) => record.tenantId === tenantId);
  }
}

export interface ObjectStore {
  putJson(bucket: string, key: string, body: unknown): Promise<void>;
  listJson(bucket: string, prefix: string): Promise<unknown[]>;
}

export class ObjectAuditSink implements AuditSink {
  constructor(
    private readonly store: ObjectStore,
    private readonly bucket: string,
  ) {}

  async write(record: AuditRecord): Promise<void> {
    const day = record.at.slice(0, 10);
    const key = `audit/${record.tenantId}/${day}/${record.id}.json`;
    await this.store.putJson(this.bucket, key, record);
  }

  async readAll(tenantId: string): Promise<AuditRecord[]> {
    const rows = await this.store.listJson(this.bucket, `audit/${tenantId}/`);
    return rows.filter(isAuditRecord).sort((a, b) => a.at.localeCompare(b.at));
  }
}

function isAuditRecord(value: unknown): value is AuditRecord {
  return Boolean(value && typeof value === 'object' && 'id' in value && 'tenantId' in value);
}

export class AuditLog {
  constructor(
    private readonly sink: AuditSink,
    private readonly ids: () => string = randomUUID,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async record(input: Omit<AuditRecord, 'id' | 'at'>): Promise<AuditRecord> {
    const record: AuditRecord = { id: this.ids(), at: this.now(), ...input };
    await this.sink.write(record);
    return record;
  }

  list(tenantId: string): Promise<AuditRecord[]> {
    return this.sink.readAll(tenantId);
  }
}
