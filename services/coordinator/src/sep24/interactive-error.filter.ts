import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { escapeHtml, page } from './interactive-page';
import { interactiveSentenceOf } from './interactive-sentence';

type Told = { title: string; body: string };

const DEAD_LINK: Told = {
  title: 'This page can no longer be used',
  body:
    'The link that opened this page has expired, or it points to a transaction this anchor cannot show you here. ' +
    'Anything you have already started is unaffected by this page closing. Open your wallet to see where it stands.',
};

const SAID: Record<number, Told> = {
  [HttpStatus.UNAUTHORIZED]: DEAD_LINK,
  [HttpStatus.NOT_FOUND]: DEAD_LINK,
  [HttpStatus.TOO_MANY_REQUESTS]: {
    title: 'Too many requests from this connection',
    body:
      'This anchor limits how often this page can be used, and that limit has been reached for the internet connection you are on — ' +
      'which may be shared with other people. Nothing about your transaction has changed. Leave it a while, then open this page again.',
  },
  [HttpStatus.SERVICE_UNAVAILABLE]: {
    title: 'This cannot go ahead right now',
    body:
      'Something this anchor needs in order to continue is unavailable at the moment. It is not anything you did, and nothing you change here ' +
      'will get past it — this anchor is the only side that can clear it. Your transaction has not been refused. Come back to this page later.',
  },
};

const ANYTHING_ELSE: Told = {
  title: 'This step did not go through',
  body:
    'This anchor could not complete that step. Go back to see where your transaction stands now. ' +
    'If it happens again, your wallet can start a fresh one.',
};

const NO_WAY_BACK: number[] = [HttpStatus.UNAUTHORIZED, HttpStatus.NOT_FOUND];

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

    const told = SAID[status] ?? ANYTHING_ELSE;
    const said = interactiveSentenceOf(exception) ?? told.body;

    const id = String((req.params as Record<string, string>)?.id ?? '');
    const back =
      id && !NO_WAY_BACK.includes(status)
        ? `<p><a href="/sep24/interactive/${encodeURIComponent(id)}">Back to where you were</a></p>`
        : '';

    res
      .status(status)
      .type('text/html; charset=utf-8')
      .setHeader('cross-origin-opener-policy', 'unsafe-none')
      .send(page(told.title, `<p>${escapeHtml(said)}</p>${back}`));
  }
}
