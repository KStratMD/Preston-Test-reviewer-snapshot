import { injectable } from 'inversify';
import type { ICredentialMetadataStore } from '../interfaces/ICredentialMetadataStore';
import type { CredentialMetadata } from '../types';

@injectable()
export class InMemoryCredentialMetadataStore implements ICredentialMetadataStore {
  private readonly store = new Map<string, CredentialMetadata>();

  async loadAll(): Promise<CredentialMetadata[]> {
    return Array.from(this.store.values());
  }

  async save(key: string, metadata: CredentialMetadata): Promise<void> {
    this.store.set(key, metadata);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}
