export class AppError extends Error {
  constructor(
    message: string,
    readonly code: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'AppError';
  }
}

export function sanitizeErrorMessage(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value);
  return message
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
    .replace(/sk-or-[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g, '[image data redacted]')
    .slice(0, 1_000);
}

export function errorForUser(error: unknown): string {
  if (error instanceof AppError) return `${error.code}: ${sanitizeErrorMessage(error)}`;
  return `INTERNAL_ERROR: ${sanitizeErrorMessage(error)}`;
}
