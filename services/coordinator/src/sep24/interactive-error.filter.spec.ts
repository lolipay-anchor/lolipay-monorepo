import { HttpException, HttpStatus } from '@nestjs/common';
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
