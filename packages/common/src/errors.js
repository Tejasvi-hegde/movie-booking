/**
 * Typed application errors. Every error that reaches the HTTP layer is mapped to a
 * consistent JSON body: { error: { code, message, details? } }.
 */
export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.name = new.target.name;
  }
}

export class BadRequestError extends AppError {
  constructor(message = 'Bad request', details) {
    super(400, 'BAD_REQUEST', message, details);
  }
}

export class ValidationError extends AppError {
  constructor(details) {
    super(400, 'VALIDATION_FAILED', 'Request validation failed', details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required') {
    super(401, 'UNAUTHORIZED', message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have access to this resource') {
    super(403, 'FORBIDDEN', message);
  }
}

export class NotFoundError extends AppError {
  constructor(resource = 'Resource') {
    super(404, 'NOT_FOUND', `${resource} not found`);
  }
}

export class ConflictError extends AppError {
  constructor(code, message, details) {
    super(409, code, message, details);
  }
}

export class UnprocessableError extends AppError {
  constructor(code, message, details) {
    super(422, code, message, details);
  }
}

export class TooManyRequestsError extends AppError {
  constructor(retryAfterSeconds) {
    super(429, 'RATE_LIMITED', 'Too many requests, slow down', { retryAfterSeconds });
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message = 'A dependency is unavailable, try again shortly') {
    super(503, 'SERVICE_UNAVAILABLE', message);
  }
}
