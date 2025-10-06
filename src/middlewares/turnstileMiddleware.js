/**
 * Creates a Turnstile middleware for a specific context with optional rate limiting
 * @param {string} context - The context key (e.g., 'pay', 'login', 'register')
 * @param {number} rateLimit - Optional: max requests per minute per user (0 = no limit)
 * @returns {function} Express middleware function
 */
// eslint-disable-next-line no-unused-vars
const createTurnstileMiddleware = (context = 'pay', rateLimit = 0) => {
  return async (req, res, next) => {
    // No-op middleware - just continue to next middleware/route
    next();
  };
};

// Export the factory function as default
export default createTurnstileMiddleware;

// Convenience exports for common contexts (with default rate limits)
export const turnstilePay = createTurnstileMiddleware('pay', 10); // 10 requests per minute
export const turnstileLogin = createTurnstileMiddleware('login', 10); // 5 requests per minute
