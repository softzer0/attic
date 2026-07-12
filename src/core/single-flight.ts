export class SingleFlight {
  readonly #inFlight = new Map<string, Promise<unknown>>();

  public get size(): number {
    return this.#inFlight.size;
  }

  public run<T>(key: string, work: () => T | PromiseLike<T>): Promise<T> {
    const existing = this.#inFlight.get(key);
    if (existing !== undefined) return existing as Promise<T>;

    const promise = Promise.resolve().then(work);
    this.#inFlight.set(key, promise);

    const clear = (): void => {
      if (this.#inFlight.get(key) === promise) this.#inFlight.delete(key);
    };
    void promise.then(clear, clear);

    return promise;
  }

  public clear(): void {
    this.#inFlight.clear();
  }
}
