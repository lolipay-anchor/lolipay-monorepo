import { ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class Sep24AuthGuard extends AuthGuard('jwt') {
  handleRequest<T>(err: unknown, user: T, _info: unknown, _context: ExecutionContext): T {
    if (err || !user) {
      throw new ForbiddenException('this endpoint requires a SEP-10 token');
    }
    return user;
  }
}
