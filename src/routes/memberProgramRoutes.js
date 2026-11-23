'use strict';

const express = require('express');

const {
  requireGymPermission,
} = require('../middleware/gymStaffAuthMiddleware');

const {
  listAvailableUnifiedPrograms,
  listMemberProgramAssignments,
  assignFitnessProgramToMember,
  pauseMemberProgramAssignment,
  getMemberProgramResumePreview,
  resumeMemberProgramAssignment,
  completeMemberProgramAssignment,
  cancelMemberProgramAssignment,
  listMemberProgramPauseHistory,
} = require('../controllers/memberProgramController');

const {
  getProgramInvoice,
  listProgramInvoicePayments,
  receiveProgramInvoicePayment,
  voidProgramInvoicePayment,
} = require('../controllers/memberProgramBillingController');

// Parent memberRoutes already enforces device authentication
// and Gym Staff authentication.
const requireProgramCardPaymentPermission = (req, res, next) => {
  const method = String(req.body?.payment_method || '').trim().toLowerCase();

  if (
    method === 'card' &&
    !(req.gymStaff?.permissions || []).includes('member_billing.payments.receive.card')
  ) {
    return res.status(403).json({
      success: false,
      message: 'You do not have permission to receive card payments.',
    });
  }

  return next();
};
const router = express.Router({ mergeParams: true });

router.get(
  '/catalog',
  requireGymPermission('fitness_programs.view'),
  listAvailableUnifiedPrograms
);

router.get(
  '/',
  requireGymPermission('member_programs.view'),
  listMemberProgramAssignments
);

router.post(
  '/',
  requireGymPermission('member_programs.assign'),
  assignFitnessProgramToMember
);

router.get(
  '/:assignmentId/invoice',
  requireGymPermission('member_program_billing.invoices.view'),
  getProgramInvoice
);

router.get(
  '/:assignmentId/invoice/payments',
  requireGymPermission('member_program_billing.payments.view'),
  listProgramInvoicePayments
);

router.post(
  '/:assignmentId/invoice/payments',
  requireGymPermission('member_program_billing.payments.receive'),
  requireProgramCardPaymentPermission,
  receiveProgramInvoicePayment
);

router.post(
  '/:assignmentId/invoice/payments/:paymentId/void',
  requireGymPermission('member_program_billing.payments.void'),
  voidProgramInvoicePayment
);

router.post(
  '/:assignmentId/pause',
  requireGymPermission('member_programs.pause'),
  pauseMemberProgramAssignment
);

router.get(
  '/:assignmentId/resume-preview',
  requireGymPermission('member_programs.resume'),
  getMemberProgramResumePreview
);

router.post(
  '/:assignmentId/resume',
  requireGymPermission('member_programs.resume'),
  resumeMemberProgramAssignment
);

router.post(
  '/:assignmentId/complete',
  requireGymPermission('member_programs.complete'),
  completeMemberProgramAssignment
);

router.post(
  '/:assignmentId/cancel',
  requireGymPermission('member_programs.cancel'),
  cancelMemberProgramAssignment
);

router.get(
  '/:assignmentId/pause-history',
  requireGymPermission('member_programs.pause_history.view'),
  listMemberProgramPauseHistory
);

module.exports = router;