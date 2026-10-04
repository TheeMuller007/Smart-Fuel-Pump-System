const bcrypt = require('bcrypt');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const fuelTypes = await Promise.all([
    prisma.fuelType.upsert({
      where: { name: 'Petrol' },
      update: {},
      create: { name: 'Petrol', price_per_litre: 1.5 },
    }),
    prisma.fuelType.upsert({
      where: { name: 'Diesel' },
      update: {},
      create: { name: 'Diesel', price_per_litre: 1.35 },
    }),
  ]);
  const [petrol, diesel] = fuelTypes;

  const station = await prisma.station.upsert({
    where: { id: (await prisma.station.findFirst())?.id || 'seed-station' },
    update: {},
    create: { name: 'Downtown Fuel Station', location: '123 Main St' },
  });

  const pumpCount = await prisma.pump.count({ where: { station_id: station.id } });
  if (pumpCount === 0) {
    await prisma.pump.createMany({
      data: [
        { station_id: station.id, pump_number: 1, fuel_type_id: petrol.id },
        { station_id: station.id, pump_number: 2, fuel_type_id: diesel.id },
        { station_id: station.id, pump_number: 3, fuel_type_id: petrol.id },
      ],
    });
  }

  const staffPassword = await bcrypt.hash('admin123', 10);
  const attendantPassword = await bcrypt.hash('attendant123', 10);
  await prisma.stationUser.upsert({
    where: { username: 'admin' },
    update: {},
    create: {
      station_id: station.id,
      username: 'admin',
      password_hash: staffPassword,
      full_name: 'Station Admin',
      role: 'ADMIN',
    },
  });
  await prisma.stationUser.upsert({
    where: { username: 'attendant' },
    update: {},
    create: {
      station_id: station.id,
      username: 'attendant',
      password_hash: attendantPassword,
      full_name: 'Pump Attendant',
      role: 'ATTENDANT',
    },
  });

  const customerPassword = await bcrypt.hash('customer123', 10);
  const customer = await prisma.user.upsert({
    where: { email: 'john@example.com' },
    update: {},
    create: {
      full_name: 'John Doe',
      email: 'john@example.com',
      phone: '+15550100',
      password_hash: customerPassword,
    },
  });

  const wallet = await prisma.wallet.upsert({
    where: { user_id: customer.id },
    update: {},
    create: { user_id: customer.id },
  });

  const hasLedger = await prisma.walletTransaction.count({ where: { wallet_id: wallet.id } });
  if (hasLedger === 0) {
    await prisma.walletTransaction.create({
      data: {
        wallet_id: wallet.id,
        user_id: customer.id,
        type: 'CASH_DEPOSIT',
        amount: 100,
        balance_before: 0,
        balance_after: 100,
        reference: 'DEP-SEED-0001',
        description: 'Initial demo deposit',
      },
    });
    await prisma.wallet.update({
      where: { id: wallet.id },
      data: { available_balance: 100 },
    });
  }

  console.log('Seed complete:');
  console.log('  Station:', station.name);
  console.log('  Customer login: john@example.com / customer123');
  console.log('  Staff login:    admin / admin123');
  console.log('  Staff login:    attendant / attendant123');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
