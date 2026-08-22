export const CONFIG_TTL_MS = 5000;

type ConfigWriter = {
  config: {
    upsert: (args: {
      where: { id: number };
      update: Record<string, never>;
      create: { id: number; platformWallet: string };
    }) => Promise<any>;
  };
};

const live = new Set<ConfigCache>();

export class ConfigCache {
  private entry: { row: any; at: number } | null = null;

  constructor() {
    live.add(this);
  }

  async read(prisma: ConfigWriter, platformWallet: string): Promise<any> {
    const now = Date.now();
    if (this.entry && now - this.entry.at < CONFIG_TTL_MS) {
      return this.entry.row;
    }
    const row = await prisma.config.upsert({
      where: { id: 1 },
      update: {},
      create: { id: 1, platformWallet },
    });
    this.entry = { row, at: now };
    return row;
  }

  invalidate(): void {
    this.entry = null;
  }
}

export function invalidateAllConfigCaches(): void {
  for (const cache of live) cache.invalidate();
}
