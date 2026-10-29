export interface Clock {
  now(): Date; // única fonte de tempo do sistema
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(signal?.reason);
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}
