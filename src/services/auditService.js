const prisma = require('../models');

/**
 * Write an audit log row. Used for staff actions so the acting staff ID and
 * station are always recorded.
 */
async function log({
  userId,
  stationUserId,
  stationId,
  action,
  entityType,
  entityId,
  description,
  ipAddress,
}) {
  return prisma.auditLog.create({
    data: {
      user_id: userId ?? null,
      station_user_id: stationUserId ?? null,
      station_id: stationId ?? null,
      action,
      entity_type: entityType ?? null,
      entity_id: entityId ?? null,
      description: description ?? null,
      ip_address: ipAddress ?? null,
    },
  });
}

module.exports = { log };
