import {
  CallHandler,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { isTokenClass, TokenClass } from './role.util';

export const ALLOW_TOKEN_CLASSES = 'allowTokenClasses';

export const AllowTokenClasses = (...classes: TokenClass[]) =>
  SetMetadata(ALLOW_TOKEN_CLASSES, classes);

const DEFAULT_ALLOWED: readonly TokenClass[] = ['session'];

@Injectable()
export class TokenClassInterceptor implements NestInterceptor {
  constructor(private reflector: Reflector) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (ctx.getType() !== 'http') return next.handle();

    const { user } = ctx.switchToHttp().getRequest();
    if (!user) return next.handle();

    const allowed =
      this.reflector.getAllAndOverride<readonly TokenClass[]>(ALLOW_TOKEN_CLASSES, [
        ctx.getHandler(),
        ctx.getClass(),
      ]) ?? DEFAULT_ALLOWED;

    if (!isTokenClass(user.cls) || !allowed.includes(user.cls)) {
      throw new ForbiddenException('this token class may not use this endpoint');
    }
    return next.handle();
  }
}
