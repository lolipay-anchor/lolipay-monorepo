import { randomUUID } from 'crypto';

export interface UploadedFileLike {
  buffer: Buffer;
  mimetype: string;
  size: number;
  originalname?: string;
  fieldname?: string;
}

export interface SniffedFile {
  mime: string;
  ext: string;
}

const MAGIC_CHECKS: ReadonlyArray<{ mime: string; ext: string; test: (b: Buffer) => boolean }> = [

  {
    mime: 'image/jpeg',
    ext: 'jpg',
    test: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },

  {
    mime: 'image/png',
    ext: 'png',
    test: (b) =>
      b.length >= 8 &&
      b[0] === 0x89 &&
      b[1] === 0x50 &&
      b[2] === 0x4e &&
      b[3] === 0x47 &&
      b[4] === 0x0d &&
      b[5] === 0x0a &&
      b[6] === 0x1a &&
      b[7] === 0x0a,
  },

  {
    mime: 'image/webp',
    ext: 'webp',
    test: (b) =>
      b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP',
  },

  {
    mime: 'application/pdf',
    ext: 'pdf',
    test: (b) => b.length >= 4 && b.toString('ascii', 0, 4) === '%PDF',
  },
];

export function sniffFileType(buf: Buffer | undefined | null): SniffedFile | null {
  if (!buf || buf.length === 0) return null;
  for (const check of MAGIC_CHECKS) {
    if (check.test(buf)) return { mime: check.mime, ext: check.ext };
  }
  return null;
}

export const EXT_CONTENT_TYPE: Readonly<Record<string, string>> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  pdf: 'application/pdf',
};

export function newProofKey(kind: 'proofs' | 'evidence', ext: string): string {
  return `${kind}/${randomUUID()}.${ext}`;
}

export function deterministicKey(kind: 'proofs' | 'evidence', key: string, ext: string): string {
  return `${kind}/${key}.${ext}`;
}
