const crypto = require('node:crypto');
const forge = require('node-forge');
const { PDFDocument } = require('pdf-lib');
const { pdflibAddPlaceholder } = require('@signpdf/placeholder-pdf-lib');
const { P12Signer } = require('@signpdf/signer-p12');
const signpdf = require('@signpdf/signpdf').default;

async function signPdf({ data, p12, password, pageIndex, rect, name, reason, location, contact }) {
  const doc = await PDFDocument.load(data, { updateMetadata: false });
  pdflibAddPlaceholder({
    pdfDoc: doc,
    pdfPage: doc.getPage(pageIndex),
    reason: reason || '',
    contactInfo: contact || '',
    name: name || '',
    location: location || '',
    widgetRect: rect,
    appName: 'PDF Editor',
    signatureLength: 16384,
  });
  const withPlaceholder = await doc.save({ useObjectStreams: false });
  const signer = new P12Signer(p12, { passphrase: password });
  const signed = await signpdf.sign(Buffer.from(withPlaceholder), signer);
  return new Uint8Array(signed);
}

function createDigitalId({ name, email, org, password }) {
  // Node's native key generation is much faster than forge's pure-JS RSA.
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = forge.pki.privateKeyFromPem(privateKey.export({ type: 'pkcs1', format: 'pem' }));
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.publicKeyFromPem(publicKey.export({ type: 'spki', format: 'pem' }));
  cert.serialNumber = '01' + crypto.randomBytes(8).toString('hex');
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 5);
  const attrs = [{ name: 'commonName', value: name }];
  if (org) attrs.push({ name: 'organizationName', value: org });
  if (email) attrs.push({ name: 'emailAddress', value: email });
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, nonRepudiation: true },
    { name: 'extKeyUsage', emailProtection: true },
  ]);
  cert.sign(key, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(key, [cert], password, { algorithm: '3des', friendlyName: name });
  return Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary');
}

const DIGESTS = {
  [forge.pki.oids.sha1]: 'sha1',
  [forge.pki.oids.sha256]: 'sha256',
  [forge.pki.oids.sha384]: 'sha384',
  [forge.pki.oids.sha512]: 'sha512',
};

function attrValue(attrs, oid) {
  for (const a of attrs) {
    const [typeNode, valuesNode] = a.value;
    if (forge.asn1.derToOid(typeNode.value) === oid) return valuesNode.value[0];
  }
  return null;
}

function pdfString(buf, key, from, to) {
  const s = buf.subarray(from, to).toString('latin1');
  const m = new RegExp(`/${key}\\s*\\(((?:\\\\.|[^\\\\)])*)\\)`).exec(s);
  return m ? m[1].replace(/\\(.)/g, '$1') : null;
}

/** Checks each signature's integrity: the signed byte ranges must hash to the signed digest. */
function verifySignatures(data) {
  const buf = Buffer.from(data);
  const text = buf.toString('latin1');
  const re = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g;
  const out = [];
  let m;
  let n = 0;
  while ((m = re.exec(text))) {
    n++;
    const [a, b, c, d] = m.slice(1).map(Number);
    const status = { field: `Signature ${n}`, signer: 'Unknown', date: null, reason: null, location: null, intact: false, coversWholeFile: c + d === buf.length, selfSigned: false };
    try {
      const dictStart = Math.max(0, text.lastIndexOf('<<', m.index));
      const dictEnd = text.indexOf('>>', c) + 2;
      status.reason = pdfString(buf, 'Reason', dictStart, dictEnd);
      status.location = pdfString(buf, 'Location', dictStart, dictEnd);
      const hex = buf.subarray(a + b + 1, c - 1).toString('latin1').replace(/(00)+$/, '');
      const der = forge.util.hexToBytes(hex.length % 2 ? hex + '0' : hex);
      const msg = forge.pkcs7.messageFromAsn1(forge.asn1.fromDer(der));
      const cert = msg.certificates[0];
      const cn = cert.subject.getField('CN');
      status.signer = cn ? cn.value : cert.subject.attributes.map((x) => x.value).join(', ');
      status.selfSigned = cert.isIssuer(cert);
      const attrs = msg.rawCapture.authenticatedAttributes;
      const alg = DIGESTS[forge.asn1.derToOid(msg.rawCapture.digestAlgorithm)] || 'sha256';
      const signedData = Buffer.concat([buf.subarray(a, a + b), buf.subarray(c, c + d)]);
      const digest = crypto.createHash(alg).update(signedData).digest('binary');
      const signedDigest = attrValue(attrs, forge.pki.oids.messageDigest)?.value;
      const time = attrValue(attrs, forge.pki.oids.signingTime);
      if (time) status.date = forge.asn1.utcTimeToDate(time.value).toISOString();
      const set = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SET, true, attrs);
      const md = forge.md[alg].create();
      md.update(forge.asn1.toDer(set).getBytes());
      const sigOk = cert.publicKey.verify(md.digest().bytes(), msg.rawCapture.signature);
      status.intact = sigOk && digest === signedDigest;
    } catch (e) {
      status.error = String(e.message || e);
    }
    out.push(status);
  }
  return out;
}

module.exports = { signPdf, createDigitalId, verifySignatures };
