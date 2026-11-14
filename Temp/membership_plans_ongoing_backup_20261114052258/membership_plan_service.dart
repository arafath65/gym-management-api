import 'package:gym_management_app/core/services/gym_api_client.dart';

class MembershipPlanService {
  final GymApiClient _client;

  MembershipPlanService({GymApiClient? client})
    : _client = client ?? GymApiClient();

  Future<Map<String, dynamic>> listPlans({
    int page = 1,
    int pageSize = 12,
    String? search,
    String? status,
    String? packageType,
    String? durationUnit,
  }) {
    final query = <String, dynamic>{'page': page, 'page_size': pageSize};

    if (search != null && search.trim().isNotEmpty) {
      query['search'] = search.trim();
    }
    if (status != null && status != 'all') {
      query['status'] = status;
    }
    if (packageType != null && packageType != 'all') {
      query['package_type'] = packageType;
    }
    if (durationUnit != null && durationUnit != 'all') {
      query['duration_unit'] = durationUnit;
    }

    return _client.get('membership-plans', queryParameters: query);
  }

  Future<Map<String, dynamic>> getPlan(int planId) {
    return _client.get('membership-plans/$planId');
  }

  Future<Map<String, dynamic>> createPlan(Map<String, dynamic> data) {
    return _client.post('membership-plans', data: data);
  }

  Future<Map<String, dynamic>> updatePlan(
    int planId,
    Map<String, dynamic> data,
  ) {
    return _client.patch('membership-plans/$planId', data: data);
  }

  Future<Map<String, dynamic>> deactivatePlan(int planId) {
    return _client.post('membership-plans/$planId/deactivate');
  }

  Future<Map<String, dynamic>> reactivatePlan(int planId) {
    return _client.post('membership-plans/$planId/reactivate');
  }
}
