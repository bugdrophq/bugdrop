/** Only an opaque unresolved marker is persisted, never feedback, identity or capabilities. */
export interface RecoveryGuard {
  isBlocked(): boolean;
  acquire(): Promise<boolean>;
  release(): Promise<void>;
}

export function createRecoveryGuard(applicationId: string, endpoint: string): RecoveryGuard {
  const key = `bugdrop:unresolved:v1:${JSON.stringify([applicationId, endpoint])}`;
  let owner: string | undefined;
  let failed = false;
  function read(): string | null {
    if (!navigator.locks) throw new Error('Recovery locking unavailable');
    return localStorage.getItem(key);
  }
  return {
    isBlocked() {
      try {
        const value = read();
        return failed || (value !== null && value !== owner);
      } catch {
        failed = true;
        return true;
      }
    },
    async acquire() {
      try {
        if (failed || !navigator.locks) return false;
        return await navigator.locks.request(key, () => {
          const value = read();
          if (owner) return value === owner;
          if (value !== null) return false;
          const marker = `unresolved:${crypto.randomUUID()}`;
          localStorage.setItem(key, marker);
          if (read() !== marker) throw new Error('Recovery marker unavailable');
          owner = marker;
          return true;
        });
      } catch {
        failed = true;
        return false;
      }
    },
    async release() {
      try {
        if (!navigator.locks || !owner) throw new Error('Recovery ownership unavailable');
        await navigator.locks.request(key, () => {
          if (read() !== owner) throw new Error('Recovery ownership changed');
          localStorage.removeItem(key);
          if (read() !== null) throw new Error('Recovery marker retained');
          owner = undefined;
        });
      } catch {
        failed = true;
      }
    },
  };
}
