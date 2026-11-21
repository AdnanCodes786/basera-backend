import { z } from 'zod';

export const PaginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type Pagination = z.infer<typeof PaginationQuery>;

export function skipFor({ page, limit }: Pagination): number {
  return (page - 1) * limit;
}

export function pageResult<T>(items: T[], total: number, { page, limit }: Pagination) {
  return { items, page, limit, total, hasMore: page * limit < total };
}
