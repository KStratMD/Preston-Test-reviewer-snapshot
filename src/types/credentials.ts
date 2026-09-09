export interface CredentialMetadata {
  systemType: string;
  systemId: string;
  credentialType: string;
  lastRotated?: Date;
  expiresAt?: Date;
  rotationRequired: boolean;
  lastAccessed?: Date;
  accessCount: number;
}
