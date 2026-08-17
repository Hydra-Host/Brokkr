export interface TestUser {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
}

const TEST_USERS: TestUser[] = [
  {
    email: 'e2e-standard@test.brokkr.local',
    password: 'TestPassword123!',
    firstName: 'E2E',
    lastName: 'Standard',
  },
  {
    email: 'e2e-orguser@test.brokkr.local',
    password: 'TestPassword123!',
    firstName: 'E2E',
    lastName: 'Orguser',
  },
];

export async function createTestUsers(apiUrl: string): Promise<void> {
  const origin = process.env.BASE_URL ?? 'http://localhost:5173';

  for (const user of TEST_USERS) {
    try {
      const response = await fetch(`${apiUrl}/api/v1/auth/sign-up/email`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: origin,
          Referer: `${origin}/`,
        },
        body: JSON.stringify({
          name: `${user.firstName} ${user.lastName}`,
          email: user.email,
          password: user.password,
          firstName: user.firstName,
          lastName: user.lastName,
        }),
      });

      if (!response.ok) {
        const body = (await response.json()) as { message?: string };
        const message = body.message ?? response.statusText;
        if (message.toLowerCase().includes('already exists')) {
          console.log(`User ${user.email} already exists, continuing.`);
          continue;
        }
        console.warn(`Warning: failed to create user ${user.email}: ${message}`);
      } else {
        console.log(`Created user: ${user.email}`);
      }
    } catch (err) {
      console.warn(`Warning: error creating user ${user.email}:`, err);
    }
  }
}
