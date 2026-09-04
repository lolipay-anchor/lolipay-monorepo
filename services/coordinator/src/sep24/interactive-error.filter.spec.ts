import { HttpException, HttpStatus, Logger } from '@nestjs/common';
import { InteractiveErrorFilter } from './interactive-error.filter';

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

  it('still renders the page after setting the header, so the header is not bought with a blank body', () => {
    const { host, res } = hostWith({ id: 'abc' });
    new InteractiveErrorFilter().catch(new HttpException('nope', HttpStatus.CONFLICT), host);
    expect(res.send).toHaveBeenCalledTimes(1);
    expect(String(res.send.mock.calls[0][0])).toContain('could not continue');
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
    expect(String(told.mock.calls[1][0]).length).toBeLessThanOrEqual(1024);
  });

  it('stays quiet for an HTTP refusal, which is the user being told no, not a failure', () => {
    const told = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { host } = hostWith({ id: 'abc' });
    new InteractiveErrorFilter().catch(new HttpException('nope', HttpStatus.BAD_REQUEST), host);
    expect(told).not.toHaveBeenCalled();
  });
});
