export class SerialQueue {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const preceding = this.tail;
    let complete!: () => void;
    const queued = new Promise<void>((resolve) => { complete = resolve; });
    this.tail = preceding.catch(() => undefined).then(() => queued);
    await preceding.catch(() => undefined);
    try {
      return await operation();
    } finally {
      complete();
    }
  }

  idle(): Promise<void> {
    return this.tail;
  }
}

export class KeyedSerialQueue {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const preceding = this.tails.get(key) ?? Promise.resolve();
    let complete!: () => void;
    const queued = new Promise<void>((resolve) => { complete = resolve; });
    const tail = preceding.catch(() => undefined).then(() => queued);
    this.tails.set(key, tail);
    await preceding.catch(() => undefined);
    try {
      return await operation();
    } finally {
      complete();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }

  async idle(): Promise<void> {
    await Promise.all([...this.tails.values()].map((tail) => tail.catch(() => undefined)));
  }
}
