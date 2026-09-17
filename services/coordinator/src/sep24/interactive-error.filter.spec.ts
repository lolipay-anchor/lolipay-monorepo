import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { InteractiveErrorFilter } from './interactive-error.filter';
import { NO_PROVIDER_SENTENCE, withInteractiveSentence, withOwnSentence } from './interactive-sentence';

function hostWith(params: Record<string, string> = {}) {
  const headers: Record<string, string> = {};
  const res: any = {
    status: jest.fn(() => res),
    type: jest.fn(() => res),
    setHeader: jest.fn((k: string, v: string) => {
      headers[k.toLowerCase()] = v;
      return res;
    }),
    send: jest.fn(() => res),
  };
  const host: any = {
    switchToHttp: () => ({ getResponse: () => res, getRequest: () => ({ params }) }),
  };
  return { host, res, headers };
}

function rendered(exception: unknown, params: Record<string, string> = { id: 'abc' }): string {
  const { host, res } = hostWith(params);
  new InteractiveErrorFilter().catch(exception, host);
  return String(res.send.mock.calls[0][0]);
}

function wordsAPersonReads(html: string): string {
  const open = html.indexOf('<main>');
  const close = html.indexOf('</main>');
  expect(open).toBeGreaterThan(-1);
  expect(close).toBeGreaterThan(open);
  const text = html.slice(open, close).replace(/<[^>]*>/g, ' ');
  expect(text).toContain('lolipay');
  return text;
}

const THROTTLED_TITLE = 'Too many requests from this connection';
const THROTTLED_BODY =
  'This anchor limits how often this page can be used, and that limit has been reached for the internet connection you are on — which may be shared with other people. Nothing about your transaction has changed. Leave it a while, then open this page again.';
const DEAD_LINK_TITLE = 'This page can no longer be used';
const DEAD_LINK_BODY =
  'The link that opened this page has expired, or it points to a transaction this anchor cannot show you here. Anything you have already started is unaffected by this page closing. Open your wallet to see where it stands.';
const UNAVAILABLE_TITLE = 'This cannot go ahead right now';
const UNAVAILABLE_BODY =
  'Something this anchor needs in order to continue is unavailable at the moment. It is not anything you did, and nothing you change here will get past it — this anchor is the only side that can clear it. Your transaction has not been refused. Come back to this page later.';
const ANYTHING_ELSE_TITLE = 'This step did not go through';
const ANYTHING_ELSE_BODY =
  'This anchor could not complete that step. Go back to see where your transaction stands now. If it happens again, your wallet can start a fresh one.';

describe('the interactive error page keeps the popup in its opener group', () => {
  it('sets cross-origin-opener-policy itself, because a guard can answer before the route decorator runs', () => {
    const { host, headers } = hostWith({ id: 'abc' });
    new InteractiveErrorFilter().catch(
      new HttpException('too many requests', HttpStatus.TOO_MANY_REQUESTS),
      host,
    );
    expect(headers['cross-origin-opener-policy']).toBe('unsafe-none');
  });

  it('sets it on every status it renders, not only the throttled one', () => {
    for (const status of [
      HttpStatus.UNAUTHORIZED,
      HttpStatus.BAD_REQUEST,
      HttpStatus.CONFLICT,
      HttpStatus.INTERNAL_SERVER_ERROR,
    ]) {
      const { host, headers, res } = hostWith({ id: 'abc' });
      new InteractiveErrorFilter().catch(new HttpException('nope', status), host);
      expect(res.status).toHaveBeenCalledWith(status);
      expect(headers['cross-origin-opener-policy']).toBe('unsafe-none');
    }
  });

  it('still renders the page after setting the header, so the header is not bought with a blank body — pinned on the catch-all title now that the page no longer echoes the message', () => {
    const { host, res } = hostWith({ id: 'abc' });
    new InteractiveErrorFilter().catch(new HttpException('nope', HttpStatus.CONFLICT), host);
    expect(res.send).toHaveBeenCalledTimes(1);
    expect(String(res.send.mock.calls[0][0])).toContain(ANYTHING_ELSE_TITLE);
  });
});

describe('the interactive error page says one fixed thing per status and never repeats the exception', () => {
  it('renders no digit in any word a person reads, so a count inside an exception message cannot reach the screen', () => {
    const budget = new ServiceUnavailableException(
      'this anchor has already opened 91 verifications in the last day, which is its whole budget',
    );
    const read = wordsAPersonReads(rendered(budget));
    expect(read).not.toMatch(/\d/);
    expect(read).not.toContain('verifications in the last day');
    expect(read).toContain(UNAVAILABLE_TITLE);
    expect(read).toContain(UNAVAILABLE_BODY);
  });

  it('renders the throttled sentence for a real ThrottlerException and never the framework own wording', () => {
    const html = rendered(new ThrottlerException());
    expect(html).toContain(THROTTLED_TITLE);
    expect(html).toContain(THROTTLED_BODY);
    expect(html).not.toContain('Too Many Requests');
    expect(html).not.toContain('ThrottlerException');
  });

  it('gives 401 and 404 the one sentence about a link that no longer opens anything', () => {
    for (const status of [HttpStatus.UNAUTHORIZED, HttpStatus.NOT_FOUND]) {
      const html = rendered(new HttpException('this link belongs to a different transaction', status));
      expect(html).toContain(DEAD_LINK_TITLE);
      expect(html).toContain(DEAD_LINK_BODY);
      expect(html).not.toContain('different transaction');
    }
  });

  it('gives an unopted 503 the generic unavailable sentence rather than what was thrown', () => {
    const html = rendered(new ServiceUnavailableException('the price adapter is down'));
    expect(html).toContain(UNAVAILABLE_TITLE);
    expect(html).toContain(UNAVAILABLE_BODY);
    expect(html).not.toContain('price adapter');
  });

  it('gives 400, 403, 409, 500 and an unmapped status the same catch-all, never the thrown message', () => {
    for (const status of [
      HttpStatus.BAD_REQUEST,
      HttpStatus.FORBIDDEN,
      HttpStatus.CONFLICT,
      HttpStatus.INTERNAL_SERVER_ERROR,
      HttpStatus.UNPROCESSABLE_ENTITY,
    ]) {
      const html = rendered(new HttpException('an internal detail nobody outside should read', status));
      expect(html).toContain(ANYTHING_ELSE_TITLE);
      expect(html).toContain(ANYTHING_ELSE_BODY);
      expect(html).not.toContain('an internal detail nobody outside should read');
    }
  });

  it('says nothing of a non-HttpException either, and still answers 500 with the catch-all', () => {
    const res: any = { status: jest.fn(() => res), type: jest.fn(() => res), setHeader: jest.fn(() => res), send: jest.fn(() => res) };
    const req = { params: { id: 'abc' }, method: 'POST', path: '/sep24/interactive/abc/amount' };
    const host: any = { switchToHttp: () => ({ getResponse: () => res, getRequest: () => req }) };
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    new InteractiveErrorFilter().catch(new TypeError('Cannot read properties of undefined'), host);
    const html = String(res.send.mock.calls[0][0]);
    expect(res.status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(html).toContain(ANYTHING_ELSE_TITLE);
    expect(html).not.toContain('Cannot read properties');
    jest.restoreAllMocks();
  });

  it('offers the way back on every status except the two that say the link is dead', () => {
    const link = '<a href="/sep24/interactive/abc">';
    expect(rendered(new ThrottlerException())).toContain(link);
    expect(rendered(new ServiceUnavailableException('x'))).toContain(link);
    expect(rendered(new HttpException('x', HttpStatus.CONFLICT))).toContain(link);
    expect(rendered(new HttpException('x', HttpStatus.UNAUTHORIZED))).not.toContain(link);
    expect(rendered(new HttpException('x', HttpStatus.NOT_FOUND))).not.toContain(link);
  });
});

describe('a thrower that opts in supplies the paragraph, and only the paragraph', () => {
  it('shows the no-provider sentence under the unavailable title instead of the generic body', () => {
    const refusal = withInteractiveSentence(
      new ServiceUnavailableException('no eligible LP available'),
      NO_PROVIDER_SENTENCE,
    );
    const html = rendered(refusal);
    expect(html).toContain(UNAVAILABLE_TITLE);
    expect(html).toContain('This can last hours');
    expect(html).not.toContain(UNAVAILABLE_BODY);
    expect(html).not.toContain('no eligible LP available');
  });

  it('shows the permanent-refusal sentence rather than the catch-all body a retry would deserve', () => {
    const refusal = withInteractiveSentence(
      new ForbiddenException('this identity was refused and cannot be resubmitted here'),
      'This anchor has refused this identity, and that decision does not change. Sending your details here again will not reopen it, so there is nothing to wait for.',
    );
    const html = rendered(refusal);
    expect(html).toContain(ANYTHING_ELSE_TITLE);
    expect(html).toContain('there is nothing to wait for');
    expect(html).not.toContain(ANYTHING_ELSE_BODY);
    expect(html).not.toContain('cannot be resubmitted here');
  });

  it('leaves the json body byte-identical, because the web app matches the internal string with a regex', () => {
    const bare = new ServiceUnavailableException('no eligible LP available');
    const marked = withInteractiveSentence(
      new ServiceUnavailableException('no eligible LP available'),
      'anything at all',
    );
    expect(marked.getResponse()).toEqual(bare.getResponse());
    expect(JSON.stringify(marked.getResponse())).toBe(JSON.stringify(bare.getResponse()));
    expect(Object.keys(marked)).toEqual(Object.keys(bare));
  });

  it('carries a thrower own words through withOwnSentence, digits and all, because that thrower wrote them for this screen', () => {
    const spelt = 'Enter the amount in plain digits, like 200.000, with no comma and no decimals.';
    expect(new BadRequestException(spelt).message).toBe(spelt);
    const html = rendered(withOwnSentence(new BadRequestException(spelt)));
    expect(html).toContain('Enter the amount in plain digits');
    expect(html).toContain('200.000');
    expect(html).not.toContain(ANYTHING_ELSE_BODY);
    expect(html).toContain(ANYTHING_ELSE_TITLE);
  });

  it('still says the fixed thing for a thrower beside it that did not opt in, so withOwnSentence widens nothing by itself', () => {
    const html = rendered(new BadRequestException('an internal detail nobody outside should read'));
    expect(html).toContain(ANYTHING_ELSE_BODY);
    expect(html).not.toContain('an internal detail');
  });

  it('ignores a marker that is not a sentence, so a stray property cannot become the page', () => {
    const odd = new ServiceUnavailableException('x');
    Object.defineProperty(odd, 'lolipayInteractiveSentence', { value: { nope: true } });
    expect(rendered(odd)).toContain(UNAVAILABLE_BODY);
  });
});

describe('the interactive error page tells the operator about the failures it hides from the user', () => {
  afterEach(() => jest.restoreAllMocks());

  it('logs a non-HTTP error with the route and the error, never the body, and still answers 500', () => {
    const told = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const res: any = { status: jest.fn(() => res), type: jest.fn(() => res), setHeader: jest.fn(() => res), send: jest.fn(() => res) };
    const req = { params: { id: 'abc' }, method: 'POST', path: '/sep24/interactive/abc/amount', body: 'S_SHOULD_NEVER_BE_LOGGED' };
    const host: any = { switchToHttp: () => ({ getResponse: () => res, getRequest: () => req }) };
    new InteractiveErrorFilter().catch(new TypeError("Cannot read properties of undefined (reading 'fiat_amount')"), host);
    expect(res.status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(told).toHaveBeenCalledTimes(1);
    const line = String(told.mock.calls[0][0]);
    expect(line).toContain('POST /sep24/interactive/abc/amount');
    expect(line).toContain("TypeError: Cannot read properties of undefined (reading 'fiat_amount')");
    expect(line).not.toContain('S_SHOULD_NEVER_BE_LOGGED');
    const long = new Error('x'.repeat(5000));
    new InteractiveErrorFilter().catch(long, host);
    expect(String(told.mock.calls[1][0]).length).toBe(1024);
    const longPath = { params: { id: 'x'.repeat(5000) }, method: 'POST', path: `/sep24/interactive/${'x'.repeat(5000)}/amount`, body: '' };
    const hostLongPath: any = { switchToHttp: () => ({ getResponse: () => res, getRequest: () => longPath }) };
    new InteractiveErrorFilter().catch(new TypeError('the name must survive a long path'), hostLongPath);
    expect(String(told.mock.calls[2][0])).toContain('TypeError: the name must survive a long path');
  });

  it('stays quiet for an HTTP refusal, which is the user being told no, not a failure', () => {
    const told = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { host } = hostWith({ id: 'abc' });
    new InteractiveErrorFilter().catch(new HttpException('nope', HttpStatus.BAD_REQUEST), host);
    expect(told).not.toHaveBeenCalled();
  });
});
