import {
  sniffFileType,
  newProofKey,
  deterministicKey,
  EXT_CONTENT_TYPE,
} from './upload.util';

const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16, 0)]);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(16, 0),
]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF', 'ascii'),
  Buffer.from([0x24, 0x00, 0x00, 0x00]),
  Buffer.from('WEBP', 'ascii'),
  Buffer.alloc(8, 0),
]);
const PDF = Buffer.from('%PDF-1.4\n%%EOF', 'ascii');

describe('sniffFileType (magic-bytes detection)', () => {
  it('detects a JPEG by its FF D8 FF signature', () => {
    expect(sniffFileType(JPG)).toEqual({ mime: 'image/jpeg', ext: 'jpg' });
  });

  it('detects a PNG by its 8-byte signature', () => {
    expect(sniffFileType(PNG)).toEqual({ mime: 'image/png', ext: 'png' });
  });

  it('detects a WEBP by RIFF....WEBP', () => {
    expect(sniffFileType(WEBP)).toEqual({ mime: 'image/webp', ext: 'webp' });
  });

  it('detects a PDF by %PDF', () => {
    expect(sniffFileType(PDF)).toEqual({ mime: 'application/pdf', ext: 'pdf' });
  });

  it('returns null for unrecognized bytes (not on any whitelist)', () => {
    expect(sniffFileType(Buffer.from('just some plain text, not a file', 'ascii'))).toBeNull();
  });

  it('returns null for an empty buffer', () => {
    expect(sniffFileType(Buffer.alloc(0))).toBeNull();
  });

  it('returns null for a too-short buffer that only partially matches a signature', () => {
    expect(sniffFileType(Buffer.from([0xff]))).toBeNull();

    expect(sniffFileType(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
  });

  it('does not mistake a GIF (a non-whitelisted format) for anything on the list', () => {
    const gif = Buffer.from('GIF89a', 'ascii');
    expect(sniffFileType(gif)).toBeNull();
  });

  it('returns null for null/undefined input', () => {
    expect(sniffFileType(null)).toBeNull();
    expect(sniffFileType(undefined)).toBeNull();
  });
});

describe('EXT_CONTENT_TYPE', () => {
  it('covers exactly the four whitelisted extensions', () => {
    expect(EXT_CONTENT_TYPE).toEqual({
      jpg: 'image/jpeg',
      png: 'image/png',
      webp: 'image/webp',
      pdf: 'application/pdf',
    });
  });
});

describe('newProofKey (Phase 5C — MinIO object key builder)', () => {
  it('builds a key under the given kind with a fresh UUID and the given extension', () => {
    const key = newProofKey('proofs', 'jpg');
    expect(key).toMatch(/^proofs\/[0-9a-f-]{36}\.jpg$/);
  });

  it('builds an evidence-kind key too', () => {
    const key = newProofKey('evidence', 'pdf');
    expect(key).toMatch(/^evidence\/[0-9a-f-]{36}\.pdf$/);
  });

  it('two calls never collide — distinct UUID keys even for the same kind/ext', () => {
    const a = newProofKey('proofs', 'jpg');
    const b = newProofKey('proofs', 'jpg');
    expect(a).not.toBe(b);
  });
});

describe('deterministicKey (Phase 5C — MinIO object key builder)', () => {
  it('builds the exact key.ext path (no random component)', () => {
    expect(deterministicKey('evidence', 'order-1-user', 'jpg')).toBe('evidence/order-1-user.jpg');
  });

  it('the SAME key+ext called twice yields the SAME key (replace-in-place identity)', () => {
    const a = deterministicKey('evidence', 'order-1-user', 'jpg');
    const b = deterministicKey('evidence', 'order-1-user', 'jpg');
    expect(a).toBe(b);
  });

  it('a DIFFERENT extension for the same base key yields a DIFFERENT key', () => {
    const jpgKey = deterministicKey('evidence', 'order-1-user', 'jpg');
    const pngKey = deterministicKey('evidence', 'order-1-user', 'png');
    expect(jpgKey).not.toBe(pngKey);
  });

  it('different base keys never collide with each other', () => {
    const userKey = deterministicKey('evidence', 'order-1-user', 'jpg');
    const lpKey = deterministicKey('evidence', 'order-1-lp', 'jpg');
    expect(userKey).not.toBe(lpKey);
  });
});
