import test from 'node:test';
import assert from 'node:assert/strict';
import {createPrivateKey, X509Certificate} from 'node:crypto';
import {isIP} from 'node:net';
import {createDeviceCertificate} from './device-certificate.mjs';

for (const host of ['127.0.0.1', '2001:db8::1', 'bot.example.test']) {
  test(`generated TLS identity has the exact SAN, matching P-256 key and server purpose: ${host}`, async () => {
    const now = Date.now(), identity = await createDeviceCertificate(host, {now});
    const cert = new X509Certificate(identity.cert), key = createPrivateKey(identity.key);
    assert.equal(cert.ca, false);
    assert.equal(cert.publicKey.asymmetricKeyDetails.namedCurve, 'prime256v1');
    assert.equal(cert.verify(cert.publicKey), true);
    assert.equal(cert.checkPrivateKey(key), true);
    assert.equal(cert.subject, cert.issuer);
    assert.ok(isIP(host) ? cert.checkIP(host) : cert.checkHost(host));
    assert.equal(cert.checkHost('unrelated.example.test'), undefined);
    assert.ok(cert.keyUsage.includes('1.3.6.1.5.5.7.3.1'));
    assert.ok(Date.parse(cert.validFrom) <= now);
    assert.ok(Math.abs(Date.parse(cert.validTo) - now - 365 * 86400000) < 1000);
  });
}
