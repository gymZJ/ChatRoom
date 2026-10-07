export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly readers: Array<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (error: unknown) => void;
  }> = [];
  private ended = false;
  private failure: unknown = null;

  push(value: T): void {
    if (this.ended) throw new Error("Queue is closed");
    const reader = this.readers.shift();
    if (reader) reader.resolve({ value, done: false });
    else this.values.push(value);
  }

  close(): void {
    if (this.ended) return;
    this.ended = true;
    for (const reader of this.readers.splice(0))
      reader.resolve({ value: undefined, done: true });
  }

  fail(error: unknown): void {
    if (this.ended) return;
    this.failure = error;
    this.ended = true;
    for (const reader of this.readers.splice(0)) reader.reject(error);
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined)
          return Promise.resolve({ value, done: false } as IteratorResult<T>);
        if (this.failure) return Promise.reject(this.failure);
        if (this.ended)
          return Promise.resolve({
            value: undefined,
            done: true,
          } as IteratorResult<T>);
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.readers.push({ resolve, reject });
        });
      },
    };
  }
}
