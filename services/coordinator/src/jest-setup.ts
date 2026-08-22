process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://lolipay:lolipay@localhost:5432/lolipay?schema=public';
process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'test-jwt-secret-unit-0123456789abcdef';
process.env.JWT_TTL_SECONDS = process.env.JWT_TTL_SECONDS || '900';
process.env.AUTH_CHALLENGE_TTL_SECONDS =
  process.env.AUTH_CHALLENGE_TTL_SECONDS || '120';
process.env.ADMIN_ADDRESSES = process.env.ADMIN_ADDRESSES || '';
process.env.STELLAR_RPC_URL =
  process.env.STELLAR_RPC_URL || 'https://soroban-testnet.stellar.org';
process.env.STELLAR_NETWORK_PASSPHRASE =
  process.env.STELLAR_NETWORK_PASSPHRASE ||
  'Test SDF Network ; September 2015';
process.env.STAKING_CONTRACT_ID =
  process.env.STAKING_CONTRACT_ID || 'placeholder';
process.env.ESCROW_CONTRACT_ID =
  process.env.ESCROW_CONTRACT_ID || 'placeholder';
process.env.PRICE_STALE_SECONDS = process.env.PRICE_STALE_SECONDS || '120';
process.env.PRICE_DEVIATION_MAX_BPS =
  process.env.PRICE_DEVIATION_MAX_BPS || '100';
process.env.PLATFORM_WALLET =
  process.env.PLATFORM_WALLET ||
  'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

process.env.MINIO_ENDPOINT = process.env.MINIO_ENDPOINT || 'localhost';
process.env.MINIO_PORT = process.env.MINIO_PORT || '9000';
process.env.MINIO_USE_SSL = process.env.MINIO_USE_SSL || 'false';
process.env.MINIO_ACCESS_KEY = process.env.MINIO_ACCESS_KEY || 'test-access-key';
process.env.MINIO_SECRET_KEY =
  process.env.MINIO_SECRET_KEY || 'test-secret-key-unit-0123456789ab';
process.env.MINIO_BUCKET = process.env.MINIO_BUCKET || 'lolipay-uploads-test';
