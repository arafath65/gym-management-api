import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'package:gym_management_app/core/services/gym_api_client.dart';
import 'package:gym_management_app/features/membership_plans/data/membership_plan_service.dart';

class MembershipPlansScreen extends StatefulWidget {
  final bool canView;
  final bool canCreate;
  final bool canUpdate;
  final bool canDeactivate;

  const MembershipPlansScreen({
    super.key,
    required this.canView,
    required this.canCreate,
    required this.canUpdate,
    required this.canDeactivate,
  });

  @override
  State<MembershipPlansScreen> createState() => _MembershipPlansScreenState();
}

class _MembershipPlansScreenState extends State<MembershipPlansScreen> {
  static const Color _background = Color(0xFF080D0A);
  static const Color _surface = Color(0xFF141B16);
  static const Color _raised = Color(0xFF19221B);
  static const Color _accent = Color(0xFF9BFF35);
  static const Color _muted = Color(0xFF98A49B);
  static const Color _border = Color(0xFF2A382E);

  final MembershipPlanService _service = MembershipPlanService();
  final TextEditingController _searchController = TextEditingController();

  Timer? _searchTimer;

  List<Map<String, dynamic>> _plans = [];

  bool _loading = true;
  bool _mutating = false;

  String? _error;
  String _status = 'all';
  String _packageType = 'all';
  String _durationUnit = 'all';

  int _page = 1;
  final int _pageSize = 12;
  int _total = 0;
  int _totalPages = 1;

  @override
  void initState() {
    super.initState();
    _loadPlans();
  }

  @override
  void dispose() {
    _searchTimer?.cancel();
    _searchController.dispose();
    super.dispose();
  }

  Future<void> _loadPlans({int? requestedPage}) async {
    if (!widget.canView) return;

    final targetPage = requestedPage ?? _page;

    setState(() {
      _loading = true;
      _error = null;
    });

    try {
      final response = await _service.listPlans(
        page: targetPage,
        pageSize: _pageSize,
        search: _searchController.text.trim(),
        status: _status,
        packageType: _packageType,
        durationUnit: _durationUnit,
      );

      final rawPlans = response['plans'];
      final pagination = response['pagination'];

      final plans = rawPlans is List
          ? rawPlans
                .whereType<Map>()
                .map((item) => Map<String, dynamic>.from(item))
                .toList()
          : <Map<String, dynamic>>[];

      final pageData = pagination is Map
          ? Map<String, dynamic>.from(pagination)
          : <String, dynamic>{};

      if (!mounted) return;

      setState(() {
        _plans = plans;
        _page = int.tryParse(pageData['page']?.toString() ?? '') ?? targetPage;
        _total =
            int.tryParse(pageData['total']?.toString() ?? '') ?? plans.length;
        _totalPages =
            int.tryParse(pageData['total_pages']?.toString() ?? '') ?? 1;
        if (_totalPages < 1) _totalPages = 1;
        _loading = false;
      });
    } on GymApiException catch (error) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = error.message;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = 'Unable to load membership plans.';
      });
    }
  }

  void _onSearchChanged(String value) {
    _searchTimer?.cancel();
    _searchTimer = Timer(
      const Duration(milliseconds: 450),
      () => _loadPlans(requestedPage: 1),
    );
  }

  void _showMessage(String message, {bool isError = false}) {
    if (!mounted) return;

    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(message),
        backgroundColor: isError ? const Color(0xFF7B2828) : _raised,
        behavior: SnackBarBehavior.floating,
      ),
    );
  }

  Future<void> _openForm({Map<String, dynamic>? plan}) async {
    final result = await showDialog<Map<String, dynamic>>(
      context: context,
      barrierDismissible: false,
      builder: (_) => _MembershipPlanFormDialog(initialPlan: plan),
    );

    if (result == null || !mounted) return;

    setState(() => _mutating = true);

    try {
      if (plan == null) {
        await _service.createPlan(result);
        _showMessage('Membership plan created successfully.');
      } else {
        await _service.updatePlan(int.parse(plan['id'].toString()), result);
        _showMessage('Membership plan updated successfully.');
      }

      await _loadPlans(requestedPage: plan == null ? 1 : _page);
    } on GymApiException catch (error) {
      _showMessage(error.message, isError: true);
    } catch (_) {
      _showMessage('Unable to save membership plan.', isError: true);
    } finally {
      if (mounted) setState(() => _mutating = false);
    }
  }

  Future<void> _changeStatus(Map<String, dynamic> plan) async {
    final isActive = plan['status'] == 'active';

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        backgroundColor: _raised,
        title: Text(
          isActive ? 'Deactivate plan?' : 'Reactivate plan?',
          style: const TextStyle(color: Colors.white),
        ),
        content: Text(
          isActive
              ? 'This plan will no longer be available for new memberships. Existing member history will not be deleted.'
              : 'This plan will become available for new memberships again.',
          style: const TextStyle(color: _muted, height: 1.5),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, false),
            child: const Text('CANCEL'),
          ),
          FilledButton(
            style: FilledButton.styleFrom(
              backgroundColor: _accent,
              foregroundColor: _background,
            ),
            onPressed: () => Navigator.pop(dialogContext, true),
            child: Text(isActive ? 'DEACTIVATE' : 'REACTIVATE'),
          ),
        ],
      ),
    );

    if (confirmed != true || !mounted) return;

    final planId = int.tryParse(plan['id']?.toString() ?? '');
    if (planId == null) return;

    setState(() => _mutating = true);

    try {
      if (isActive) {
        await _service.deactivatePlan(planId);
      } else {
        await _service.reactivatePlan(planId);
      }

      _showMessage(
        isActive
            ? 'Membership plan deactivated.'
            : 'Membership plan reactivated.',
      );

      await _loadPlans();
    } on GymApiException catch (error) {
      _showMessage(error.message, isError: true);
    } catch (_) {
      _showMessage('Unable to update plan status.', isError: true);
    } finally {
      if (mounted) setState(() => _mutating = false);
    }
  }

  void _showDetails(Map<String, dynamic> plan) {
    final packageType = plan['package_type']?.toString() ?? 'individual';
    final included = packageType == 'couple' ? '2 members' : '1 member';
    final paying = packageType == 'couple'
        ? '1 paying member'
        : '1 paying member';

    showDialog<void>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        backgroundColor: _raised,
        title: Text(
          plan['name']?.toString() ?? 'Membership plan',
          style: const TextStyle(
            color: Colors.white,
            fontWeight: FontWeight.w800,
          ),
        ),
        content: SizedBox(
          width: 480,
          child: SingleChildScrollView(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                _detailRow('Plan code', plan['plan_code']),
                _detailRow('Package', _packageLabel(packageType)),
                _detailRow('Tier', plan['tier'] ?? 'Not specified'),
                _detailRow('Duration', _durationLabel(plan)),
                _detailRow(
                  'Price',
                  '${plan['currency_code']} ${plan['price']}',
                ),
                _detailRow('Coverage', included),
                _detailRow('Paying members', paying),
                _detailRow('Status', plan['status']),
                const SizedBox(height: 12),
                const Text(
                  'Description',
                  style: TextStyle(
                    color: _accent,
                    fontWeight: FontWeight.w800,
                    fontSize: 12,
                  ),
                ),
                const SizedBox(height: 6),
                Text(
                  plan['description']?.toString().trim().isNotEmpty == true
                      ? plan['description'].toString()
                      : 'No description provided.',
                  style: const TextStyle(color: _muted, height: 1.5),
                ),
                const SizedBox(height: 14),
                const Text(
                  'Active member statistics will be available after Member Subscriptions are implemented.',
                  style: TextStyle(color: _muted, fontSize: 11, height: 1.5),
                ),
              ],
            ),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext),
            child: const Text('CLOSE'),
          ),
        ],
      ),
    );
  }

  Widget _detailRow(String label, dynamic value) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 125,
            child: Text(label, style: const TextStyle(color: _muted)),
          ),
          Expanded(
            child: Text(
              value?.toString() ?? '—',
              style: const TextStyle(
                color: Colors.white,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
        ],
      ),
    );
  }

  String _packageLabel(String value) {
    return value == 'couple' ? 'Couple' : 'Individual';
  }

  String _durationLabel(Map<String, dynamic> plan) {
    final amount = int.tryParse(plan['duration_value']?.toString() ?? '') ?? 1;
    final unit = plan['duration_unit']?.toString() ?? 'month';
    final label = unit[0].toUpperCase() + unit.substring(1);
    return '$amount $label${amount == 1 ? '' : 's'}';
  }

  Widget _statusBadge(String status) {
    final active = status == 'active';
    final color = active ? _accent : const Color(0xFFE0A1A1);

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.10),
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: color.withValues(alpha: 0.28)),
      ),
      child: Text(
        active ? 'ACTIVE' : 'INACTIVE',
        style: TextStyle(
          color: color,
          fontSize: 9,
          fontWeight: FontWeight.w900,
          letterSpacing: 0.6,
        ),
      ),
    );
  }

  Widget _filterDropdown({
    required String label,
    required String value,
    required List<DropdownMenuItem<String>> items,
    required ValueChanged<String?> onChanged,
    double width = 150,
  }) {
    return SizedBox(
      width: width,
      child: DropdownButtonFormField<String>(
        initialValue: value,
        dropdownColor: _raised,
        style: const TextStyle(color: Colors.white, fontSize: 12),
        decoration: InputDecoration(
          labelText: label,
          labelStyle: const TextStyle(color: _muted, fontSize: 11),
          filled: true,
          fillColor: _surface,
          contentPadding: const EdgeInsets.symmetric(
            horizontal: 12,
            vertical: 10,
          ),
          enabledBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(9),
            borderSide: const BorderSide(color: _border),
          ),
          focusedBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(9),
            borderSide: const BorderSide(color: _accent),
          ),
        ),
        items: items,
        onChanged: onChanged,
      ),
    );
  }

  Widget _buildFilters() {
    return Wrap(
      spacing: 10,
      runSpacing: 10,
      crossAxisAlignment: WrapCrossAlignment.center,
      children: [
        SizedBox(
          width: 260,
          child: TextField(
            controller: _searchController,
            onChanged: _onSearchChanged,
            onSubmitted: (_) => _loadPlans(requestedPage: 1),
            style: const TextStyle(color: Colors.white, fontSize: 12),
            decoration: InputDecoration(
              hintText: 'Search name, code or tier...',
              hintStyle: const TextStyle(color: _muted, fontSize: 11),
              prefixIcon: const Icon(
                Icons.search_rounded,
                color: _muted,
                size: 19,
              ),
              filled: true,
              fillColor: _surface,
              contentPadding: const EdgeInsets.symmetric(vertical: 11),
              enabledBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(9),
                borderSide: const BorderSide(color: _border),
              ),
              focusedBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(9),
                borderSide: const BorderSide(color: _accent),
              ),
            ),
          ),
        ),
        _filterDropdown(
          label: 'Status',
          value: _status,
          width: 125,
          items: const [
            DropdownMenuItem(value: 'all', child: Text('All statuses')),
            DropdownMenuItem(value: 'active', child: Text('Active')),
            DropdownMenuItem(value: 'inactive', child: Text('Inactive')),
          ],
          onChanged: (value) {
            if (value == null) return;
            setState(() => _status = value);
            _loadPlans(requestedPage: 1);
          },
        ),
        _filterDropdown(
          label: 'Package',
          value: _packageType,
          width: 140,
          items: const [
            DropdownMenuItem(value: 'all', child: Text('All packages')),
            DropdownMenuItem(value: 'individual', child: Text('Individual')),
            DropdownMenuItem(value: 'couple', child: Text('Couple')),
          ],
          onChanged: (value) {
            if (value == null) return;
            setState(() => _packageType = value);
            _loadPlans(requestedPage: 1);
          },
        ),
        _filterDropdown(
          label: 'Duration',
          value: _durationUnit,
          width: 130,
          items: const [
            DropdownMenuItem(value: 'all', child: Text('All durations')),
            DropdownMenuItem(value: 'day', child: Text('Days')),
            DropdownMenuItem(value: 'week', child: Text('Weeks')),
            DropdownMenuItem(value: 'month', child: Text('Months')),
            DropdownMenuItem(value: 'year', child: Text('Years')),
          ],
          onChanged: (value) {
            if (value == null) return;
            setState(() => _durationUnit = value);
            _loadPlans(requestedPage: 1);
          },
        ),
        IconButton(
          tooltip: 'Refresh plans',
          onPressed: _loading ? null : () => _loadPlans(),
          icon: const Icon(Icons.refresh_rounded, color: _accent),
        ),
      ],
    );
  }

  Widget _buildPlanCard(Map<String, dynamic> plan) {
    final status = plan['status']?.toString() ?? 'inactive';
    final isActive = status == 'active';
    return Container(
      padding: const EdgeInsets.all(17),
      decoration: BoxDecoration(
        color: _surface,
        borderRadius: BorderRadius.circular(13),
        border: Border.all(color: _border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: InkWell(
                  onTap: () => _showDetails(plan),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        plan['name']?.toString() ?? 'Unnamed plan',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          color: Colors.white,
                          fontSize: 15,
                          fontWeight: FontWeight.w800,
                        ),
                      ),
                      const SizedBox(height: 5),
                      Text(
                        '${plan['plan_code'] ?? '—'}  •  ${_packageLabel(plan['package_type']?.toString() ?? 'individual')}',
                        style: const TextStyle(color: _muted, fontSize: 10),
                      ),
                    ],
                  ),
                ),
              ),
              const SizedBox(width: 8),
              _statusBadge(status),
            ],
          ),
          const SizedBox(height: 18),
          Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      '${plan['currency_code'] ?? ''} ${plan['price'] ?? '0.00'}',
                      style: const TextStyle(
                        color: _accent,
                        fontSize: 23,
                        fontWeight: FontWeight.w900,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      _durationLabel(plan),
                      style: const TextStyle(color: _muted, fontSize: 11),
                    ),
                  ],
                ),
              ),
              if ((plan['tier']?.toString() ?? '').isNotEmpty)
                Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 10,
                    vertical: 6,
                  ),
                  decoration: BoxDecoration(
                    color: _raised,
                    borderRadius: BorderRadius.circular(20),
                    border: Border.all(color: _border),
                  ),
                  child: Text(
                    plan['tier'].toString(),
                    style: const TextStyle(
                      color: Colors.white,
                      fontSize: 10,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ),
            ],
          ),
          const SizedBox(height: 16),
          const Divider(color: _border, height: 1),
          const SizedBox(height: 12),
          const Row(
            children: [
              Icon(Icons.people_alt_outlined, color: _muted, size: 15),
              SizedBox(width: 7),
              Expanded(
                child: Text(
                  'Member usage statistics available after subscriptions',
                  style: TextStyle(color: _muted, fontSize: 9),
                ),
              ),
            ],
          ),
          const SizedBox(height: 11),
          Wrap(
            spacing: 8,
            runSpacing: 7,
            children: [
              OutlinedButton.icon(
                onPressed: () => _showDetails(plan),
                style: OutlinedButton.styleFrom(
                  foregroundColor: Colors.white,
                  side: const BorderSide(color: _border),
                  visualDensity: VisualDensity.compact,
                ),
                icon: const Icon(Icons.visibility_outlined, size: 15),
                label: const Text('View'),
              ),
              if (widget.canUpdate)
                OutlinedButton.icon(
                  onPressed: _mutating ? null : () => _openForm(plan: plan),
                  style: OutlinedButton.styleFrom(
                    foregroundColor: _accent,
                    side: const BorderSide(color: _border),
                    visualDensity: VisualDensity.compact,
                  ),
                  icon: const Icon(Icons.edit_outlined, size: 15),
                  label: const Text('Edit'),
                ),
              if (isActive && widget.canDeactivate)
                TextButton.icon(
                  onPressed: _mutating ? null : () => _changeStatus(plan),
                  style: TextButton.styleFrom(
                    foregroundColor: const Color(0xFFE0A1A1),
                    visualDensity: VisualDensity.compact,
                  ),
                  icon: const Icon(Icons.block_rounded, size: 15),
                  label: const Text('Deactivate'),
                ),
              if (!isActive && widget.canUpdate)
                TextButton.icon(
                  onPressed: _mutating ? null : () => _changeStatus(plan),
                  style: TextButton.styleFrom(
                    foregroundColor: _accent,
                    visualDensity: VisualDensity.compact,
                  ),
                  icon: const Icon(Icons.check_circle_outline, size: 15),
                  label: const Text('Reactivate'),
                ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildEmptyState() {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(vertical: 55, horizontal: 20),
      decoration: BoxDecoration(
        color: _surface,
        borderRadius: BorderRadius.circular(13),
        border: Border.all(color: _border),
      ),
      child: Column(
        children: [
          const Icon(Icons.card_membership_outlined, color: _muted, size: 42),
          const SizedBox(height: 14),
          const Text(
            'No membership plans found',
            style: TextStyle(
              color: Colors.white,
              fontSize: 15,
              fontWeight: FontWeight.w800,
            ),
          ),
          const SizedBox(height: 7),
          const Text(
            'Create your first plan or change the current filters.',
            style: TextStyle(color: _muted, fontSize: 11),
            textAlign: TextAlign.center,
          ),
          if (widget.canCreate) ...[
            const SizedBox(height: 18),
            FilledButton.icon(
              onPressed: _mutating ? null : () => _openForm(),
              style: FilledButton.styleFrom(
                backgroundColor: _accent,
                foregroundColor: _background,
              ),
              icon: const Icon(Icons.add),
              label: const Text('CREATE FIRST PLAN'),
            ),
          ],
        ],
      ),
    );
  }

  Widget _buildPagination() {
    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      children: [
        Text(
          '$_total plan${_total == 1 ? '' : 's'} found',
          style: const TextStyle(color: _muted, fontSize: 11),
        ),
        Row(
          children: [
            IconButton(
              tooltip: 'Previous page',
              onPressed: _page > 1 && !_loading
                  ? () => _loadPlans(requestedPage: _page - 1)
                  : null,
              icon: const Icon(Icons.chevron_left, color: _accent),
            ),
            Text(
              '$_page / $_totalPages',
              style: const TextStyle(
                color: Colors.white,
                fontSize: 11,
                fontWeight: FontWeight.w700,
              ),
            ),
            IconButton(
              tooltip: 'Next page',
              onPressed: _page < _totalPages && !_loading
                  ? () => _loadPlans(requestedPage: _page + 1)
                  : null,
              icon: const Icon(Icons.chevron_right, color: _accent),
            ),
          ],
        ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    if (!widget.canView) {
      return Container(
        padding: const EdgeInsets.all(28),
        decoration: BoxDecoration(
          color: _surface,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: _border),
        ),
        child: const Center(
          child: Text(
            'You do not have permission to view membership plans.',
            style: TextStyle(color: _muted),
          ),
        ),
      );
    }

    return Container(
      color: _background,
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(24),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text(
                        'Membership Plans',
                        style: TextStyle(
                          color: Colors.white,
                          fontSize: 25,
                          fontWeight: FontWeight.w900,
                        ),
                      ),
                      const SizedBox(height: 6),
                      const Text(
                        'Create and manage individual, couple and flexible-duration plans.',
                        style: TextStyle(color: _muted, fontSize: 11),
                      ),
                    ],
                  ),
                ),
                if (widget.canCreate)
                  FilledButton.icon(
                    onPressed: _mutating ? null : () => _openForm(),
                    style: FilledButton.styleFrom(
                      backgroundColor: _accent,
                      foregroundColor: _background,
                      padding: const EdgeInsets.symmetric(
                        horizontal: 17,
                        vertical: 13,
                      ),
                    ),
                    icon: const Icon(Icons.add_rounded, size: 18),
                    label: const Text(
                      'NEW PLAN',
                      style: TextStyle(
                        fontWeight: FontWeight.w900,
                        fontSize: 10,
                      ),
                    ),
                  ),
              ],
            ),
            const SizedBox(height: 22),
            Container(
              padding: const EdgeInsets.all(15),
              decoration: BoxDecoration(
                color: _surface,
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: _border),
              ),
              child: Row(
                children: [
                  Container(
                    width: 42,
                    height: 42,
                    decoration: BoxDecoration(
                      color: _accent.withValues(alpha: 0.10),
                      borderRadius: BorderRadius.circular(11),
                    ),
                    child: const Icon(Icons.layers_outlined, color: _accent),
                  ),
                  const SizedBox(width: 13),
                  const Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'Flexible membership validity',
                          style: TextStyle(
                            color: Colors.white,
                            fontSize: 12,
                            fontWeight: FontWeight.w800,
                          ),
                        ),
                        SizedBox(height: 4),
                        Text(
                          'Configure 1 day, 3 months, 6 months, 1 year or any supported duration.',
                          style: TextStyle(color: _muted, fontSize: 10),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 18),
            _buildFilters(),
            const SizedBox(height: 18),
            if (_mutating) ...[
              const LinearProgressIndicator(
                minHeight: 2,
                color: _accent,
                backgroundColor: _raised,
              ),
              const SizedBox(height: 12),
            ],
            if (_loading)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 75),
                child: Center(child: CircularProgressIndicator(color: _accent)),
              )
            else if (_error != null)
              Container(
                width: double.infinity,
                padding: const EdgeInsets.all(20),
                decoration: BoxDecoration(
                  color: _surface,
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: _border),
                ),
                child: Column(
                  children: [
                    const Icon(
                      Icons.error_outline_rounded,
                      color: Color(0xFFE0A1A1),
                      size: 35,
                    ),
                    const SizedBox(height: 10),
                    Text(
                      _error!,
                      textAlign: TextAlign.center,
                      style: const TextStyle(color: Colors.white),
                    ),
                    const SizedBox(height: 13),
                    OutlinedButton.icon(
                      onPressed: () => _loadPlans(),
                      icon: const Icon(Icons.refresh),
                      label: const Text('RETRY'),
                    ),
                  ],
                ),
              )
            else if (_plans.isEmpty)
              _buildEmptyState()
            else ...[
              LayoutBuilder(
                builder: (context, constraints) {
                  final columns = constraints.maxWidth >= 1050
                      ? 3
                      : constraints.maxWidth >= 650
                      ? 2
                      : 1;

                  const gap = 14.0;
                  final itemWidth =
                      (constraints.maxWidth - (gap * (columns - 1))) / columns;

                  return Wrap(
                    spacing: gap,
                    runSpacing: gap,
                    children: _plans
                        .map(
                          (plan) => SizedBox(
                            width: itemWidth,
                            child: _buildPlanCard(plan),
                          ),
                        )
                        .toList(),
                  );
                },
              ),
              const SizedBox(height: 18),
              _buildPagination(),
            ],
          ],
        ),
      ),
    );
  }
}

// --------------------------------------------------
// CREATE / EDIT FORM
// --------------------------------------------------

class _MembershipPlanFormDialog extends StatefulWidget {
  final Map<String, dynamic>? initialPlan;

  const _MembershipPlanFormDialog({required this.initialPlan});

  @override
  State<_MembershipPlanFormDialog> createState() =>
      _MembershipPlanFormDialogState();
}

class _MembershipPlanFormDialogState extends State<_MembershipPlanFormDialog> {
  static const Color _raised = Color(0xFF19221B);
  static const Color _surface = Color(0xFF141B16);
  static const Color _accent = Color(0xFF9BFF35);
  static const Color _muted = Color(0xFF98A49B);
  static const Color _border = Color(0xFF2A382E);

  final _formKey = GlobalKey<FormState>();

  late final TextEditingController _nameController;
  late final TextEditingController _descriptionController;
  late final TextEditingController _tierController;
  late final TextEditingController _durationController;
  late final TextEditingController _priceController;
  late final TextEditingController _currencyController;

  late String _packageType;
  late String _durationUnit;

  bool get _editing => widget.initialPlan != null;

  @override
  void initState() {
    super.initState();

    final plan = widget.initialPlan ?? {};

    _nameController = TextEditingController(
      text: plan['name']?.toString() ?? '',
    );
    _descriptionController = TextEditingController(
      text: plan['description']?.toString() ?? '',
    );
    _tierController = TextEditingController(
      text: plan['tier']?.toString() ?? '',
    );
    _durationController = TextEditingController(
      text: plan['duration_value']?.toString() ?? '1',
    );
    _priceController = TextEditingController(
      text: plan['price']?.toString() ?? '',
    );
    _currencyController = TextEditingController(
      text: plan['currency_code']?.toString() ?? 'LKR',
    );

    _packageType = plan['package_type']?.toString() ?? 'individual';
    _durationUnit = plan['duration_unit']?.toString() ?? 'month';
  }

  @override
  void dispose() {
    _nameController.dispose();
    _descriptionController.dispose();
    _tierController.dispose();
    _durationController.dispose();
    _priceController.dispose();
    _currencyController.dispose();
    super.dispose();
  }

  InputDecoration _decoration(String label, {String? hint}) {
    return InputDecoration(
      labelText: label,
      hintText: hint,
      labelStyle: const TextStyle(color: _muted, fontSize: 12),
      hintStyle: const TextStyle(color: _muted, fontSize: 11),
      filled: true,
      fillColor: _surface,
      contentPadding: const EdgeInsets.symmetric(horizontal: 13, vertical: 13),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(9),
        borderSide: const BorderSide(color: _border),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(9),
        borderSide: const BorderSide(color: _accent),
      ),
      errorBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(9),
        borderSide: const BorderSide(color: Color(0xFFE0A1A1)),
      ),
      focusedErrorBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(9),
        borderSide: const BorderSide(color: Color(0xFFE0A1A1)),
      ),
    );
  }

  Widget _buildField({
    required String label,
    required TextEditingController controller,
    String? hint,
    int maxLines = 1,
    TextInputType? keyboardType,
    List<TextInputFormatter>? inputFormatters,
    String? Function(String?)? validator,
  }) {
    return TextFormField(
      controller: controller,
      maxLines: maxLines,
      keyboardType: keyboardType,
      inputFormatters: inputFormatters,
      validator: validator,
      style: const TextStyle(color: Colors.white, fontSize: 12),
      decoration: _decoration(label, hint: hint),
    );
  }

  Widget _buildDropdown({
    required String label,
    required String value,
    required List<DropdownMenuItem<String>> items,
    required ValueChanged<String?> onChanged,
  }) {
    return DropdownButtonFormField<String>(
      initialValue: value,
      dropdownColor: _raised,
      style: const TextStyle(color: Colors.white, fontSize: 12),
      decoration: _decoration(label),
      items: items,
      onChanged: onChanged,
    );
  }

  void _submit() {
    if (!_formKey.currentState!.validate()) return;

    final duration = int.parse(_durationController.text.trim());
    final price = _priceController.text.trim();
    final currency = _currencyController.text.trim().toUpperCase();

    final data = <String, dynamic>{
      'name': _nameController.text.trim(),
      'description': _descriptionController.text.trim(),
      'package_type': _packageType,
      'tier': _tierController.text.trim().isEmpty
          ? null
          : _tierController.text.trim(),
      'duration_value': duration,
      'duration_unit': _durationUnit,
      'price': price,
      'currency_code': currency,
    };

    // The API automatically applies internal defaults:
    // Individual: one included member, one paying member.
    // Couple: two included members, one paying member.
    Navigator.pop(context, data);
  }

  @override
  Widget build(BuildContext context) {
    return Dialog(
      backgroundColor: _raised,
      insetPadding: const EdgeInsets.all(18),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(15),
        side: const BorderSide(color: _border),
      ),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 640, maxHeight: 760),
        child: Form(
          key: _formKey,
          child: Column(
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(22, 20, 14, 15),
                child: Row(
                  children: [
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            _editing
                                ? 'Edit Membership Plan'
                                : 'Create Membership Plan',
                            style: const TextStyle(
                              color: Colors.white,
                              fontSize: 18,
                              fontWeight: FontWeight.w900,
                            ),
                          ),
                          const SizedBox(height: 5),
                          const Text(
                            'Configure package type, validity and price.',
                            style: TextStyle(color: _muted, fontSize: 10),
                          ),
                        ],
                      ),
                    ),
                    IconButton(
                      onPressed: () => Navigator.pop(context),
                      icon: const Icon(Icons.close, color: _muted),
                    ),
                  ],
                ),
              ),
              const Divider(color: _border, height: 1),
              Expanded(
                child: SingleChildScrollView(
                  padding: const EdgeInsets.all(22),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      _buildField(
                        label: 'Plan name *',
                        controller: _nameController,
                        hint: 'Example: Gold Six Months',
                        validator: (value) {
                          if (value == null || value.trim().isEmpty) {
                            return 'Plan name is required.';
                          }
                          if (value.trim().length > 120) {
                            return 'Maximum 120 characters.';
                          }
                          return null;
                        },
                      ),
                      const SizedBox(height: 15),
                      _buildField(
                        label: 'Description',
                        controller: _descriptionController,
                        hint: 'Describe this membership package',
                        maxLines: 3,
                      ),
                      const SizedBox(height: 15),
                      LayoutBuilder(
                        builder: (context, constraints) {
                          final width = (constraints.maxWidth - 12) / 2;
                          return Wrap(
                            spacing: 12,
                            runSpacing: 14,
                            children: [
                              SizedBox(
                                width: width,
                                child: _buildDropdown(
                                  label: 'Package type',
                                  value: _packageType,
                                  items: const [
                                    DropdownMenuItem(
                                      value: 'individual',
                                      child: Text('Individual'),
                                    ),
                                    DropdownMenuItem(
                                      value: 'couple',
                                      child: Text('Couple'),
                                    ),
                                  ],
                                  onChanged: (value) {
                                    if (value != null) {
                                      setState(() => _packageType = value);
                                    }
                                  },
                                ),
                              ),
                              SizedBox(
                                width: width,
                                child: _buildField(
                                  label: 'Tier / category',
                                  controller: _tierController,
                                  hint: 'Gold, Silver, Platinum',
                                ),
                              ),
                            ],
                          );
                        },
                      ),
                      const SizedBox(height: 15),
                      const Text(
                        'MEMBERSHIP VALIDITY',
                        style: TextStyle(
                          color: _accent,
                          fontSize: 10,
                          fontWeight: FontWeight.w900,
                          letterSpacing: 0.8,
                        ),
                      ),
                      const SizedBox(height: 10),
                      LayoutBuilder(
                        builder: (context, constraints) {
                          final width = (constraints.maxWidth - 12) / 2;
                          return Wrap(
                            spacing: 12,
                            runSpacing: 14,
                            children: [
                              SizedBox(
                                width: width,
                                child: _buildField(
                                  label: 'Duration *',
                                  controller: _durationController,
                                  hint: 'Example: 6',
                                  keyboardType: TextInputType.number,
                                  inputFormatters: [
                                    FilteringTextInputFormatter.digitsOnly,
                                  ],
                                  validator: (value) {
                                    final number = int.tryParse(value ?? '');
                                    if (number == null ||
                                        number < 1 ||
                                        number > 65535) {
                                      return 'Enter a positive whole number.';
                                    }
                                    return null;
                                  },
                                ),
                              ),
                              SizedBox(
                                width: width,
                                child: _buildDropdown(
                                  label: 'Duration unit *',
                                  value: _durationUnit,
                                  items: const [
                                    DropdownMenuItem(
                                      value: 'day',
                                      child: Text('Days'),
                                    ),
                                    DropdownMenuItem(
                                      value: 'week',
                                      child: Text('Weeks'),
                                    ),
                                    DropdownMenuItem(
                                      value: 'month',
                                      child: Text('Months'),
                                    ),
                                    DropdownMenuItem(
                                      value: 'year',
                                      child: Text('Years'),
                                    ),
                                  ],
                                  onChanged: (value) {
                                    if (value != null) {
                                      setState(() => _durationUnit = value);
                                    }
                                  },
                                ),
                              ),
                            ],
                          );
                        },
                      ),
                      const SizedBox(height: 15),
                      const Text(
                        'PACKAGE PRICE',
                        style: TextStyle(
                          color: _accent,
                          fontSize: 10,
                          fontWeight: FontWeight.w900,
                          letterSpacing: 0.8,
                        ),
                      ),
                      const SizedBox(height: 10),
                      LayoutBuilder(
                        builder: (context, constraints) {
                          final priceWidth = constraints.maxWidth * 0.66;
                          final currencyWidth =
                              constraints.maxWidth - priceWidth - 12;
                          return Wrap(
                            spacing: 12,
                            runSpacing: 14,
                            children: [
                              SizedBox(
                                width: priceWidth,
                                child: _buildField(
                                  label: 'Total package price *',
                                  controller: _priceController,
                                  hint: '5000.00',
                                  keyboardType:
                                      const TextInputType.numberWithOptions(
                                        decimal: true,
                                      ),
                                  inputFormatters: [
                                    FilteringTextInputFormatter.allow(
                                      RegExp(r'^\d{0,10}(\.\d{0,2})?$'),
                                    ),
                                  ],
                                  validator: (value) {
                                    final number = double.tryParse(value ?? '');
                                    if (number == null || number < 0) {
                                      return 'Enter a valid price.';
                                    }
                                    if (!RegExp(r'^\d{1,10}(\.\d{1,2})?$')
                                        .hasMatch(value!.trim())) {
                                      return 'Use up to 2 decimal places.';
                                    }
                                    return null;
                                  },
                                ),
                              ),
                              SizedBox(
                                width: currencyWidth,
                                child: _buildField(
                                  label: 'Currency *',
                                  controller: _currencyController,
                                  hint: 'LKR',
                                  inputFormatters: [
                                    FilteringTextInputFormatter.allow(
                                      RegExp(r'[a-zA-Z]'),
                                    ),
                                    LengthLimitingTextInputFormatter(3),
                                  ],
                                  validator: (value) {
                                    if (value == null ||
                                        !RegExp(r'^[A-Za-z]{3}$')
                                            .hasMatch(value.trim())) {
                                      return 'Use 3 letters.';
                                    }
                                    return null;
                                  },
                                ),
                              ),
                            ],
                          );
                        },
                      ),
                      const SizedBox(height: 18),
                      Container(
                        width: double.infinity,
                        padding: const EdgeInsets.all(13),
                        decoration: BoxDecoration(
                          color: _surface,
                          borderRadius: BorderRadius.circular(9),
                          border: Border.all(color: _border),
                        ),
                        child: Text(
                          _packageType == 'couple'
                              ? 'Couple package: the package covers two member profiles and one package payment. The API applies this automatically.'
                              : 'Individual package: one member profile is covered by one package payment.',
                          style: const TextStyle(
                            color: _muted,
                            fontSize: 10,
                            height: 1.5,
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
              const Divider(color: _border, height: 1),
              Padding(
                padding: const EdgeInsets.all(16),
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.end,
                  children: [
                    TextButton(
                      onPressed: () => Navigator.pop(context),
                      child: const Text(
                        'CANCEL',
                        style: TextStyle(color: _muted),
                      ),
                    ),
                    const SizedBox(width: 10),
                    FilledButton.icon(
                      onPressed: _submit,
                      style: FilledButton.styleFrom(
                        backgroundColor: _accent,
                        foregroundColor: const Color(0xFF080D0A),
                      ),
                      icon: Icon(_editing ? Icons.save_outlined : Icons.add),
                      label: Text(_editing ? 'SAVE CHANGES' : 'CREATE PLAN'),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
