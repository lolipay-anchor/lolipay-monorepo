import { checkAnchorIdentity } from '../anchor/consistency';

const domain = process.argv[2];

async function main(): Promise<void> {
  if (!domain) {
    console.error('usage: anchor-consistency <home-domain>');
    process.exit(2);
  }

  const problems = await checkAnchorIdentity(domain);

  if (problems.length === 0) {
    console.log(`${domain}: the toml and the live challenge agree`);
    return;
  }
  problems.forEach((p) => console.error(`${domain}: ${p}`));
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(`${domain}: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
