import { createId } from '@paralleldrive/cuid2';

export const generateObjectId = (prefix: string) => {
  if (!prefix || prefix.length === 0) {
    throw new Error('Prefix must be a non-empty string');
  }

  return `${prefix}_${createId()}`;
};
