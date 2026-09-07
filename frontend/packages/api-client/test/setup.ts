globalThis.fetch = (() => Promise.reject(new Error('unmocked fetch in a test — mock the endpoint'))) as unknown as typeof fetch
