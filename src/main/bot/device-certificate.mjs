import {createPrivateKey, randomBytes, webcrypto} from 'node:crypto';
import {isIP} from 'node:net';

/** TLS identity generated with the bundled Node crypto provider, without an external executable. */
export async function createDeviceCertificate(host, {now = Date.now()} = {}) {
  // Ordinary Bot RPCs do not need the certificate encoder on their startup path.
  await import('reflect-metadata');
  const {
    BasicConstraintsExtension, ExtendedKeyUsageExtension, KeyUsageFlags,
    KeyUsagesExtension, SubjectAlternativeNameExtension, X509CertificateGenerator,
  } = await import('@peculiar/x509');
  const keys = await webcrypto.subtle.generateKey({name: 'ECDSA', namedCurve: 'P-256'}, true, ['sign', 'verify']);
  const certificate = await X509CertificateGenerator.createSelfSigned({
    serialNumber: '01' + randomBytes(15).toString('hex'),
    name: 'CN=Hemi Bot',
    notBefore: new Date(now - 5 * 60 * 1000),
    notAfter: new Date(now + 365 * 24 * 60 * 60 * 1000),
    signingAlgorithm: {name: 'ECDSA', hash: 'SHA-256'},
    keys,
    extensions: [
      new BasicConstraintsExtension(false, undefined, true),
      new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true),
      new ExtendedKeyUsageExtension(['1.3.6.1.5.5.7.3.1']),
      new SubjectAlternativeNameExtension([{type: isIP(host) ? 'ip' : 'dns', value: host}]),
    ],
  }, webcrypto);
  const privateKey = createPrivateKey({
    key: Buffer.from(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey)),
    format: 'der', type: 'pkcs8',
  });
  return {key: privateKey.export({format: 'pem', type: 'pkcs8'}), cert: certificate.toString('pem')};
}
