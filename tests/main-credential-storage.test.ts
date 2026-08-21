import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createEphemeralCredentialStorage,
  isSecureStorageUsable,
  protectCredential,
  revealCredential,
  SAFE_STORAGE_VALUE_PREFIX,
  type SecureStringStorage
} from '../src/main/credential-storage.ts'

test('ephemeral credential storage keeps secrets in memory behind opaque tokens', () => {
  let tokenSequence = 0
  const storage = createEphemeralCredentialStorage(() => `token-${++tokenSequence}`)
  const protectedValue = protectCredential('secret-key', storage)

  assert.equal(protectedValue.includes('secret-key'), false)
  assert.deepEqual(revealCredential(protectedValue, storage), { value: 'secret-key' })
  assert.throws(
    () => revealCredential(protectedValue, createEphemeralCredentialStorage(() => 'unused')),
    /could not be decrypted/
  )
})

function createStorage(available = true): SecureStringStorage {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (value) => Buffer.from(`protected:${value}`, 'utf8'),
    decryptString: (value) => {
      const decoded = value.toString('utf8')
      if (!decoded.startsWith('protected:')) {
        throw new Error('Invalid encrypted value.')
      }
      return decoded.slice('protected:'.length)
    }
  }
}

test('secure storage availability rejects plaintext and unknown Linux backends', () => {
  assert.equal(isSecureStorageUsable(true, 'win32'), true)
  assert.equal(isSecureStorageUsable(true, 'darwin'), true)
  assert.equal(isSecureStorageUsable(false, 'win32'), false)
  assert.equal(isSecureStorageUsable(true, 'linux', 'gnome_libsecret'), true)
  assert.equal(isSecureStorageUsable(true, 'linux', 'kwallet6'), true)
  assert.equal(isSecureStorageUsable(true, 'linux', 'basic_text'), false)
  assert.equal(isSecureStorageUsable(true, 'linux', 'unknown'), false)
  assert.equal(isSecureStorageUsable(true, 'linux'), false)
})

test('credential storage protects and reveals API keys without exposing plaintext', () => {
  const storage = createStorage()
  const protectedValue = protectCredential('secret-key', storage)

  assert.equal(protectedValue.startsWith(SAFE_STORAGE_VALUE_PREFIX), true)
  assert.equal(protectedValue.includes('secret-key'), false)
  assert.deepEqual(revealCredential(protectedValue, storage), {
    value: 'secret-key'
  })
})

test('credential storage migrates legacy plaintext only when encryption is available', () => {
  const storage = createStorage()
  const revealed = revealCredential('legacy-secret', storage)

  assert.equal(revealed.value, 'legacy-secret')
  assert.ok(revealed.protectedValueToPersist)
  assert.equal(revealed.protectedValueToPersist.startsWith(SAFE_STORAGE_VALUE_PREFIX), true)
  assert.deepEqual(revealCredential(revealed.protectedValueToPersist, storage), {
    value: 'legacy-secret'
  })
})

test('credential storage refuses plaintext persistence and reads when secure storage is unavailable', () => {
  const storage = createStorage(false)

  assert.throws(
    () => protectCredential('secret-key', storage),
    /Secure credential storage is unavailable/
  )
  assert.throws(
    () => revealCredential('legacy-secret', storage),
    /Secure credential storage is unavailable/
  )
  assert.throws(
    () => revealCredential(`${SAFE_STORAGE_VALUE_PREFIX}cHJvdGVjdGVkOnNlY3JldA==`, storage),
    /Secure credential storage is unavailable/
  )
})

test('credential storage rejects malformed or undecryptable protected values', () => {
  const storage = createStorage()

  assert.throws(
    () => revealCredential(`${SAFE_STORAGE_VALUE_PREFIX}not-base64`, storage),
    /could not be decrypted/
  )
  assert.throws(
    () => revealCredential(`${SAFE_STORAGE_VALUE_PREFIX}${Buffer.from('wrong-value').toString('base64')}`, storage),
    /could not be decrypted/
  )
})

test('credential storage normalizes encryption failures without leaking their details', () => {
  const storage: SecureStringStorage = {
    ...createStorage(),
    encryptString: () => {
      throw new Error('sensitive backend detail')
    }
  }

  assert.throws(
    () => protectCredential('secret-key', storage),
    (error: Error) => {
      assert.match(error.message, /could not be encrypted/)
      assert.doesNotMatch(error.message, /sensitive backend detail/)
      return true
    }
  )
})
