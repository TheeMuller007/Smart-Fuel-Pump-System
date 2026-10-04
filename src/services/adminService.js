const { Prisma } = require('@prisma/client');
const prisma = require('../models');

class AdminError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function listFuelTypes(includeInactive = false) {
  return prisma.fuelType.findMany({
    where: includeInactive ? {} : { status: 'ACTIVE' },
    orderBy: { name: 'asc' },
  });
}

async function createFuelType({ name, price_per_litre, currency } = {}) {
  if (!name || name.trim().length === 0) {
    throw new AdminError(400, 'name is required');
  }
  const price = new Prisma.Decimal(price_per_litre ?? 0);
  if (price.lte(0)) {
    throw new AdminError(400, 'price_per_litre must be greater than zero');
  }

  const existing = await prisma.fuelType.findUnique({ where: { name: name.trim() } });
  if (existing) {
    throw new AdminError(409, `Fuel type "${name.trim()}" already exists`);
  }

  return prisma.fuelType.create({
    data: {
      name: name.trim(),
      price_per_litre: price.toFixed(3),
      currency: currency || 'USD',
    },
  });
}

async function updateFuelType(id, data = {}) {
  const existing = await prisma.fuelType.findUnique({ where: { id } });
  if (!existing) throw new AdminError(404, 'Fuel type not found');

  const updates = {};
  if (data.name !== undefined) {
    const name = String(data.name).trim();
    if (!name) throw new AdminError(400, 'name cannot be empty');
    const clash = await prisma.fuelType.findUnique({ where: { name } });
    if (clash && clash.id !== id) {
      throw new AdminError(409, `Fuel type "${name}" already exists`);
    }
    updates.name = name;
  }
  if (data.price_per_litre !== undefined) {
    const price = new Prisma.Decimal(data.price_per_litre);
    if (price.lte(0)) {
      throw new AdminError(400, 'price_per_litre must be greater than zero');
    }
    updates.price_per_litre = price.toFixed(3);
  }
  if (data.currency !== undefined) updates.currency = String(data.currency).toUpperCase().slice(0, 10);
  if (data.status !== undefined) {
    if (!['ACTIVE', 'INACTIVE'].includes(data.status)) {
      throw new AdminError(400, 'status must be ACTIVE or INACTIVE');
    }
    updates.status = data.status;
  }

  return prisma.fuelType.update({ where: { id }, data: updates });
}

/**
 * Delete a fuel type. If it is referenced by pumps or requests it is
 * deactivated instead (referential integrity), otherwise removed outright.
 */
async function deleteFuelType(id) {
  const existing = await prisma.fuelType.findUnique({ where: { id } });
  if (!existing) throw new AdminError(404, 'Fuel type not found');

  const [pumpCount, requestCount] = await prisma.$transaction([
    prisma.pump.count({ where: { fuel_type_id: id } }),
    prisma.fuelRequest.count({ where: { fuel_type_id: id } }),
  ]);

  if (pumpCount === 0 && requestCount === 0) {
    await prisma.fuelType.delete({ where: { id } });
    return { deleted: true, deactivated: false };
  }

  await prisma.fuelType.update({ where: { id }, data: { status: 'INACTIVE' } });
  return {
    deleted: false,
    deactivated: true,
    message: 'Fuel type is in use; it was deactivated instead of deleted',
  };
}

module.exports = { listFuelTypes, createFuelType, updateFuelType, deleteFuelType, AdminError };
