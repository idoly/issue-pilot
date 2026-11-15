/**
 * Yields one macrotask so every pending promise reaction has run.
 * Use it only to prove that a late response changes nothing; wait for expected UI with waitFor or findBy*.
 */
export function settle(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}
