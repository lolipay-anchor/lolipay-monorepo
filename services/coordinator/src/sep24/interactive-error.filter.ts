import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { escapeHtml, page } from './interactive-page';

@Catch()
export class InteractiveErrorFilter implements ExceptionFilter {
  private readonly log = new Logger('Interactive');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const res = http.getResponse<Response>();
    const req = http.getRequest<Request>();
    if (!(exception instanceof HttpException)) {
      const what = exception instanceof Error ? `${exception.name}: ${exception.message}` : String(exception);
      this.log.error(`${req.method} ${req.path.slice(0, 200)} could not continue: ${what}`.slice(0, 1024));
    }

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const said =
      exception instanceof HttpException ? (exception.getResponse() as any) : undefined;
    const message =
      typeof said === 'string'
        ? said
        : typeof said?.message === 'string'
          ? said.message
          : Array.isArray(said?.message)
            ? said.message.join('. ')
            : 'This could not be continued.';

    const id = String((req.params as Record<string, string>)?.id ?? '');
    const back =
      id && status !== HttpStatus.UNAUTHORIZED
        ? `<p><a href="/sep24/interactive/${encodeURIComponent(id)}">Back to where you were</a></p>`
        : '';

    res
      .status(status)
      .type('text/html; charset=utf-8')
      .setHeader('cross-origin-opener-policy', 'unsafe-none')
      .send(page('This could not continue', `<p>${escapeHtml(message)}</p>${back}`));
  }
}
