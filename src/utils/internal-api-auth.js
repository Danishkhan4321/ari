function normalizeAddress(address) {
  return String(address || '').trim().toLowerCase().replace(/^::ffff:/, '');
}

function isLoopbackAddress(address) {
  const ip = normalizeAddress(address);
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost';
}

function isPrivateAddress(address) {
  const ip = normalizeAddress(address);
  if (/^10\./.test(ip) || /^192\.168\./.test(ip)) return true;

  const match = ip.match(/^172\.(\d{1,3})\./);
  if (match) {
    const secondOctet = Number(match[1]);
    return secondOctet >= 16 && secondOctet <= 31;
  }

  return ip.startsWith('fc') || ip.startsWith('fd');
}

function isAllowedInternalAddress(address, options = {}) {
  if (options.allowPublic) return true;
  if (isLoopbackAddress(address)) return true;
  return options.allowPrivate === true && isPrivateAddress(address);
}

module.exports = {
  isAllowedInternalAddress,
  isLoopbackAddress,
  isPrivateAddress,
};
