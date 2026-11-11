export class HttpError extends Error {
  constructor(system, status, body, { retryable } = {}) {
    super(`${system} ${status}: ${String(body).slice(0, 600)}`);
    this.system = system;
    this.status = status;
    // 429 and 5xx are worth retrying; 4xx validation/auth errors are not.
    this.retryable = retryable ?? (status === 429 || status >= 500);
  }
}

/** Something a retry cannot fix (bad data, missing config). Goes to "needs_review". */
export class PermanentError extends Error {
  retryable = false;
}
