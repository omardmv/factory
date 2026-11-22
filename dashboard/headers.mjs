// Headers for every dashboard response. The dashboard has forms that act (stop, redeploy, new task) and its session
// cookie covers the whole parent domain, so a page on a sibling subdomain (a preview running agent-written code) is
// same-site and could frame it for clickjacking. Nothing here is meant to be framed.
export const SECURITY_HEADERS = {
  'x-frame-options': 'DENY',
  'content-security-policy': "frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
};
