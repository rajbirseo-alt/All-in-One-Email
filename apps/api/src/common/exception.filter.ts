import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { Prisma } from '@crm/db';
import type { Response } from 'express';

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly log = new Logger('Http');

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const [status, body] = this.map(exception);
    if (status >= 500) this.log.error(exception instanceof Error ? exception.stack : String(exception));
    res.status(status).json(body);
  }

  private map(e: unknown): [number, unknown] {
    if (e instanceof ThrottlerException) {
      return [HttpStatus.TOO_MANY_REQUESTS, { error: { code: 'RATE_LIMITED', message: 'Too many requests — try again shortly' } }];
    }
    if (e instanceof HttpException) {
      const r = e.getResponse();
      if (typeof r === 'object' && r && 'error' in r) return [e.getStatus(), r];
      const message = typeof r === 'string' ? r : ((r as { message?: string }).message ?? e.message);
      const code = e.getStatus() === 404 ? 'NOT_FOUND' : HttpStatus[e.getStatus()] ?? 'ERROR';
      return [e.getStatus(), { error: { code, message: Array.isArray(message) ? message.join('; ') : message } }];
    }
    if (e instanceof Prisma.PrismaClientKnownRequestError) {
      if (e.code === 'P2002') {
        const target = (e.meta?.target as string[] | undefined)?.join(', ');
        return [HttpStatus.CONFLICT, { error: { code: 'CONFLICT', message: `Already exists${target ? ` (${target})` : ''}` } }];
      }
      if (e.code === 'P2025') return [HttpStatus.NOT_FOUND, { error: { code: 'NOT_FOUND', message: 'Record not found' } }];
      if (e.code === 'P2003') {
        return [HttpStatus.CONFLICT, { error: { code: 'IN_USE', message: 'This record is referenced by other records' } }];
      }
    }
    return [HttpStatus.INTERNAL_SERVER_ERROR, { error: { code: 'INTERNAL', message: 'Something went wrong' } }];
  }
}
