import type { CredentialMetadata } from '../types';

export interface ICredentialMetadataStore {
  loadAll(): Promise<CredentialMetadata[]>;
  save(key: string, metadata: CredentialMetadata): Promise<void>;
  delete(key: string): Promise<void>;
}
