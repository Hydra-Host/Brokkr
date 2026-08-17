import { UserProfileSchema } from '../users';

describe('UserProfileSchema', () => {
  const INTERNAL_FIELDS = [
    'role',
    'banned',
    'banReason',
    'banExpires',
    'auth0Id',
    'phoneNumber',
    'phoneNumberVerified',
    'emailVerified',
  ];

  it('strips internal account fields from a full user row', () => {
    const fullRow = {
      id: 'u1',
      email: 'a@b.com',
      firstName: 'A',
      lastName: 'B',
      name: 'A B',
      image: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      role: 'admin',
      banned: true,
      banReason: 'spam',
      banExpires: new Date(),
      auth0Id: 'auth0|1',
      phoneNumber: '+15555550100',
      phoneNumberVerified: true,
      emailVerified: true,
    };

    const parsed = UserProfileSchema.parse(fullRow);

    for (const field of INTERNAL_FIELDS) {
      expect(parsed).not.toHaveProperty(field);
    }
    expect(parsed).toMatchObject({ id: 'u1', email: 'a@b.com', firstName: 'A', lastName: 'B' });
  });

  it('accepts a minimal profile and rejects an invalid email', () => {
    const base = {
      id: 'u1',
      firstName: null,
      lastName: null,
      name: null,
      image: null,
      createdAt: new Date(),
      updatedAt: null,
    };
    expect(UserProfileSchema.safeParse({ ...base, email: 'a@b.com' }).success).toBe(true);
    expect(UserProfileSchema.safeParse({ ...base, email: 'not-an-email' }).success).toBe(false);
  });
});
