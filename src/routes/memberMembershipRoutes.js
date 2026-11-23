'use strict';

const express = require('express');

const {
  requireGymPermission,
} = require('../middleware/gymStaffAuthMiddleware');

const {
  listMemberMemberships,
  assignMemberMembership,
  updateMemberMembership,
  cancelMemberMembership,
  renewMemberMembership,
} = require('../controllers/memberMembershipController');

const {
  suspendMemberMembership,
  reactivateMemberMembership,
} = require('../controllers/memberMembershipStatusController');

const {
  listMembershipInvoices,
  createMembershipInvoice,
  voidMembershipInvoice,
} = require('../controllers/memberMembershipInvoiceController');
const {
  listMemberInvoicePayments,
  receiveMemberInvoicePayment,
  receiveMembershipPayment,
  voidMemberInvoicePayment,
} = require('../controllers/memberMembershipPaymentController');
const {
  listMemberPaymentRefunds,
  createMemberPaymentRefund,
  voidMemberPaymentRefund,
} = require('../controllers/memberMembershipRefundController');
const {
  listMemberInvoiceWaivers,
  createMemberInvoiceWaiver,
  voidMemberInvoiceWaiver,
} = require('../controllers/memberMembershipWaiverController');


const router = express.Router({ mergeParams: true });

const requireAnyGymPermission = (...requiredPermissions) =>
  (req, res, next) => {
    const permissions = Array.isArray(req.gymStaff?.permissions)
      ? req.gymStaff.permissions
      : [];

    if (
      requiredPermissions.some((permission) =>
        permissions.includes(permission)
      )
    ) {
      return next();
    }

    return res.status(403).json({
      success: false,
      code: 'GYM_PERMISSION_DENIED',
      message: 'You do not have permission to access this resource.',
      required_permissions: requiredPermissions,
    });
  };

const requireCardPaymentPermission = (req, res, next) => {
  const method = String(req.body?.payment_method || '').trim().toLowerCase();

  if (
    method === 'card' &&
    !(req.gymStaff?.permissions || []).includes(
      'member_billing.payments.receive.card'
    )
  ) {
    return res.status(403).json({
      success: false,
      code: 'GYM_PERMISSION_DENIED',
      message: 'You do not have permission to receive card payments.',
      required_permission: 'member_billing.payments.receive.card',
    });
  }

  return next();
};

router.get(
  '/',
  requireAnyGymPermission(
    'member_memberships.view',
    'member_billing.member_account.view',
    'member_billing.payments.receive'
  ),
  listMemberMemberships
);

router.post(
  '/',
  requireGymPermission('member_memberships.assign'),
  assignMemberMembership
);

router.patch(
  '/:membershipId',
  requireGymPermission('member_memberships.update'),
  updateMemberMembership
);

router.post(
  '/:membershipId/cancel',
  requireGymPermission('member_memberships.cancel'),
  cancelMemberMembership
);

router.post(
  '/:membershipId/renew',
  requireGymPermission('member_memberships.assign'),
  renewMemberMembership
);

router.post(
  '/:membershipId/suspend',
  requireGymPermission('member_memberships.suspend'),
  suspendMemberMembership
);

router.post(
  '/:membershipId/reactivate',
  requireGymPermission('member_memberships.reactivate'),
  reactivateMemberMembership
);

router.get(
  '/:membershipId/invoices',
  requireAnyGymPermission(
    'member_billing.invoices.view',
    'member_billing.member_account.view',
    'member_billing.payments.receive'
  ),
  listMembershipInvoices
);

router.post(
  '/:membershipId/invoices',
  requireGymPermission('member_billing.invoices.create'),
  createMembershipInvoice
);
router.post(
  '/:membershipId/invoices/:invoiceId/void',
  requireGymPermission('member_billing.invoices.void'),
  voidMembershipInvoice
);

router.get(
  '/:membershipId/invoices/:invoiceId/waivers',
  requireGymPermission('member_billing.waivers.view'),
  listMemberInvoiceWaivers
);

router.post(
  '/:membershipId/invoices/:invoiceId/waivers',
  requireGymPermission('member_billing.waivers.create'),
  createMemberInvoiceWaiver
);

router.post(
  '/:membershipId/invoices/:invoiceId/waivers/:waiverId/void',
  requireGymPermission('member_billing.waivers.void'),
  voidMemberInvoiceWaiver
);
router.post(
  '/:membershipId/payments',
  requireGymPermission('member_billing.payments.receive'),
  requireCardPaymentPermission,
  receiveMembershipPayment
);
router.get(
  '/:membershipId/invoices/:invoiceId/payments',
  requireAnyGymPermission(
    'member_billing.payments.view',
    'member_billing.payments.receive'
  ),
  listMemberInvoicePayments
);

router.post(
  '/:membershipId/invoices/:invoiceId/payments',
  requireGymPermission('member_billing.payments.receive'),
  requireCardPaymentPermission,
  receiveMemberInvoicePayment
);
router.post(
  '/:membershipId/invoices/:invoiceId/payments/:paymentId/void',
  requireGymPermission('member_billing.payments.void'),
  voidMemberInvoicePayment
);
router.get(
  '/:membershipId/invoices/:invoiceId/payments/:paymentId/refunds',
  requireGymPermission('member_billing.refunds.view'),
  listMemberPaymentRefunds
);

router.post(
  '/:membershipId/invoices/:invoiceId/payments/:paymentId/refunds',
  requireGymPermission('member_billing.refunds.create'),
  createMemberPaymentRefund
);

router.post(
  '/:membershipId/invoices/:invoiceId/payments/:paymentId/refunds/:refundId/void',
  requireGymPermission('member_billing.refunds.void'),
  voidMemberPaymentRefund
);
module.exports = router;





