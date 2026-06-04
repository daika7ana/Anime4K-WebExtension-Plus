/**
 * Base renderer error class. All renderer-specific errors should inherit from this class.
 */
export class RendererError extends Error {
  public cause?: Error;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RendererError';
    if (options?.cause instanceof Error) {
      this.cause = options.cause;
    }
  }
}

/**
 * Represents an error that occurs during the renderer initialization phase.
 * Examples: GPU device acquisition failure, unsupported WebGPU features, etc.
 */
export class RendererInitializationError extends RendererError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RendererInitializationError';
  }
}

/**
 * Represents an error that occurs during the render loop (runtime).
 */
export class RendererRuntimeError extends RendererError {
  public recoverable: boolean;

  constructor(message: string, options?: ErrorOptions & { recoverable?: boolean }) {
    super(message, options);
    this.name = 'RendererRuntimeError';
    this.recoverable = options?.recoverable ?? false;
  }
}
