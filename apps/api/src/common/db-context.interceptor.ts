import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { dbContext } from '../prisma/prisma.service';
import type { AuthedRequest } from './request-context';

/**
 * Runs every HTTP handler with the caller as the database context (Postgres RLS). Guards have
 * already authenticated the request; a public route runs with no user, so RLS hides all
 * conversation rows from it.
 */
@Injectable()
export class DbContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const store = { userId: req.ctx?.userId ?? null, scope: req.ctx?.permissions['conversation.read'] ?? '' };
    return new Observable((subscriber) => dbContext.run(store, () => next.handle().subscribe(subscriber)));
  }
}
