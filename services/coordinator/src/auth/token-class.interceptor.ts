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
import { isTokenClass, MAY_USE_INTERNAL_API, TokenClass } from './role.util';

export const ALLOW_TOKEN_CLASSES = 'allowTokenClasses';

export const AllowTokenClasses =
  (...classes: TokenClass[]): MethodDecorator =>
  (target, propertyKey, descriptor) => {
    if (propertyKey === undefined) {
      throw new Error(
        'AllowTokenClasses may only decorate a method — on a class it widens every ' +
          'route on that class, including ones added later by someone who never reads it',
      );
    }
    return SetMetadata(ALLOW_TOKEN_CLASSES, classes)(target, propertyKey, descriptor);
  };

const DEFAULT_ALLOWED: readonly TokenClass[] = MAY_USE_INTERNAL_API;

@Injectable()
export class TokenClassInterceptor implements NestInterceptor {
  constructor(private reflector: Reflector) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (ctx.getType() !== 'http') return next.handle();

    const { user } = ctx.switchToHttp().getRequest();
    if (!user) return next.handle();

    const optedIn =
      this.reflector.get<readonly TokenClass[]>(ALLOW_TOKEN_CLASSES, ctx.getHandler()) ?? [];
    const allowed = [...DEFAULT_ALLOWED, ...optedIn];

    if (!isTokenClass(user.cls) || !allowed.includes(user.cls)) {
      throw new ForbiddenException('this token class may not use this endpoint');
    }
    return next.handle();
  }
}
