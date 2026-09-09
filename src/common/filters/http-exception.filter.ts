import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Response } from 'express';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<{ method: string; url: string }>();

    const fileTooLarge = isMulterFileSizeError(exception);

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : fileTooLarge
          ? HttpStatus.PAYLOAD_TOO_LARGE
          : HttpStatus.INTERNAL_SERVER_ERROR;

    if (status >= 500) {
      this.logger.error(
        `[${request.method}] ${request.url} -> ${status}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    }

    const body =
      exception instanceof HttpException
        ? this.formatHttpException(exception)
        : {
            error: fileTooLarge ? 'PayloadTooLarge' : 'InternalServerError',
            message: fileTooLarge
              ? 'Le fichier dépasse la taille maximale autorisée.'
              : 'Une erreur interne est survenue.',
            statusCode: status,
          };

    response.status(status).json({
      statusCode: body.statusCode,
      error: body.error,
      message: body.message,
      path: request.url,
      timestamp: new Date().toISOString(),
    });
  }

  private formatHttpException(exception: HttpException): {
    statusCode: number;
    error: string;
    message: string | string[];
  } {
    const statusCode = exception.getStatus();
    const response = exception.getResponse();

    if (typeof response === 'string') {
      return { statusCode, error: this.httpErrorLabel(statusCode), message: response };
    }

    const { message, error } = response as { message?: string | string[]; error?: string };

    return {
      statusCode,
      message: message ?? exception.message,
      error: error ?? this.httpErrorLabel(statusCode),
    };
  }

  private httpErrorLabel(status: number): string {
    return HttpStatus[status] ?? 'Error';
  }
}

function isMulterFileSizeError(exception: unknown): boolean {
  if (!(exception instanceof Error)) return false;
  const code = (exception as { code?: unknown }).code;
  return exception.name === 'MulterError' && code === 'LIMIT_FILE_SIZE';
}