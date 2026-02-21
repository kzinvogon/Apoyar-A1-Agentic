const { body, param, query, validationResult } = require('express-validator');

/**
 * Middleware to handle validation errors
 * Must be used after validation chains
 */
const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      message: 'Validation failed',
      errors: errors.array().map(err => ({
        field: err.path,
        message: err.msg,
        value: err.value
      }))
    });
  }
  next();
};

// Common validation rules
const validateTenantId = () => {
  return param('tenantId')
    .notEmpty().withMessage('Tenant ID is required')
    .isLength({ min: 1, max: 50 }).withMessage('Tenant ID must be between 1 and 50 characters')
    .matches(/^[a-z0-9_-]+$/i).withMessage('Tenant ID must contain only alphanumeric characters, underscores, and hyphens');
};

const validateEmail = (field = 'email') => {
  return body(field)
    .trim()
    .isEmail().withMessage('Must be a valid email address')
    .normalizeEmail();
};

const validatePassword = (field = 'password') => {
  return body(field)
    .isLength({ min: 8 }).withMessage('Password must be at least 8 characters long')
    .matches(/[A-Z]/).withMessage('Password must contain at least one uppercase letter')
    .matches(/[a-z]/).withMessage('Password must contain at least one lowercase letter')
    .matches(/[0-9]/).withMessage('Password must contain at least one number');
};

const validateUsername = (field = 'username') => {
  return body(field)
    .trim()
    .isLength({ min: 3, max: 50 }).withMessage('Username must be between 3 and 50 characters')
    .matches(/^[a-zA-Z0-9_-]+$/).withMessage('Username must contain only alphanumeric characters, underscores, and hyphens');
};

// Auth validation rules
const validateLogin = [
  body('username')
    .trim()
    .notEmpty().withMessage('Username is required'),
  body('password')
    .notEmpty().withMessage('Password is required'),
  handleValidationErrors
];

const validateTenantLogin = [
  body('tenant_code')
    .trim()
    .notEmpty().withMessage('Tenant code is required')
    .isLength({ min: 1, max: 50 }).withMessage('Tenant code must be between 1 and 50 characters'),
  body('username')
    .trim()
    .notEmpty().withMessage('Username is required'),
  body('password')
    .notEmpty().withMessage('Password is required'),
  handleValidationErrors
];

const validatePasswordChange = [
  body('username')
    .trim()
    .notEmpty().withMessage('Username is required'),
  body('current_password')
    .notEmpty().withMessage('Current password is required'),
  body('new_password')
    .isLength({ min: 8 }).withMessage('New password must be at least 8 characters long')
    .matches(/[A-Z]/).withMessage('New password must contain at least one uppercase letter')
    .matches(/[a-z]/).withMessage('New password must contain at least one lowercase letter')
    .matches(/[0-9]/).withMessage('New password must contain at least one number'),
  handleValidationErrors
];

const validateTenantPasswordChange = [
  body('tenant_code')
    .trim()
    .notEmpty().withMessage('Tenant code is required'),
  body('username')
    .trim()
    .notEmpty().withMessage('Username is required'),
  body('current_password')
    .notEmpty().withMessage('Current password is required'),
  body('new_password')
    .isLength({ min: 8 }).withMessage('New password must be at least 8 characters long')
    .matches(/[A-Z]/).withMessage('New password must contain at least one uppercase letter')
    .matches(/[a-z]/).withMessage('New password must contain at least one lowercase letter')
    .matches(/[0-9]/).withMessage('New password must contain at least one number'),
  handleValidationErrors
];

const validateProfileUpdate = [
  body('full_name')
    .optional({ nullable: true, checkFalsy: true })
    .trim()
    .isLength({ min: 1, max: 100 }).withMessage('Full name must be between 1 and 100 characters'),
  body('email')
    .optional({ nullable: true, checkFalsy: true })
    .trim()
    .isEmail().withMessage('Must be a valid email address')
    .normalizeEmail(),
  body('phone')
    .optional({ nullable: true, checkFalsy: true })
    .trim()
    .custom((value) => {
      // Allow empty string or valid phone format
      if (!value || value === '') return true;
      return /^[+]?[(]?[0-9]{1,4}[)]?[-\s./0-9]*$/.test(value);
    })
    .withMessage('Must be a valid phone number'),
  body('department')
    .optional({ nullable: true, checkFalsy: true })
    .trim()
    .isLength({ max: 100 }).withMessage('Department must not exceed 100 characters'),
  handleValidationErrors
];

// Ticket validation rules
const validateTicketCreate = [
  validateTenantId(),
  body('title')
    .trim()
    .notEmpty().withMessage('Title is required')
    .isLength({ min: 5, max: 200 }).withMessage('Title must be between 5 and 200 characters'),
  body('description')
    .trim()
    .notEmpty().withMessage('Description is required')
    .isLength({ min: 10, max: 5000 }).withMessage('Description must be between 10 and 5000 characters'),
  body('priority')
    .optional()
    .isIn(['Low', 'Normal', 'High', 'Critical', 'low', 'normal', 'medium', 'high', 'critical']).withMessage('Priority must be Low, Normal, High, or Critical'),
  body('customer_id')
    .optional()
    .isInt({ min: 1 }).withMessage('Customer ID must be a positive integer'),
  body('cmdb_item_id')
    .optional({ values: 'falsy' })
    .isInt({ min: 1 }).withMessage('CMDB Item ID must be a positive integer'),
  body('ci_id')
    .optional()
    .isInt({ min: 1 }).withMessage('CI ID must be a positive integer'),
  body('due_date')
    .optional()
    .isISO8601().withMessage('Due date must be a valid ISO 8601 date'),
  handleValidationErrors
];

const validateTicketUpdate = [
  validateTenantId(),
  param('ticketId')
    .isInt({ min: 1 }).withMessage('Ticket ID must be a positive integer'),
  body('status')
    .optional()
    .isIn(['Open', 'In Progress', 'Pending', 'Resolved', 'Closed']).withMessage('Status must be Open, In Progress, Pending, Resolved, or Closed'),
  body('assignee_id')
    .optional()
    .isInt({ min: 1 }).withMessage('Assignee ID must be a positive integer'),
  body('priority')
    .optional()
    .isIn(['Low', 'Normal', 'High', 'Critical', 'low', 'normal', 'medium', 'high', 'critical']).withMessage('Priority must be Low, Normal, High, or Critical'),
  body('comment')
    .optional()
    .trim()
    .isLength({ max: 1000 }).withMessage('Comment must not exceed 1000 characters'),
  handleValidationErrors
];

const validateTicketGet = [
  validateTenantId(),
  param('ticketId')
    .optional()
    .isInt({ min: 1 }).withMessage('Ticket ID must be a positive integer'),
  handleValidationErrors
];

// CMDB validation rules
const validateCmdbItemsGet = [
  validateTenantId(),
  query('customer_id')
    .optional()
    .isInt({ min: 1 }).withMessage('Customer ID must be a positive integer'),
  handleValidationErrors
];

const validateCmdbItemTypeCreate = [
  validateTenantId(),
  body('name')
    .trim()
    .notEmpty().withMessage('Name is required')
    .isLength({ min: 2, max: 100 }).withMessage('Name must be between 2 and 100 characters'),
  body('description')
    .optional()
    .trim()
    .isLength({ max: 500 }).withMessage('Description must not exceed 500 characters'),
  handleValidationErrors
];

const validateCiTypeCreate = [
  validateTenantId(),
  param('itemTypeId')
    .isInt({ min: 1 }).withMessage('Item Type ID must be a positive integer'),
  body('name')
    .trim()
    .notEmpty().withMessage('Name is required')
    .isLength({ min: 2, max: 100 }).withMessage('Name must be between 2 and 100 characters'),
  body('description')
    .optional()
    .trim()
    .isLength({ max: 500 }).withMessage('Description must not exceed 500 characters'),
  handleValidationErrors
];

// Master admin validation rules
const validateTenantCreate = [
  body('tenant_code')
    .trim()
    .notEmpty().withMessage('Tenant code is required')
    .isLength({ min: 3, max: 50 }).withMessage('Tenant code must be between 3 and 50 characters')
    .matches(/^[a-z0-9_-]+$/).withMessage('Tenant code must contain only lowercase letters, numbers, underscores, and hyphens'),
  body('company_name')
    .trim()
    .notEmpty().withMessage('Company name is required')
    .isLength({ min: 2, max: 100 }).withMessage('Company name must be between 2 and 100 characters'),
  body('display_name')
    .optional()
    .trim()
    .isLength({ max: 100 }).withMessage('Display name must not exceed 100 characters'),
  body('database_name')
    .trim()
    .notEmpty().withMessage('Database name is required')
    .matches(/^[a-z0-9_]+$/).withMessage('Database name must contain only lowercase letters, numbers, and underscores'),
  body('database_host')
    .optional()
    .trim()
    .isLength({ max: 255 }).withMessage('Database host must not exceed 255 characters'),
  body('database_port')
    .optional()
    .isInt({ min: 1, max: 65535 }).withMessage('Database port must be between 1 and 65535'),
  body('database_user')
    .trim()
    .notEmpty().withMessage('Database user is required')
    .isLength({ max: 100 }).withMessage('Database user must not exceed 100 characters'),
  body('database_password')
    .notEmpty().withMessage('Database password is required'),
  body('max_users')
    .optional()
    .isInt({ min: 1 }).withMessage('Max users must be a positive integer'),
  body('max_tickets')
    .optional()
    .isInt({ min: 1 }).withMessage('Max tickets must be a positive integer'),
  body('subscription_plan')
    .optional()
    .isIn(['basic', 'professional', 'enterprise']).withMessage('Subscription plan must be basic, professional, or enterprise'),
  handleValidationErrors
];

const validateTenantUpdate = [
  param('id')
    .isInt({ min: 1 }).withMessage('Tenant ID must be a positive integer'),
  body('company_name')
    .optional()
    .trim()
    .isLength({ min: 2, max: 100 }).withMessage('Company name must be between 2 and 100 characters'),
  body('display_name')
    .optional()
    .trim()
    .isLength({ max: 100 }).withMessage('Display name must not exceed 100 characters'),
  body('is_active')
    .optional()
    .isBoolean().withMessage('is_active must be a boolean value'),
  body('admin_email')
    .optional()
    .trim()
    .isEmail().withMessage('Admin email must be a valid email address')
    .isLength({ max: 100 }).withMessage('Admin email must not exceed 100 characters'),
  handleValidationErrors
];

const validateEmailTest = [
  body('email')
    .trim()
    .notEmpty().withMessage('Email is required')
    .isEmail().withMessage('Must be a valid email address')
    .normalizeEmail(),
  body('message')
    .optional()
    .trim()
    .isLength({ max: 1000 }).withMessage('Message must not exceed 1000 characters'),
  handleValidationErrors
];

// Pagination validation
const validatePagination = [
  query('page')
    .optional()
    .isInt({ min: 1 }).withMessage('Page must be a positive integer'),
  query('limit')
    .optional()
    .isInt({ min: 1, max: 100 }).withMessage('Limit must be between 1 and 100'),
  handleValidationErrors
];

// Export all validation rules
module.exports = {
  // Middleware
  handleValidationErrors,

  // Common validators
  validateTenantId,
  validateEmail,
  validatePassword,
  validateUsername,

  // Auth validators
  validateLogin,
  validateTenantLogin,
  validatePasswordChange,
  validateTenantPasswordChange,
  validateProfileUpdate,

  // Ticket validators
  validateTicketCreate,
  validateTicketUpdate,
  validateTicketGet,

  // CMDB validators
  validateCmdbItemsGet,
  validateCmdbItemTypeCreate,
  validateCiTypeCreate,

  // Master admin validators
  validateTenantCreate,
  validateTenantUpdate,
  validateEmailTest,

  // Common validators
  validatePagination
};
