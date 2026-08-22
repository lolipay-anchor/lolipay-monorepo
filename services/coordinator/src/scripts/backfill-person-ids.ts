import { PrismaService } from '../prisma/prisma.service';
import { PersonService } from '../person/person.service';

async function main(): Promise<void> {
  const prisma = new PrismaService();
  await prisma.$connect();
  const people = new PersonService(prisma);

  const pending = await prisma.$queryRaw<{ userAddress: string }[]>`
    SELECT DISTINCT "userAddress" FROM "Order" WHERE "personId" IS NULL
  `;

  let stamped = 0;
  for (const { userAddress } of pending) {
    const person = await people.ensureForAddress(userAddress, 'SEP53');
    const updated = await prisma.$executeRaw`
      UPDATE "Order" SET "personId" = ${person.id}
      WHERE "userAddress" = ${userAddress} AND "personId" IS NULL
    `;
    stamped += updated;
    console.log(`${userAddress} -> ${person.id} (${updated} order(s))`);
  }

  const [{ remaining }] = await prisma.$queryRaw<{ remaining: bigint }[]>`
    SELECT count(*)::bigint AS remaining FROM "Order" WHERE "personId" IS NULL
  `;
  console.log(
    `addresses=${pending.length} orders_stamped=${stamped} remaining_null=${remaining}`,
  );
  await prisma.$disconnect();
  if (remaining > 0n) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
