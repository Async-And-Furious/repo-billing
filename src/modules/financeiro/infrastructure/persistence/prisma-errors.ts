import { Prisma } from '@prisma/client';

// P2002: violação de unique constraint.
export const violouUnicidade = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
