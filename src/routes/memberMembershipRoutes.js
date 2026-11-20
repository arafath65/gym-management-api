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
  listMembershipInvoices,
  createMembershipInvoice,
  voidMembershipInvoice,
} = require('../controllers/memberMembershipInvoiceController');
const {
  listMemberInvoicePayments,
  receiveMemberInvoicePayment,
  voidMemberInvoicePayment,
} = require('../controllers/memberMembershipPaymentController');
const {
  listMemberPaymentRefunds,
  createMemberPaymentRefund,
  voidMemberPaymentRefund,
} = require('../controllers/memberMembershipRefundController');


const router = express.Router({ mergeParams: true });

router.get(
  '/',
  requireGymPermission('member_memberships.view'),
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

router.get(
  '/:membershipId/invoices',
  requireGymPermission('member_billing.view'),
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
  '/:membershipId/invoices/:invoiceId/payments',
  requireGymPermission('member_billing.view'),
  listMemberInvoicePayments
);

router.post(
  '/:membershipId/invoices/:invoiceId/payments',
  requireGymPermission('member_billing.payments.receive'),
  receiveMemberInvoicePayment
);
router.post(
  '/:membershipId/invoices/:invoiceId/payments/:paymentId/void',
  requireGymPermission('member_billing.payments.void'),
  voidMemberInvoicePayment
);
router.get(
  '/:membershipId/invoices/:invoiceId/payments/:paymentId/refunds',
  requireGymPermission('member_billing.view'),
  listMemberPaymentRefunds
);

router.post(
  '/:membershipId/invoices/:invoiceId/payments/:paymentId/refunds',
  requireGymPermission('member_billing.refunds.manage'),
  createMemberPaymentRefund
);

router.post(
  '/:membershipId/invoices/:invoiceId/payments/:paymentId/refunds/:refundId/void',
  requireGymPermission('member_billing.refunds.manage'),
  voidMemberPaymentRefund
);
module.exports = router;





