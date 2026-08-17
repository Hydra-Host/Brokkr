import { PaginationQuerySchema } from '../pagination';

describe('PaginationQuerySchema', () => {
  it('defaults page to 1 when omitted', () => {
    const result = PaginationQuerySchema.parse({});
    expect(result.page).toBe(1);
  });

  it('coerces numeric strings (query params arrive as strings)', () => {
    const result = PaginationQuerySchema.parse({ page: '3', pageSize: '25' });
    expect(result.page).toBe(3);
    expect(result.pageSize).toBe(25);
  });

  describe('page bounds', () => {
    it('rejects page below 1', () => {
      expect(PaginationQuerySchema.safeParse({ page: '0' }).success).toBe(false);
    });

    it('rejects a non-integer page', () => {
      expect(PaginationQuerySchema.safeParse({ page: '1.5' }).success).toBe(false);
    });

    it('rejects a page large enough to overflow the SQL OFFSET (would otherwise 500)', () => {
      expect(PaginationQuerySchema.safeParse({ page: '9223372036854775807' }).success).toBe(false);
      expect(PaginationQuerySchema.safeParse({ page: '1e21' }).success).toBe(false);
    });

    it('accepts page at the 1e9 cap and rejects one above it', () => {
      expect(PaginationQuerySchema.safeParse({ page: '1000000000' }).success).toBe(true);
      expect(PaginationQuerySchema.safeParse({ page: '1000000001' }).success).toBe(false);
    });
  });

  describe('pageSize bounds', () => {
    it('accepts pageSize at the max of 100', () => {
      expect(PaginationQuerySchema.safeParse({ pageSize: '100' }).success).toBe(true);
    });

    it('rejects pageSize above 100', () => {
      expect(PaginationQuerySchema.safeParse({ pageSize: '101' }).success).toBe(false);
    });

    it('rejects pageSize below 1', () => {
      expect(PaginationQuerySchema.safeParse({ pageSize: '0' }).success).toBe(false);
    });
  });

  it('rejects a search string over 200 chars', () => {
    expect(PaginationQuerySchema.safeParse({ search: 'x'.repeat(201) }).success).toBe(false);
    expect(PaginationQuerySchema.safeParse({ search: 'x'.repeat(200) }).success).toBe(true);
  });
});
