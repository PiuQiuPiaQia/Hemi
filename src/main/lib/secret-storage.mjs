import { app } from 'electron';
import path from 'node:path';
import { createLocalSecretStorage, isLocalCiphertext } from './local-secrets.mjs';

let currentDirectory;
let currentStorage;

function storage() {
  // Imports happen before index.mjs selects userData, so resolve the path lazily.
  const directory = path.join(app.getPath('userData'), 'secrets');
  if (directory !== currentDirectory) {
    currentStorage = createLocalSecretStorage({ directory });
    currentDirectory = directory;
  }
  return currentStorage;
}

// Match the injected crypto interface of the stores, using local files only.
export const secretStorage = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'hemi_local',
  isLocalCiphertext,
  encryptString: text => storage().encryptString(text),
  decryptString: blob => storage().decryptString(blob),
};
