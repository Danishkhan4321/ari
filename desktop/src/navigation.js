function classifyUrl(rawUrl, dashboardOrigin) {
  let url;
  let origin;
  try {
    url = new URL(rawUrl);
    origin = new URL(dashboardOrigin).origin;
  } catch {
    return 'blocked';
  }

  if (url.origin === origin) return 'local';
  if (url.protocol === 'http:' || url.protocol === 'https:') return 'external';
  return 'blocked';
}

module.exports = { classifyUrl };
