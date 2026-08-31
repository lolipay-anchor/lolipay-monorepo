import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import type { Request, Response } from 'express';
import { escapeHtml, page } from './interactive-page';

@Catch()
export class InteractiveErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const res = http.getResponse<Response>();
    const req = http.getRequest<Request>();

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
            : 'This deposit could not be continued.';

    const id = String((req.params as Record<string, string>)?.id ?? '');
    const token = String((req.query as Record<string, string>)?.token ?? '');
    const back =
      id && token
        ? `<p><a href="/sep24/interactive/${encodeURIComponent(id)}?token=${encodeURIComponent(token)}">Back to your deposit</a></p>`
        : '';

    res
      .status(status)
      .type('text/html; charset=utf-8')
      .send(page('This deposit could not continue', `<p>${escapeHtml(message)}</p>${back}`));
  }
}
