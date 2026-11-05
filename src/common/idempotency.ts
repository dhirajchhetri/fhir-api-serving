export interface IdempotencyStore {
  get(key: string): Promise<string | undefined>;
  /** Returns false when the key was already stored. */
  putIfAbsent(key: string, response: string): Promise<boolean>;
}

export class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly values = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }

  async putIfAbsent(key: string, response: string): Promise<boolean> {
    if (this.values.has(key)) return false;
    this.values.set(key, response);
    return true;
  }
}

export interface ConditionalPut {
  putIfAbsent(key: string, response: string): Promise<boolean>;
  get(key: string): Promise<string | undefined>;
}

export class TableIdempotencyStore implements IdempotencyStore {
  constructor(private readonly table: ConditionalPut) {}

  get(key: string): Promise<string | undefined> {
    return this.table.get(key);
  }

  putIfAbsent(key: string, response: string): Promise<boolean> {
    return this.table.putIfAbsent(key, response);
  }
}
