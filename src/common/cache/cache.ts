export interface Cache {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
}

interface Entry {
  value: string;
  expiresAt: number;
}

export class MemoryCache implements Cache {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  async get(key: string): Promise<string | undefined> {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.entries.set(key, { value, expiresAt: this.now() + ttlSeconds * 1000 });
  }

  async del(key: string): Promise<void> {
    this.entries.delete(key);
  }
}

export class RedisCache implements Cache {
  constructor(private readonly client: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string, mode: 'EX', ttl: number): Promise<unknown>;
    del(key: string): Promise<unknown>;
  }) {}

  async get(key: string): Promise<string | undefined> {
    const value = await this.client.get(key);
    return value ?? undefined;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.client.set(key, value, 'EX', ttlSeconds);
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }
}
