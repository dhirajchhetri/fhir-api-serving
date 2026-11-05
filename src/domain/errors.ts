export class DomainError extends Error {
  constructor(
    message: string,
    readonly code: string = 'domain',
    readonly status: number = 400,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export class AuthzError extends DomainError {
  constructor(message = 'forbidden') {
    super(message, 'forbidden', 403);
    this.name = 'AuthzError';
  }
}

export class QueryRejected extends DomainError {
  constructor(message: string) {
    super(message, 'query_rejected', 400);
    this.name = 'QueryRejected';
  }
}
