const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const prisma = require('../models');
const { JWT_SECRET } = require('../middleware/auth');

const ACCESS_EXPIRES = process.env.JWT_ACCESS_EXPIRES || '15m';
const REFRESH_DAYS = parseInt(process.env.JWT_REFRESH_EXPIRES_DAYS || '7', 10);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function signAccessToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: ACCESS_EXPIRES });
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function issueRefreshToken(owner) {
  // owner: { user_id } or { station_user_id }
  const token = crypto.randomBytes(48).toString('hex');
  const expires_at = new Date(Date.now() + REFRESH_DAYS * 24 * 60 * 60 * 1000);
  await prisma.refreshToken.create({
    data: { token_hash: hashToken(token), expires_at, ...owner },
  });
  return token;
}

async function registerCustomer({ full_name, email, password, phone }) {
  if (!full_name || !email || !password) {
    throw new HttpError(400, 'full_name, email and password are required');
  }
  if (password.length < 8) {
    throw new HttpError(400, 'Password must be at least 8 characters');
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    throw new HttpError(409, 'An account with this email already exists');
  }

  const password_hash = await bcrypt.hash(password, 10);
  const user = await prisma.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: { full_name, email, phone: phone || null, password_hash },
    });
    await tx.wallet.create({ data: { user_id: created.id } });
    return created;
  });

  const accessToken = signAccessToken({ sub: user.id, role: 'customer', type: 'customer' });
  const refreshToken = await issueRefreshToken({ user_id: user.id });

  return {
    user: { id: user.id, full_name: user.full_name, email: user.email, role: 'customer' },
    accessToken,
    refreshToken,
  };
}

async function login({ email, password }) {
  if (!email || !password) {
    throw new HttpError(400, 'email and password are required');
  }

  // Customers sign in with email; station staff sign in with username.
  const user = await prisma.user.findUnique({ where: { email } });
  if (user && (await bcrypt.compare(password, user.password_hash))) {
    if (user.status !== 'ACTIVE') throw new HttpError(403, 'Account is not active');
    await prisma.user.update({ where: { id: user.id }, data: { last_login: new Date() } });
    return {
      accessToken: signAccessToken({ sub: user.id, role: 'customer', type: 'customer' }),
      refreshToken: await issueRefreshToken({ user_id: user.id }),
      user: { id: user.id, full_name: user.full_name, email: user.email, role: 'customer' },
    };
  }

  const staff = await prisma.stationUser.findUnique({ where: { username: email } });
  if (staff && (await bcrypt.compare(password, staff.password_hash))) {
    if (staff.status !== 'ACTIVE') throw new HttpError(403, 'Account is not active');
    await prisma.stationUser.update({
      where: { id: staff.id },
      data: { last_login: new Date() },
    });
    const role = staff.role === 'ADMIN' ? 'admin' : 'staff';
    return {
      accessToken: signAccessToken({
        sub: staff.id,
        role,
        type: 'staff',
        station_id: staff.station_id,
        name: staff.full_name,
      }),
      refreshToken: await issueRefreshToken({ station_user_id: staff.id }),
      user: {
        id: staff.id,
        full_name: staff.full_name,
        username: staff.username,
        role,
        station_id: staff.station_id,
      },
    };
  }

  throw new HttpError(401, 'Invalid credentials');
}

async function refresh(refreshToken) {
  if (!refreshToken) {
    throw new HttpError(400, 'refreshToken is required');
  }

  const row = await prisma.refreshToken.findUnique({
    where: { token_hash: hashToken(refreshToken) },
    include: { user: true, stationUser: true },
  });
  if (!row || row.revoked_at || row.expires_at < new Date()) {
    throw new HttpError(401, 'Invalid or expired refresh token');
  }

  // Rotate: revoke the used token, issue a fresh pair.
  await prisma.refreshToken.update({
    where: { id: row.id },
    data: { revoked_at: new Date() },
  });

  if (row.user) {
    const user = row.user;
    return {
      accessToken: signAccessToken({ sub: user.id, role: 'customer', type: 'customer' }),
      refreshToken: await issueRefreshToken({ user_id: user.id }),
      user: { id: user.id, full_name: user.full_name, email: user.email, role: 'customer' },
    };
  }

  const staff = row.stationUser;
  const role = staff.role === 'ADMIN' ? 'admin' : 'staff';
  return {
    accessToken: signAccessToken({
      sub: staff.id,
      role,
      type: 'staff',
      station_id: staff.station_id,
      name: staff.full_name,
    }),
    refreshToken: await issueRefreshToken({ station_user_id: staff.id }),
    user: {
      id: staff.id,
      full_name: staff.full_name,
      username: staff.username,
      role,
      station_id: staff.station_id,
    },
  };
}

async function logout(refreshToken) {
  if (!refreshToken) {
    throw new HttpError(400, 'refreshToken is required');
  }
  await prisma.refreshToken.updateMany({
    where: { token_hash: hashToken(refreshToken), revoked_at: null },
    data: { revoked_at: new Date() },
  });
  return { message: 'Logged out' };
}

module.exports = { registerCustomer, login, refresh, logout, HttpError };
