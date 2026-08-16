export type RefreshRotationResult = "rotated" | "reused" | "revoked";

export interface ReplayStore {
  consume(namespace: string, id: string, ttlSeconds: number): Promise<boolean>;
  increment(namespace: string, id: string, ttlSeconds: number): Promise<number>;
  initializeRefreshFamily(familyId: string, currentTokenId: string, ttlSeconds: number): Promise<boolean>;
  rotateRefreshFamily(
    familyId: string,
    presentedTokenId: string,
    nextTokenId: string,
    ttlSeconds: number,
  ): Promise<RefreshRotationResult>;
  ready(): Promise<boolean>;
  close(): void;
}

export class MemoryReplayStore implements ReplayStore {
  private readonly values = new Map<string, { value: number; expiresAt: number }>();
  private readonly refreshFamilies = new Map<string, { tokenId: string; revoked: boolean; expiresAt: number }>();

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

  public initializeRefreshFamily(familyId: string, currentTokenId: string, ttlSeconds: number): Promise<boolean> {
    this.cleanupRefreshFamily(familyId);
    if (this.refreshFamilies.has(familyId)) return Promise.resolve(false);
    this.refreshFamilies.set(familyId, {
      tokenId: currentTokenId,
      revoked: false,
      expiresAt: Date.now() + ttlSeconds * 1_000,
    });
    return Promise.resolve(true);
  }

  public rotateRefreshFamily(
    familyId: string,
    presentedTokenId: string,
    nextTokenId: string,
    ttlSeconds: number,
  ): Promise<RefreshRotationResult> {
    this.cleanupRefreshFamily(familyId);
    const family = this.refreshFamilies.get(familyId);
    if (!family || family.revoked) return Promise.resolve("revoked");
    if (family.tokenId !== presentedTokenId) {
      this.refreshFamilies.set(familyId, {
        tokenId: family.tokenId,
        revoked: true,
        expiresAt: Date.now() + ttlSeconds * 1_000,
      });
      return Promise.resolve("reused");
    }
    this.refreshFamilies.set(familyId, {
      tokenId: nextTokenId,
      revoked: false,
      expiresAt: Date.now() + ttlSeconds * 1_000,
    });
    return Promise.resolve("rotated");
  }

  public ready(): Promise<boolean> { return Promise.resolve(true); }

  public close(): void {
    this.values.clear();
    this.refreshFamilies.clear();
  }

  private cleanup(key: string): void {
    const current = this.values.get(key);
    if (current && current.expiresAt <= Date.now()) this.values.delete(key);
  }

  private cleanupRefreshFamily(familyId: string): void {
    const current = this.refreshFamilies.get(familyId);
    if (current && current.expiresAt <= Date.now()) this.refreshFamilies.delete(familyId);
  }
}
