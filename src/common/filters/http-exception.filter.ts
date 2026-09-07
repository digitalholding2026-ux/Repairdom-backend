import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Response } from 'express';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<{ method: string; url: string }>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
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
            error: 'InternalServerError',
            message: 'Une erreur interne est survenue.',
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