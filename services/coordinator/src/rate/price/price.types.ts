export interface PriceAdapter {
  name: string;

  fetchPrices(fiats: string[]): Promise<Record<string, string>>;
}
