export interface ReplayStore {
  consume(namespace: string, id: string, ttlSeconds: number): Promise<boolean>;
  increment(namespace: string, id: string, ttlSeconds: number): Promise<number>;
  ready(): Promise<boolean>;
  close(): void;
}

export class MemoryReplayStore implements ReplayStore {
  private readonly values = new Map<string, { value: number; expiresAt: number }>();

  public consume(namespace: string, id: string, ttlSeconds: number): Promise<boolean> {
    const key = `${namespace}:${id}`;
    this.cleanup(key);
    if (this.values.has(key)) return Promise.resolve(false);
    this.values.set(key, { value: 1, expiresAt: Date.now() + ttlSeconds * 1_000 });
    return Promise.resolve(true);
  }

  public increment(namespace: string, id: string, ttlSeconds: number): Promise<number> {
    const key = `${namespace}:${id}`;
    this.cleanup(key);
    const current = this.values.get(key);
    const value = (current?.value ?? 0) + 1;
    this.values.set(key, { value, expiresAt: current?.expiresAt ?? Date.now() + ttlSeconds * 1_000 });
    return Promise.resolve(value);
  }

  public ready(): Promise<boolean> { return Promise.resolve(true); }

  public close(): void { this.values.clear(); }

  private cleanup(key: string): void {
    const current = this.values.get(key);
    if (current && current.expiresAt <= Date.now()) this.values.delete(key);
  }
}
