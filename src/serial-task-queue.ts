export type AcceptedTask<T> = {
  accepted: true;
  position: number;
  completion: Promise<T>;
};

export type DuplicateTask = {
  accepted: false;
  position: 0;
  completion: null;
};

export class SerialTaskQueue {
  readonly #seenMessageIds = new Set<string>();
  #tail: Promise<void> = Promise.resolve();
  #pendingCount = 0;

  enqueue<T>(messageId: string, work: () => Promise<T>): AcceptedTask<T> | DuplicateTask {
    if (this.#seenMessageIds.has(messageId)) {
      return { accepted: false, position: 0, completion: null };
    }

    this.#seenMessageIds.add(messageId);
    const position = this.#pendingCount + 1;
    this.#pendingCount += 1;
    const completion = this.#tail.then(work);
    this.#tail = completion.then(
      () => {
        this.#pendingCount -= 1;
      },
      () => {
        this.#pendingCount -= 1;
      },
    );

    return { accepted: true, position, completion };
  }
}
