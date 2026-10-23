import assert from "node:assert/strict";
import { constants, createHash, generateKeyPairSync, privateEncrypt } from "node:crypto";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const forge = require("node-forge");
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, publicExponent: 3 });
const verifier = forge.pki.publicKeyFromPem(publicKey.export({ type: "spki", format: "pem" }));
const digest = createHash("sha256").update("security regression").digest();
const asn1 = forge.asn1;
const node = (type: number, constructed: boolean, value: unknown) => asn1.create(asn1.Class.UNIVERSAL, type, constructed, value);

for (const parameters of [false, true]) {
  for (const extra of [false, true]) test(`RSA DigestAlgorithm ${parameters ? "with" : "without"} NULL ${extra ? "rejects nested garbage" : "accepts valid signature"}`, () => {
    const algorithm = [node(asn1.Type.OID, false, asn1.oidToDer(forge.pki.oids.sha256).getBytes())];
    if (parameters) algorithm.push(node(asn1.Type.NULL, false, ""));
    if (extra) algorithm.push(node(asn1.Type.OCTETSTRING, false, "unconsumed attacker bytes"));
    const info = node(asn1.Type.SEQUENCE, true, [node(asn1.Type.SEQUENCE, true, algorithm), node(asn1.Type.OCTETSTRING, false, digest.toString("binary"))]);
    const der = Buffer.from(asn1.toDer(info).getBytes(), "binary");
    const signature = privateEncrypt({ key: privateKey, padding: constants.RSA_PKCS1_PADDING }, der);
    const verify = () => verifier.verify(digest.toString("binary"), signature.toString("binary"));
    if (extra) assert.throws(verify, /DigestInfo/);
    else assert.equal(verify(), true);
  });
}
