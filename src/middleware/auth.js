const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'supersecret';

function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;

  if (!token) {
    return res.status(401).json({ message: 'Missing bearer token' });
  }

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) {
      const message = err.name === 'TokenExpiredError' ? 'Access token expired' : 'Invalid token';
      return res.status(403).json({ message });
    }
    req.user = decoded; // { sub, role, type, station_id?, name? }
    next();
  });
}

/**
 * authorizeRole('customer') or authorizeRole('staff', 'admin').
 * Token roles are: 'customer', 'staff' (manager/attendant), 'admin'.
 */
function authorizeRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: 'Not authenticated' });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ message: `Requires role: ${roles.join(' or ')}` });
    }
    next();
  };
}

module.exports = { authenticateToken, authorizeRole, JWT_SECRET };
