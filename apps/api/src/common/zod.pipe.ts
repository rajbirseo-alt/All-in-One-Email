import { PipeTransform } from '@nestjs/common';
import type { ZodTypeAny, z } from 'zod';
import { Errors } from './errors';

/** `@Body(new ZodPipe(schema))` — validates and returns the parsed (coerced, trimmed) value. */
export class ZodPipe<S extends ZodTypeAny> implements PipeTransform<unknown, z.infer<S>> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.infer<S> {
    const r = this.schema.safeParse(value ?? {});
    if (!r.success) {
      throw Errors.validation(r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
    }
    return r.data;
  }
}
