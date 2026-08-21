import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  productionBrowserSourceMaps: true,

  env: {
    DISABLE_GLOBAL_CORE: 'true',
  },

  transpilePackages: [
    '@creit.tech/stellar-wallets-kit',
    '@reown/appkit',
    '@reown/appkit-common',
    '@reown/appkit-controllers',
    '@reown/appkit-pay',
    '@reown/appkit-polyfills',
    '@reown/appkit-scaffold-ui',
    '@reown/appkit-ui',
    '@reown/appkit-utils',
    '@reown/appkit-wallet',
    '@walletconnect/core',
    '@walletconnect/environment',
    '@walletconnect/events',
    '@walletconnect/heartbeat',
    '@walletconnect/jsonrpc-http-connection',
    '@walletconnect/jsonrpc-provider',
    '@walletconnect/jsonrpc-types',
    '@walletconnect/jsonrpc-utils',
    '@walletconnect/jsonrpc-ws-connection',
    '@walletconnect/keyvaluestorage',
    '@walletconnect/logger',
    '@walletconnect/relay-api',
    '@walletconnect/relay-auth',
    '@walletconnect/safe-json',
    '@walletconnect/sign-client',
    '@walletconnect/time',
    '@walletconnect/types',
    '@walletconnect/universal-provider',
    '@walletconnect/utils',
    '@walletconnect/window-getters',
    '@walletconnect/window-metadata',
  ],

  async headers() {
    return [
      {
        source: '/((?!_next/static|_next/image).*)',
        headers: [{ key: 'Cache-Control', value: 'no-cache, must-revalidate' }],
      },
    ];
  },
};

export default nextConfig;
