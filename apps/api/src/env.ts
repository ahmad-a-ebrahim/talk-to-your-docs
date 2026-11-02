import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
});

export type Env = z.infer<typeof envSchema>;

/** Validate once at startup: a missing or malformed secret should stop the process, not surface on the first request. */
function loadEnv(): Env {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    // prettifyError lists which variables failed; it never echoes their values, so secrets stay out of logs.
    console.error(`Invalid environment configuration:\n${z.prettifyError(result.error)}`);
    process.exit(1);
  }
  return result.data;
}

export const env = loadEnv();
