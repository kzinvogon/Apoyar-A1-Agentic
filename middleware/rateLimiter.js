const rateLimit = require('express-rate-limit');

/**
 * Rate Limiting Middleware Configuration
 *
 * Protects the application from:
 * - Brute force attacks
 * - DDoS attacks
 * - API abuse
 * - Resource exhaustion
 */

/**
 * Custom handler for rate limit exceeded
 */
const rateLimitHandler = (req, res) => {
  res.status(429).json({
    success: false,
    message: 'Too many requests. Please try again later.',
    error: 'RATE_LIMIT_EXCEEDED',
    retryAfter: Math.ceil(req.rateLimit.resetTime / 1000)
  });
};

/**
 * Skip rate limiting for successful requests to avoid penalizing legitimate users
 * Only count failed/suspicious attempts for auth endpoints
 */
const skipSuccessfulRequests = (req, res) => {
  // Only skip if response was successful (2xx status)
  return res.statusCode < 400;
};

/**
 * CRITICAL: Strict rate limiting for authentication endpoints
 * Prevents brute force password attacks
 *
 * Limit: 20 attempts per 15 minutes per IP (relaxed for development)
 */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // 20 requests per window (increased for development)
  message: {
    success: false,
    message: 'Too many login attempts. Please try again in 15 minutes.',
    error: 'LOGIN_RATE_LIMIT_EXCEEDED'
  },
  standardHeaders: true, // Return rate limit info in `RateLimit-*` headers
  legacyHeaders: false, // Disable `X-RateLimit-*` headers
  handler: rateLimitHandler,
  // Skip successful logins from the count
  skipSuccessfulRequests: true
});

/**
 * STRICT: Password change rate limiting
 * Prevents automated password change attacks
 *
 * Limit: 3 attempts per hour per IP
 */
const passwordChangeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3, // 3 requests per window
  message: {
    success: false,
    message: 'Too many password change attempts. Please try again in 1 hour.',
    error: 'PASSWORD_CHANGE_RATE_LIMIT_EXCEEDED'
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
  skipSuccessfulRequests: true
});

/**
 * MODERATE: Write operations rate limiting
 * Prevents spam and abuse of create/update operations
 *
 * Limit: 30 requests per 15 minutes per IP
 * Applies to: ticket creation, CMDB modifications, etc.
 */
const writeOperationsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30, // 30 requests per window
  message: {
    success: false,
    message: 'Too many write operations. Please try again later.',
    error: 'WRITE_RATE_LIMIT_EXCEEDED'
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler
});

/**
 * MODERATE: Email operations rate limiting
 * Prevents email bombing and spam
 *
 * Limit: 10 emails per hour per IP
 */
const emailLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10, // 10 requests per window
  message: {
    success: false,
    message: 'Too many email requests. Please try again in 1 hour.',
    error: 'EMAIL_RATE_LIMIT_EXCEEDED'
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler
});

/**
 * LENIENT: Read operations rate limiting
 * Prevents excessive database queries but allows normal usage
 *
 * Limit: 1000 requests per 15 minutes per IP (increased for development)
 * Applies to: listing tickets, viewing CMDB items, etc.
 */
const readOperationsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // 1000 requests per window (increased for development)
  message: {
    success: false,
    message: 'Too many requests. Please slow down.',
    error: 'READ_RATE_LIMIT_EXCEEDED'
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler
});

/**
 * STRICT: Master admin operations rate limiting
 * Protects sensitive administrative operations
 *
 * Limit: 20 requests per 15 minutes per IP
 */
const masterAdminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // 20 requests per window
  message: {
    success: false,
    message: 'Too many administrative operations. Please try again later.',
    error: 'ADMIN_RATE_LIMIT_EXCEEDED'
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler
});

/**
 * GENERAL: Global API rate limiting
 * Catch-all protection for all endpoints
 *
 * Limit: 2000 requests per 15 minutes per IP (increased for development)
 * This is a safety net for any endpoints not specifically rate limited
 */
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 2000, // 2000 requests per window (increased for development)
  message: {
    success: false,
    message: 'Too many API requests. Please slow down.',
    error: 'API_RATE_LIMIT_EXCEEDED'
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
  // Skip OPTIONS requests (CORS preflight)
  skip: (req) => req.method === 'OPTIONS'
});

/**
 * STRICT: Account enumeration protection
 * Prevents attackers from discovering valid usernames/emails
 *
 * Limit: 10 requests per 15 minutes per IP
 */
const accountEnumerationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 requests per window
  message: {
    success: false,
    message: 'Too many requests. Please try again later.',
    error: 'ENUMERATION_RATE_LIMIT_EXCEEDED'
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler
});

/**
 * Export all rate limiters
 */
module.exports = {
  loginLimiter,
  passwordChangeLimiter,
  writeOperationsLimiter,
  emailLimiter,
  readOperationsLimiter,
  masterAdminLimiter,
  apiLimiter,
  accountEnumerationLimiter
};
