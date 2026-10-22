import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const FAMILY = Buffer.from('HEMI\0');
const HEADER = Buffer.concat([FAMILY, Buffer.from([1])]);
const IV_BYTES = 12;
const TAG_BYTES = 16;

export function isLocalCiphertext(blob) {
  return Buffer.isBuffer(blob) && blob.length >= HEADER.length + IV_BYTES + TAG_BYTES
    && blob.subarray(0, HEADER.length).equals(HEADER);
}

/** Stores may inject a different crypto implementation in tests. Production
 * storage advertises its supported format without opening the key file. */
export function hasSupportedSecret(storage, encoded) {
  return typeof encoded === 'string' && encoded.length > 0
    && (storage?.isLocalCiphertext?.(Buffer.from(encoded, 'base64')) ?? true);
}

/** App-owned AES-GCM storage. Back up the private userData/secrets directory
 * together with encrypted configuration files. Only the local format is read. */
export function createLocalSecretStorage({ directory }) {
  const keyFile = path.join(directory, 'key-v1');
  const keyDigestFile = `${keyFile}.sha256`;

  function ensureDirectory() {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (lstatSync(directory).isSymbolicLink()) throw new Error('本地密钥目录不能是符号链接');
    if (process.platform !== 'win32') chmodSync(directory, 0o700);
  }

  function readKey(create) {
    if (!existsSync(keyFile) && create) {
      if (existsSync(keyDigestFile)) {
        throw new Error('本地密钥文件缺失，请从备份恢复应用数据。');
      }
      ensureDirectory();
      let fd;
      try {
        fd = openSync(keyFile, 'wx', 0o600);
        writeFileSync(fd, randomBytes(32));
        fsyncSync(fd);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    }
    try {
      const stat = lstatSync(keyFile);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== 32) throw new Error('invalid');
      const key = readFileSync(keyFile);
      if (key.length !== 32) throw new Error('invalid');
      const digest = createHash('sha256').update(key).digest('hex');
      if (existsSync(keyDigestFile)) {
        if (readFileSync(keyDigestFile, 'utf8') !== digest) throw new Error('invalid');
      } else if (create) {
        try { writeFileSync(keyDigestFile, digest, { flag: 'wx', mode: 0o600 }); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
      }
      return key;
    } catch {
      // Never generate a replacement while reading existing ciphertext.
      throw new Error('本地密钥文件缺失或损坏，请从备份恢复应用数据，或重新填写对应密钥。');
    }
  }

  function encryptString(text) {
    if (typeof text !== 'string') throw new TypeError('密钥内容必须是字符串');
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', readKey(true), iv);
    cipher.setAAD(HEADER);
    const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return Buffer.concat([HEADER, iv, cipher.getAuthTag(), encrypted]);
  }

  function decryptLocal(blob) {
    if (!isLocalCiphertext(blob)) {
      throw new Error('密钥格式不受支持，请重新配置。');
    }
    const decipher = createDecipheriv('aes-256-gcm', readKey(false), blob.subarray(HEADER.length, HEADER.length + IV_BYTES));
    decipher.setAAD(HEADER);
    decipher.setAuthTag(blob.subarray(HEADER.length + IV_BYTES, HEADER.length + IV_BYTES + TAG_BYTES));
    try {
      return Buffer.concat([decipher.update(blob.subarray(HEADER.length + IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
    } catch {
      throw new Error('本地密文无法解密，请恢复备份或重新填写对应密钥。');
    }
  }

  function decryptString(value) {
    return decryptLocal(Buffer.from(value));
  }

  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'hemi_local',
    encryptString,
    decryptString,
    isLocalCiphertext,
  };
}
