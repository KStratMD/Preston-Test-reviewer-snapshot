import { randomUUID } from 'node:crypto';

export function uuidv4(): string {
  return randomUUID();
}
