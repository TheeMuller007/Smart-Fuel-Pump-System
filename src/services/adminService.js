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

// ---- Stage 12: system administration & auditing ---------------------------

async function listUsers({ page = 1, limit = 20, q = '', status = '' } = {}) {
  const where = {};
  if (status) where.status = status;
  if (q) {
    where.OR = [
      { full_name: { contains: q, mode: 'insensitive' } },
      { email: { contains: q, mode: 'insensitive' } },
      { phone: { contains: q } },
    ];
  }
  const take = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
  const skip = (Math.max(parseInt(page, 10) || 1, 1) - 1) * take;
  const [items, total] = await Promise.all([
    prisma.user.findMany({
      where,
      orderBy: { created_at: 'desc' },
      skip,
      take,
      select: {
        id: true,
        full_name: true,
        email: true,
        phone: true,
        status: true,
        created_at: true,
        last_login: true,
        wallet: { select: { available_balance: true, reserved_balance: true, currency: true } },
      },
    }),
    prisma.user.count({ where }),
  ]);
  return { items, total, page: Math.max(parseInt(page, 10) || 1, 1), total_pages: Math.max(Math.ceil(total / take), 1) };
}

async function setUserStatus(userId, status) {
  if (!['ACTIVE', 'BLOCKED'].includes(status)) {
    throw new AdminError(400, 'status must be ACTIVE or BLOCKED');
  }
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AdminError(404, 'User not found');

  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.user.update({ where: { id: userId }, data: { status } });
    // Blocking revokes every live refresh token so sessions end immediately.
    if (status === 'BLOCKED') {
      await tx.refreshToken.updateMany({
        where: { user_id: userId, revoked_at: null },
        data: { revoked_at: new Date() },
      });
    }
    return u;
  });
  return { id: updated.id, full_name: updated.full_name, status: updated.status };
}

async function listStations() {
  return prisma.station.findMany({
    orderBy: { created_at: 'asc' },
    include: { _count: { select: { pumps: true, stationUsers: true } } },
  });
}

async function createStation({ name, location } = {}) {
  if (!name || !name.trim()) throw new AdminError(400, 'name is required');
  return prisma.station.create({ data: { name: name.trim(), location: (location || '').trim() } });
}

async function updateStation(id, data = {}) {
  const station = await prisma.station.findUnique({ where: { id } });
  if (!station) throw new AdminError(404, 'Station not found');
  const updates = {};
  if (data.name !== undefined) {
    if (!String(data.name).trim()) throw new AdminError(400, 'name cannot be empty');
    updates.name = String(data.name).trim();
  }
  if (data.location !== undefined) updates.location = String(data.location).trim();
  if (data.status !== undefined) {
    if (!['ACTIVE', 'INACTIVE'].includes(data.status)) {
      throw new AdminError(400, 'status must be ACTIVE or INACTIVE');
    }
    updates.status = data.status;
  }
  return prisma.station.update({ where: { id }, data: updates });
}

async function listPumps(stationId) {
  const where = stationId ? { station_id: stationId } : {};
  return prisma.pump.findMany({
    where,
    orderBy: [{ station_id: 'asc' }, { pump_number: 'asc' }],
    include: { station: { select: { name: true } }, fuel_type: { select: { name: true, price_per_litre: true } } },
  });
}

async function createPump({ station_id, pump_number, fuel_type_id, controller_id } = {}) {
  if (!station_id || !fuel_type_id) throw new AdminError(400, 'station_id and fuel_type_id are required');
  const num = parseInt(pump_number, 10);
  if (!Number.isFinite(num) || num <= 0) throw new AdminError(400, 'pump_number must be a positive integer');

  const station = await prisma.station.findUnique({ where: { id: station_id } });
  if (!station) throw new AdminError(404, 'Station not found');
  const fuelType = await prisma.fuelType.findUnique({ where: { id: fuel_type_id } });
  if (!fuelType) throw new AdminError(404, 'Fuel type not found');

  const clash = await prisma.pump.findUnique({
    where: { station_id_pump_number: { station_id, pump_number: num } },
  });
  if (clash) throw new AdminError(409, `Pump #${num} already exists at this station`);

  return prisma.pump.create({
    data: { station_id, pump_number: num, fuel_type_id, controller_id: controller_id || null },
  });
}

async function updatePump(id, data = {}) {
  const pump = await prisma.pump.findUnique({ where: { id } });
  if (!pump) throw new AdminError(404, 'Pump not found');
  const updates = {};
  if (data.fuel_type_id !== undefined) {
    const fuelType = await prisma.fuelType.findUnique({ where: { id: data.fuel_type_id } });
    if (!fuelType) throw new AdminError(404, 'Fuel type not found');
    updates.fuel_type_id = data.fuel_type_id;
  }
  if (data.controller_id !== undefined) updates.controller_id = String(data.controller_id).trim() || null;
  if (data.status !== undefined) {
    if (!['AVAILABLE', 'RESERVED', 'BUSY', 'OFFLINE', 'MAINTENANCE'].includes(data.status)) {
      throw new AdminError(400, 'status must be AVAILABLE, RESERVED, BUSY, OFFLINE or MAINTENANCE');
    }
    updates.status = data.status;
  }
  return prisma.pump.update({ where: { id }, data: updates });
}

async function deletePump(id) {
  const pump = await prisma.pump.findUnique({ where: { id } });
  if (!pump) throw new AdminError(404, 'Pump not found');

  const [requestCount, txnCount] = await Promise.all([
    prisma.fuelRequest.count({ where: { pump_id: id } }),
    prisma.fuelTransaction.count({ where: { pump_id: id } }),
  ]);
  if (requestCount > 0 || txnCount > 0) {
    await prisma.pump.update({ where: { id }, data: { status: 'OFFLINE' } });
    return { deleted: false, deactivated: true, message: 'Pump has history; it was set OFFLINE instead of deleted' };
  }
  await prisma.pump.delete({ where: { id } });
  return { deleted: true, deactivated: false };
}

async function listStationUsers(stationId) {
  const where = stationId ? { station_id: stationId } : {};
  return prisma.stationUser.findMany({
    where,
    orderBy: { created_at: 'asc' },
    include: { station: { select: { name: true } } },
  });
}

async function createStationUser({ station_id, username, password, full_name, role } = {}) {
  if (!station_id || !username || !password || !full_name || !role) {
    throw new AdminError(400, 'station_id, username, password, full_name and role are required');
  }
  if (!['ATTENDANT', 'MANAGER', 'ADMIN'].includes(role)) {
    throw new AdminError(400, 'role must be ATTENDANT, MANAGER or ADMIN');
  }
  if (String(password).length < 8) {
    throw new AdminError(400, 'Password must be at least 8 characters');
  }
  const station = await prisma.station.findUnique({ where: { id: station_id } });
  if (!station) throw new AdminError(404, 'Station not found');

  const bcrypt = require('bcrypt');
  const clash = await prisma.stationUser.findUnique({ where: { username: String(username).trim() } });
  if (clash) throw new AdminError(409, `Username "${username}" already exists`);

  const password_hash = await bcrypt.hash(String(password), 10);
  return prisma.stationUser.create({
    data: {
      station_id,
      username: String(username).trim(),
      password_hash,
      full_name: String(full_name).trim(),
      role,
    },
  });
}

async function updateStationUser(id, data = {}) {
  const su = await prisma.stationUser.findUnique({ where: { id } });
  if (!su) throw new AdminError(404, 'Staff account not found');
  const updates = {};
  if (data.full_name !== undefined) {
    if (!String(data.full_name).trim()) throw new AdminError(400, 'full_name cannot be empty');
    updates.full_name = String(data.full_name).trim();
  }
  if (data.role !== undefined) {
    if (!['ATTENDANT', 'MANAGER', 'ADMIN'].includes(data.role)) {
      throw new AdminError(400, 'role must be ATTENDANT, MANAGER or ADMIN');
    }
    updates.role = data.role;
  }
  if (data.status !== undefined) {
    if (!['ACTIVE', 'BLOCKED'].includes(data.status)) {
      throw new AdminError(400, 'status must be ACTIVE or BLOCKED');
    }
    updates.status = data.status;
  }
  if (data.password !== undefined) {
    if (String(data.password).length < 8) {
      throw new AdminError(400, 'Password must be at least 8 characters');
    }
    const bcrypt = require('bcrypt');
    updates.password_hash = await bcrypt.hash(String(data.password), 10);
  }
  const updated = await prisma.stationUser.update({ where: { id }, data: updates });
  if (updates.status === 'BLOCKED' || updates.password_hash) {
    await prisma.refreshToken.updateMany({
      where: { station_user_id: id, revoked_at: null },
      data: { revoked_at: new Date() },
    });
  }
  return { id: updated.id, username: updated.username, full_name: updated.full_name, role: updated.role, status: updated.status };
}

async function listAuditLogs({ page = 1, limit = 25, action = '', entity_type = '', user_id = '', station_id = '', from = '', to = '' } = {}) {
  const where = {};
  if (action) where.action = { contains: action.toUpperCase() };
  if (entity_type) where.entity_type = entity_type.toUpperCase();
  if (user_id) where.OR = [{ user_id }, { station_user_id: user_id }];
  if (station_id) where.station_id = station_id;
  if (from || to) {
    where.created_at = {};
    if (from) where.created_at.gte = new Date(from);
    if (to) where.created_at.lte = new Date(to);
  }

  const take = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 100);
  const pageNum = Math.max(parseInt(page, 10) || 1, 1);
  const [items, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      orderBy: { created_at: 'desc' },
      skip: (pageNum - 1) * take,
      take,
      include: {
        user: { select: { full_name: true, email: true } },
        stationUser: { select: { full_name: true, username: true } },
        station: { select: { name: true } },
      },
    }),
    prisma.auditLog.count({ where }),
  ]);
  return { items, total, page: pageNum, total_pages: Math.max(Math.ceil(total / take), 1) };
}

/** Dashboard cards: sales, active pumps, recent audit entries. */
async function getDashboard() {
  const [totalSales, txnCount, activePumps, customerCount, stationCount, recentLogs] = await Promise.all([
    prisma.fuelTransaction.aggregate({ _sum: { final_amount: true }, where: { status: 'COMPLETED' } }),
    prisma.fuelTransaction.count({ where: { status: 'COMPLETED' } }),
    prisma.pump.count({ where: { status: { in: ['AVAILABLE', 'RESERVED', 'BUSY'] } } }),
    prisma.user.count(),
    prisma.station.count({ where: { status: 'ACTIVE' } }),
    prisma.auditLog.findMany({ orderBy: { created_at: 'desc' }, take: 8, include: { station: { select: { name: true } } } }),
  ]);
  return {
    total_sales: totalSales._sum.final_amount || 0,
    completed_transactions: txnCount,
    active_pumps: activePumps,
    customers: customerCount,
    active_stations: stationCount,
    recent_audit: recentLogs,
  };
}

module.exports = {
  listFuelTypes,
  createFuelType,
  updateFuelType,
  deleteFuelType,
  listUsers,
  setUserStatus,
  listStations,
  createStation,
  updateStation,
  listPumps,
  createPump,
  updatePump,
  deletePump,
  listStationUsers,
  createStationUser,
  updateStationUser,
  listAuditLogs,
  getDashboard,
  AdminError,
};
