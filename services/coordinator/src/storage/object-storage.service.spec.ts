import { Logger, NotFoundException } from '@nestjs/common';

const mockBucketExists = jest.fn();
const mockMakeBucket = jest.fn();
const mockPutObject = jest.fn();
const mockGetObject = jest.fn();
const mockStatObject = jest.fn();
const mockRemoveObject = jest.fn();
let lastClientOptions: Record<string, unknown> | undefined;

jest.mock('minio', () => ({
  Client: jest.fn().mockImplementation((opts: Record<string, unknown>) => {
    lastClientOptions = opts;
    return {
      bucketExists: mockBucketExists,
      makeBucket: mockMakeBucket,
      putObject: mockPutObject,
      getObject: mockGetObject,
      statObject: mockStatObject,
      removeObject: mockRemoveObject,
    };
  }),
}));

// eslint-disable-next-line import/first -- must come after jest.mock('minio')
import { ObjectStorageService } from './object-storage.service';
// eslint-disable-next-line import/first
import { AppConfigService } from '../config/app-config.service';

const CANARY_VALUE = 'unit-test-canary-do-not-log-0123456789';

function makeCfg(overrides: Partial<Record<string, unknown>> = {}): AppConfigService {
  return {
    minioEndpoint: 'minio',
    minioPort: 9000,
    minioUseSSL: false,
    minioAccessKey: 'ACCESSKEY',
    minioSecretKey: CANARY_VALUE,
    minioBucket: 'lolipay-uploads',
    ...overrides,
  } as unknown as AppConfigService;
}

describe('ObjectStorageService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    lastClientOptions = undefined;
  });

  it('constructs the minio Client from AppConfigService (endpoint/port/useSSL/keys)', () => {
    // eslint-disable-next-line no-new
    new ObjectStorageService(makeCfg());
    expect(lastClientOptions).toEqual({
      endPoint: 'minio',
      port: 9000,
      useSSL: false,
      accessKey: 'ACCESSKEY',
      secretKey: CANARY_VALUE,
    });
  });

  describe('ensureBucket', () => {
    it('creates the bucket when bucketExists reports false', async () => {
      mockBucketExists.mockResolvedValue(false);
      mockMakeBucket.mockResolvedValue(undefined);
      const svc = new ObjectStorageService(makeCfg());
      await svc.ensureBucket();
      expect(mockBucketExists).toHaveBeenCalledWith('lolipay-uploads');
      expect(mockMakeBucket).toHaveBeenCalledWith('lolipay-uploads');
    });

    it('does NOT call makeBucket when the bucket already exists', async () => {
      mockBucketExists.mockResolvedValue(true);
      const svc = new ObjectStorageService(makeCfg());
      await svc.ensureBucket();
      expect(mockMakeBucket).not.toHaveBeenCalled();
    });

    it('FAIL-CLOSED: rethrows (never swallows) when MinIO is unreachable', async () => {
      mockBucketExists.mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:9000'));
      const svc = new ObjectStorageService(makeCfg());
      await expect(svc.ensureBucket()).rejects.toThrow('ECONNREFUSED');
    });

    it('FAIL-CLOSED: rethrows when makeBucket itself fails', async () => {
      mockBucketExists.mockResolvedValue(false);
      mockMakeBucket.mockRejectedValue(new Error('AccessDenied'));
      const svc = new ObjectStorageService(makeCfg());
      await expect(svc.ensureBucket()).rejects.toThrow('AccessDenied');
    });

    it('never logs the configured credential value, even on failure', async () => {
      const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      mockBucketExists.mockRejectedValue(new Error('boom'));
      const svc = new ObjectStorageService(makeCfg());
      await expect(svc.ensureBucket()).rejects.toThrow();
      const loggedText = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(loggedText).not.toContain(CANARY_VALUE);
      errorSpy.mockRestore();
    });
  });

  describe('putObject', () => {
    it('writes the buffer under the given key with the declared Content-Type', async () => {
      mockPutObject.mockResolvedValue({ etag: 'x' });
      const svc = new ObjectStorageService(makeCfg());
      const buf = Buffer.from('hello world');
      await svc.putObject('proofs/uuid.jpg', buf, 'image/jpeg');
      expect(mockPutObject).toHaveBeenCalledWith('lolipay-uploads', 'proofs/uuid.jpg', buf, buf.length, {
        'Content-Type': 'image/jpeg',
      });
    });
  });

  describe('getObjectStream', () => {
    it('returns the stream from minio on success', async () => {
      const fakeStream = { pipe: jest.fn() };
      mockGetObject.mockResolvedValue(fakeStream);
      const svc = new ObjectStorageService(makeCfg());
      const result = await svc.getObjectStream('proofs/uuid.jpg');
      expect(result).toBe(fakeStream);
      expect(mockGetObject).toHaveBeenCalledWith('lolipay-uploads', 'proofs/uuid.jpg');
    });

    it('maps a NoSuchKey error to NotFoundException (never leaks the raw S3 error)', async () => {
      const err: any = new Error('The specified key does not exist.');
      err.code = 'NoSuchKey';
      mockGetObject.mockRejectedValue(err);
      const svc = new ObjectStorageService(makeCfg());
      await expect(svc.getObjectStream('proofs/missing.jpg')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('maps a NotFound (HEAD-style, no body) error code to NotFoundException too', async () => {
      const err: any = new Error('Not Found');
      err.code = 'NotFound';
      mockGetObject.mockRejectedValue(err);
      const svc = new ObjectStorageService(makeCfg());
      await expect(svc.getObjectStream('proofs/missing.jpg')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rethrows a non-NotFound error unchanged (e.g. a real connectivity failure)', async () => {
      const err: any = new Error('ECONNREFUSED');
      err.code = 'ECONNREFUSED';
      mockGetObject.mockRejectedValue(err);
      const svc = new ObjectStorageService(makeCfg());
      await expect(svc.getObjectStream('proofs/x.jpg')).rejects.toBe(err);
    });
  });

  describe('statObject', () => {
    it('resolves true when the object exists', async () => {
      mockStatObject.mockResolvedValue({ size: 10 });
      const svc = new ObjectStorageService(makeCfg());
      await expect(svc.statObject('evidence/order-1-user.jpg')).resolves.toBe(true);
    });

    it('resolves false (does NOT throw) when the object is missing', async () => {
      const err: any = new Error('Not Found');
      err.code = 'NotFound';
      mockStatObject.mockRejectedValue(err);
      const svc = new ObjectStorageService(makeCfg());
      await expect(svc.statObject('evidence/missing.jpg')).resolves.toBe(false);
    });

    it('rethrows a genuine (non-NotFound) error rather than reporting false', async () => {
      const err: any = new Error('InternalError');
      err.code = 'InternalError';
      mockStatObject.mockRejectedValue(err);
      const svc = new ObjectStorageService(makeCfg());
      await expect(svc.statObject('evidence/x.jpg')).rejects.toBe(err);
    });
  });

  describe('removeObject', () => {
    it('removes an existing object', async () => {
      mockRemoveObject.mockResolvedValue(undefined);
      const svc = new ObjectStorageService(makeCfg());
      await svc.removeObject('proofs/uuid.jpg');
      expect(mockRemoveObject).toHaveBeenCalledWith('lolipay-uploads', 'proofs/uuid.jpg');
    });

    it('is a no-op (never throws) when the key does not exist', async () => {
      const err: any = new Error('The specified key does not exist.');
      err.code = 'NoSuchKey';
      mockRemoveObject.mockRejectedValue(err);
      const svc = new ObjectStorageService(makeCfg());
      await expect(svc.removeObject('proofs/missing.jpg')).resolves.toBeUndefined();
    });

    it('is best-effort — swallows even a non-NotFound removal error rather than failing the caller', async () => {
      mockRemoveObject.mockRejectedValue(new Error('transient network blip'));
      const svc = new ObjectStorageService(makeCfg());
      await expect(svc.removeObject('proofs/x.jpg')).resolves.toBeUndefined();
    });
  });
});
