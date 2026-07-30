export const SAFE_STORAGE_VALUE_PREFIX = 'safe-storage:v1:'

export interface SecureStringStorage {
  isEncryptionAvailable: () => boolean
  encryptString: (value: string) => Buffer
  decryptString: (value: Buffer) => string
}

export interface RevealedCredential {
  value: string
  protectedValueToPersist?: string
}

const SECURE_STORAGE_UNAVAILABLE_MESSAGE =
  'Secure credential storage is unavailable. Configure the operating system credential store, then save the API key again.'
const CREDENTIAL_ENCRYPTION_FAILED_MESSAGE =
  'The API key could not be encrypted by the operating system credential store.'
const CREDENTIAL_DECRYPTION_FAILED_MESSAGE =
  'The stored API key could not be decrypted. Clear it and save the API key again.'
const SECURE_LINUX_STORAGE_BACKENDS = new Set([
  'gnome_libsecret',
  'kwallet',
  'kwallet5',
  'kwallet6'
])

export function isSecureStorageUsable(
  encryptionAvailable: boolean,
  platform: string,
  selectedBackend?: string
): boolean {
  if (!encryptionAvailable) {
    return false
  }
  return platform !== 'linux'
    || (typeof selectedBackend === 'string' && SECURE_LINUX_STORAGE_BACKENDS.has(selectedBackend))
}

export function protectCredential(
  value: string,
  storage: SecureStringStorage
): string {
  if (!storage.isEncryptionAvailable()) {
    throw new Error(SECURE_STORAGE_UNAVAILABLE_MESSAGE)
  }

  try {
    const encrypted = storage.encryptString(value)
    if (encrypted.length === 0) {
      throw new Error('Encrypted credential is empty.')
    }
    return `${SAFE_STORAGE_VALUE_PREFIX}${encrypted.toString('base64')}`
  } catch {
    throw new Error(CREDENTIAL_ENCRYPTION_FAILED_MESSAGE)
  }
}

export function revealCredential(
  storedValue: string,
  storage: SecureStringStorage
): RevealedCredential {
  if (!storedValue.startsWith(SAFE_STORAGE_VALUE_PREFIX)) {
    return {
      value: storedValue,
      protectedValueToPersist: protectCredential(storedValue, storage)
    }
  }

  if (!storage.isEncryptionAvailable()) {
    throw new Error(SECURE_STORAGE_UNAVAILABLE_MESSAGE)
  }

  try {
    const encodedValue = storedValue.slice(SAFE_STORAGE_VALUE_PREFIX.length)
    if (!isCanonicalBase64(encodedValue)) {
      throw new Error('Credential payload is not valid base64.')
    }

    const value = storage.decryptString(Buffer.from(encodedValue, 'base64'))
    if (!value) {
      throw new Error('Decrypted credential is empty.')
    }
    return { value }
  } catch {
    throw new Error(CREDENTIAL_DECRYPTION_FAILED_MESSAGE)
  }
}

function isCanonicalBase64(value: string): boolean {
  return value.length > 0
    && value.length % 4 === 0
    && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
}
